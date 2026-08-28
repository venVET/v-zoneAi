const fs = require('fs');
// V-TRADE AI — FULL MTF SIGNAL DISPLAY (M1/M5/M15/H1)
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const storage = require('./storage');

const app = express();
// V TRADE AI — Pre-Market + 60m Macro/Truth Social engine
try { require('./pre-market-news-engine')(app); } catch (e) { console.error('[PRE-MARKET] install failed:', e.message); }

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';

// Telegram is user-configurable. Tokens are never sent to the browser and are kept
// only in server memory for the active session. Optional env credentials remain
// supported for owner/admin fallback deployments.
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_AUTO_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
// Optional OpenAI AI-confirmation layer. The key stays server-side and is never sent to the browser.
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-5.6-luna').trim();
const OPENAI_ENABLED = String(process.env.OPENAI_ENABLED || 'false').toLowerCase() === 'true';
const OPENAI_TIMEOUT_MS = Math.max(2500, Number(process.env.OPENAI_TIMEOUT_MS || 9000));
const OPENAI_MIN_SCORE = Math.max(0, Math.min(100, Number(process.env.OPENAI_MIN_SCORE || 76)));
const MT5_BRIDGE_API_KEY = process.env.MT5_BRIDGE_API_KEY || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const REQUIRE_WEBHOOK_SECRET = String(process.env.REQUIRE_WEBHOOK_SECRET || (process.env.RENDER ? 'true' : 'false')).toLowerCase() === 'true';
const TELEGRAM_SESSION_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.TELEGRAM_SESSION_TTL_MS || 24 * 60 * 60 * 1000));
// Broker-native MT5 feed freshness.
// 15s is the normal execution freshness; 60s is only the connection/watchdog window.
// Never use a stale quote to promote a trade signal.
const MT5_MAX_AGE_MS = Math.max(5000, Number(process.env.MT5_MAX_AGE_MS || 15000));
const MT5_CONNECTED_MAX_AGE_MS = Math.max(MT5_MAX_AGE_MS, Number(process.env.MT5_CONNECTED_MAX_AGE_MS || 60000));
// MT5 Auto-Trade safety/execution policy.
// The actual order is placed by the MT5 Expert Advisor on the user's Windows/MT5 terminal.
// Render/server never receives the broker password and never places a broker order itself.
const AUTO_TRADE_ENABLED = String(process.env.AUTO_TRADE_ENABLED || 'false').toLowerCase() === 'true';
const AUTO_TRADE_MIN_SCORE = Math.max(0, Math.min(100, Number(process.env.AUTO_TRADE_MIN_SCORE || 76)));
const AUTO_TRADE_LOT = Math.max(0.01, Number(process.env.AUTO_TRADE_LOT || 0.01));
const AUTO_TRADE_MAX_LOT = Math.max(AUTO_TRADE_LOT, Number(process.env.AUTO_TRADE_MAX_LOT || 0.02));
const AUTO_TRADE_COOLDOWN_MS = Math.max(10_000, Number(process.env.AUTO_TRADE_COOLDOWN_MS || 5 * 60 * 1000));
const AUTO_TRADE_MAX_OPEN = Math.max(1, Number(process.env.AUTO_TRADE_MAX_OPEN || 1));
const AUTO_TRADE_MAGIC = Number(process.env.AUTO_TRADE_MAGIC || 572007);
const AUTO_TRADE_TRAIL_TRIGGER = Math.max(0.01, Number(process.env.AUTO_TRADE_TRAIL_TRIGGER || 2.00));
const AUTO_TRADE_TRAIL_DISTANCE_POINTS = Math.max(1, Number(process.env.AUTO_TRADE_TRAIL_DISTANCE_POINTS || 100));
const AUTO_TRADE_LOCK_PROFIT = Math.max(0, Number(process.env.AUTO_TRADE_LOCK_PROFIT || 0.50));
const AUTO_TRADE_SIGNAL_TTL_MS = Math.max(2_000, Number(process.env.AUTO_TRADE_SIGNAL_TTL_MS || 15_000));
const AUTO_TRADE_REQUIRE_MARKET = String(process.env.AUTO_TRADE_REQUIRE_MARKET || 'true').toLowerCase() === 'true';
const autoTradeState = {
  lastSignalKey: '',
  lastSignalAt: 0,
  openPositions: 0,
  lastHeartbeatAt: 0,
  lastExecution: null,
  lastAnalysisAt: 0
};

const APP_VERSION = '7.3.1-FEED-STABLE';
const EX_ZONE_LOW = Number(process.env.EX_ZONE_LOW || NaN);
const EX_ZONE_HIGH = Number(process.env.EX_ZONE_HIGH || NaN);
const ZONE_PROXIMITY_ATR = Math.max(0.25, Number(process.env.ZONE_PROXIMITY_ATR || 1.25));
const ZONE_ALERT_ENABLED = String(process.env.ZONE_ALERT_ENABLED || 'true').toLowerCase() === 'true';
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const AUTH_SESSION_TTL_MS = Math.max(15 * 60 * 1000, Number(process.env.AUTH_SESSION_TTL_MS || 8 * 60 * 60 * 1000));
const ANALYSIS_REQUEST_TIMEOUT_MS = Math.max(1500, Number(process.env.ANALYSIS_REQUEST_TIMEOUT_MS || 7000));
const AUTH_MAX_SESSIONS = Math.max(100, Math.min(10000, Number(process.env.AUTH_MAX_SESSIONS || 2000)));
const AUTH_SESSION_SECRET = String(process.env.AUTH_SESSION_SECRET || '').trim();
const revokedAuthTokens = new Map();
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD_HASH = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const ADMIN_TOTP_SECRET = String(process.env.ADMIN_TOTP_SECRET || '').replace(/\s+/g,'').toUpperCase();
const RESET_WEBHOOK_URL = String(process.env.RESET_WEBHOOK_URL || '').trim();
const RESET_TOKEN_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.RESET_TOKEN_TTL_MS || 15 * 60 * 1000));
const pending2FA = new Map();
const resetTokens = new Map();
const USER_ACCOUNTS = loadUserAccounts();
const authSessions = new Map();
const authPasswordOverrides = new Map();

function loadUserAccounts() {
  try {
    const raw = String(process.env.VTRADE_USERS_JSON || '').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(u => ({
      id: String(u.id || crypto.randomUUID()),
      email: String(u.email || '').trim().toLowerCase(),
      name: String(u.name || u.email || 'User').slice(0, 80),
      role: String(u.role || 'user').toLowerCase() === 'admin' ? 'admin' : 'user',
      plan: String(u.plan || 'Trial').slice(0, 40),
      passwordHash: String(u.passwordHash || '').trim(),
      enabled: u.enabled !== false
    })).filter(u => u.email && u.passwordHash);
  } catch (e) {
    console.error('[AUTH] Invalid VTRADE_USERS_JSON:', e.message);
    return [];
  }
}

function verifyPassword(password, encoded) {
  try {
    const [salt, hash] = String(encoded || '').split(':');
    if (!salt || !hash) return false;
    const derived = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
    return safeEqual(derived, hash);
  } catch (_) { return false; }
}

function base32ToBuffer(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input || '').replace(/=+$/,'').toUpperCase();
  let bits = 0, value = 0, out = [];
  for (const ch of clean) { const idx=alphabet.indexOf(ch); if(idx<0) throw new Error('Invalid TOTP secret'); value=(value<<5)|idx; bits+=5; if(bits>=8){bits-=8;out.push((value>>bits)&255);} }
  return Buffer.from(out);
}
function verifyTotp(code, secret, window=1) {
  const value=String(code||'').replace(/\D/g,''); if(!/^\d{6}$/.test(value)||!secret)return false;
  try { const key=base32ToBuffer(secret), counter=Math.floor(Date.now()/1000/30); for(let off=-window;off<=window;off++){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(counter+off));const d=crypto.createHmac('sha1',key).update(b).digest();const pos=d[d.length-1]&15;const bin=((d[pos]&127)<<24)|(d[pos+1]<<16)|(d[pos+2]<<8)|d[pos+3];if(safeEqual(String(bin%1000000).padStart(6,'0'),value))return true;} } catch(_){} return false;
}
function userTotpSecret(user){return String(user?.totpSecret||'').replace(/\s+/g,'').toUpperCase();}

function verifyAdminPassword(password) {
  const override = authPasswordOverrides.get('owner-admin');
  if (override) return verifyPassword(password, override);
  if (ADMIN_PASSWORD_HASH) return verifyPassword(password, ADMIN_PASSWORD_HASH);
  // Plain ADMIN_PASSWORD is retained only for compatibility; use ADMIN_PASSWORD_HASH in production.
  return !!ADMIN_PASSWORD && safeEqual(password, ADMIN_PASSWORD);
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function passwordPolicy(password) {
  const p = String(password || '');
  return p.length >= 12 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p);
}
function getAccountBySessionUser(user) {
  if (!user) return null;
  if (user.id === 'owner-admin') return { id:'owner-admin', role:'admin', email:ADMIN_EMAIL, name:user.name };
  return USER_ACCOUNTS.find(u => u.enabled && u.id === user.id) || null;
}
function verifyCurrentUserPassword(user, password) {
  if (user?.id === 'owner-admin') return verifyAdminPassword(password);
  const account = getAccountBySessionUser(user);
  if (!account) return false;
  const override = authPasswordOverrides.get(account.id);
  return override ? verifyPassword(password, override) : verifyPassword(password, account.passwordHash);
}
function invalidateUserSessions(userId) {
  for (const [token, session] of authSessions.entries()) {
    if (session.id === userId) authSessions.delete(token);
  }
}

function credentialFingerprint(user) {
  let source = '';
  if (user?.id === 'owner-admin') {
    source = authPasswordOverrides.get('owner-admin') || ADMIN_PASSWORD_HASH || ADMIN_PASSWORD;
  } else {
    const account = getAccountBySessionUser(user);
    source = authPasswordOverrides.get(user?.id) || account?.passwordHash || '';
  }
  return crypto.createHash('sha256').update(String(source)).digest('hex').slice(0, 24);
}

function createStatelessAuthToken(user) {
  if (!AUTH_SESSION_SECRET) throw new Error('AUTH_SESSION_SECRET is not configured');
  const now = Date.now();
  const payload = { v:1, user, iat:now, exp:now + AUTH_SESSION_TTL_MS, pv:credentialFingerprint(user), jti:crypto.randomBytes(12).toString('hex') };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SESSION_SECRET).update(encoded).digest('base64url');
  return `v1.${encoded}.${sig}`;
}

function verifyStatelessAuthToken(token) {
  if (!AUTH_SESSION_SECRET || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  if (revokedAuthTokens.has(token)) return null;
  try {
    const [, encoded, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', AUTH_SESSION_SECRET).update(encoded).digest('base64url');
    if (!safeEqual(sig, expected)) return null;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload?.user || Date.now() >= Number(payload.exp || 0)) return null;
    if (credentialFingerprint(payload.user) !== String(payload.pv || '')) return null;
    return { ...payload.user, createdAt:Number(payload.iat||Date.now()), expiresAt:Number(payload.exp), lastSeenAt:Date.now(), stateless:true };
  } catch (_) { return null; }
}

function createAuthSession(user) {
  const token = createStatelessAuthToken(user);
  const session = { ...user, createdAt: Date.now(), expiresAt: Date.now() + AUTH_SESSION_TTL_MS, lastSeenAt: Date.now() };
  if (authSessions.size >= AUTH_MAX_SESSIONS) {
    const oldest = authSessions.keys().next().value;
    if (oldest) authSessions.delete(oldest);
  }
  authSessions.set(token, session);
  return token;
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  const out = Object.create(null);
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { out[key] = part.slice(i + 1).trim(); }
  }
  return out;
}

function authTokenFrom(req) {
  const headerToken = String(req.get('x-vtrade-auth') || '').trim();
  if (/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(headerToken) || /^[a-f0-9]{64}$/i.test(headerToken)) return headerToken;
  const cookieToken = String(parseCookies(req).vtrade_session || '').trim();
  return (/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cookieToken) || /^[a-f0-9]{64}$/i.test(cookieToken)) ? cookieToken : null;
}

function setAuthCookie(res, token) {
  const maxAge = Math.floor(AUTH_SESSION_TTL_MS / 1000);
  const sameSite = process.env.RENDER ? 'None' : 'Lax';
  const secure = process.env.RENDER ? '; Secure' : '';
  res.setHeader('Set-Cookie', `vtrade_session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=${sameSite}${secure}`);
}

function clearAuthCookie(res) {
  const sameSite = process.env.RENDER ? 'None' : 'Lax';
  const secure = process.env.RENDER ? '; Secure' : '';
  res.setHeader('Set-Cookie', `vtrade_session=; Path=/; Max-Age=0; HttpOnly; SameSite=${sameSite}${secure}`);
}

function getAuthSession(req) {
  const token = authTokenFrom(req);
  if (!token) return null;
  if (revokedAuthTokens.has(token)) return null;
  const session = authSessions.get(token);
  if (session && Date.now() < session.expiresAt) { session.lastSeenAt = Date.now(); return session; }
  if (session) authSessions.delete(token);
  return verifyStatelessAuthToken(token);
}

function requireAuth(req, res, next) {
  const session = getAuthSession(req);
  if (!session) return res.status(401).json({ success:false, error:'Authentication required' });
  req.vtradeUser = session;
  next();
}

function requireRole(role) {
  return (req,res,next) => {
    if (!req.vtradeUser || req.vtradeUser.role !== role) return res.status(403).json({ success:false, error:'Forbidden' });
    next();
  };
}

function planEntitlements(plan) {
  const p=String(plan||'').trim().toLowerCase();
  if (p==='admin') return ['*'];
  if (p.includes('premium')) return ['terminal','signals','ai','news','telegram','risk','history','profile:own'];
  if (p.includes('vip') || p.includes('pro')) return ['terminal','signals','ai','news','telegram','risk','history','profile:own'];
  if (p.includes('standard')) return ['terminal','signals','ai','news','risk','history','profile:own'];
  if (p.includes('basic')) return ['terminal','signals','risk','history','profile:own'];
  if (p.includes('trial') || p==='free' || !p) return ['terminal','signals','ai','profile:own'];
  return ['profile:own'];
}
function requirePermission(permission) {
  return (req,res,next) => {
    const permissions=Array.isArray(req.vtradeUser?.permissions)?req.vtradeUser.permissions:[];
    if (permissions.includes('*') || permissions.includes(permission)) return next();
    return res.status(403).json({success:false,error:'This feature is not included in your current package'});
  };
}

const pricingPlans = (() => {
  try {
    const parsed = JSON.parse(String(process.env.VTRADE_PRICING_JSON || ''));
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch (_) {}
  return [
    {id:'trial', name:'Free 7-Day Trial', price:0, period:'7 days', enabled:true, features:['AI Research','Basic MTF','Demo Telegram']},
    {id:'basic', name:'Basic', price:4.99, period:'month', enabled:true, features:['MTF ICT','Risk Calculator','Standard Alerts']},
    {id:'standard', name:'Standard', price:8.99, period:'month', enabled:true, features:['Advanced MTF','News Filter','Telegram Entry Alerts']},
    {id:'vip-pro', name:'VIP Pro', price:29, period:'month', enabled:true, features:['Full MTF','Multi-Horizon','Priority AI','Advanced Telegram Alerts']}
  ];
})();

function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/$/, '').toLowerCase();
}
const ALLOWED_ORIGINS = [...new Set([
  ...((process.env.ALLOWED_ORIGINS || '').split(',').map(normalizeOrigin).filter(Boolean)),
  normalizeOrigin(APP_BASE_URL),
  'https://vetven964.github.io'
].filter(Boolean))];

const corsOptions = {
  origin(origin, cb) {
    const normalized = normalizeOrigin(origin);
    // Non-browser requests (curl/health checks/server-to-server) have no Origin.
    if (!normalized) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(normalized)) return cb(null, true);
    return cb(new Error('CORS origin not allowed'));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','x-vtrade-session','x-vtrade-key','x-vtrade-admin-key','x-vtrade-auth','x-vtrade-request'],
  credentials: true,
  optionsSuccessStatus: 204,
  maxAge: 600
};

const bot = TELEGRAM_TOKEN
  ? new TelegramBot(TELEGRAM_TOKEN, { polling: process.env.RENDER ? false : true })
  : null;

// Owner/admin automatic Telegram alerts. Render does not need browser polling:
// the server scans the confirmed XAUUSD engine and sends deduplicated alerts itself.
const TELEGRAM_AUTO_ALERT_ENABLED = String(process.env.TELEGRAM_AUTO_ALERT_ENABLED || 'true').toLowerCase() === 'true';
const TELEGRAM_AUTO_ALERT_INTERVAL_MS = Math.max(5000, Number(process.env.TELEGRAM_AUTO_ALERT_INTERVAL_MS || 60000));
let telegramAutoAlertRunning = false;

// Per-user Telegram connections. The bot token is server-side only.
// Render restarts clear this in-memory map; users can reconnect from Telegram Setup.
const telegramSessions = new Map();
const telegramAlertKeys = new Map();
const telegramNewsKeys = new Map();
const telegramZoneKeys = new Map();
const MAX_TELEGRAM_SESSIONS = 1000;

function sessionIdFrom(req) {
  const id = String(req.get('x-vtrade-session') || '').trim();
  return /^[a-f0-9]{48,96}$/i.test(id) ? id : null;
}

function createSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function getSessionConfig(req) {
  const sid = sessionIdFrom(req);
  if (!sid) return null;
  const session = telegramSessions.get(sid) || null;
  if (!session) return null;
  if (!session.expiresAt || Date.now() >= session.expiresAt) {
    telegramSessions.delete(sid);
    telegramAlertKeys.delete(sid);
    telegramNewsKeys.delete(sid);
    telegramZoneKeys.delete(sid);
    return null;
  }
  return session;
}

function setSessionConfig(sid, config) {
  if (telegramSessions.size >= MAX_TELEGRAM_SESSIONS && !telegramSessions.has(sid)) {
    const oldest = telegramSessions.keys().next().value;
    if (oldest) {
      telegramSessions.delete(oldest);
      telegramAlertKeys.delete(oldest);
      telegramNewsKeys.delete(oldest);
    }
  }
  telegramSessions.set(sid, config);
}

function maskChatId(chatId) {
  const s = String(chatId || '');
  return s.length <= 4 ? '••••' : `${s.slice(0, 2)}••••${s.slice(-2)}`;
}

function activeTelegramConfig(req) {
  const session = getSessionConfig(req);
  if (session) return session;
  if (bot && TELEGRAM_CHAT_ID) {
    return { bot, chatId: TELEGRAM_CHAT_ID, botUsername: 'ENV_CONFIGURED', session: false };
  }
  return null;
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
if (process.env.RENDER && !ALLOWED_ORIGINS.length) {
  throw new Error('ALLOWED_ORIGINS must be configured in production');
}
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
app.use('/api/', (req,res,next)=>{ const timer=setTimeout(()=>{ if(!res.headersSent) res.status(504).json({success:false,error:'API request timed out'}); }, ANALYSIS_REQUEST_TIMEOUT_MS); res.on('finish',()=>clearTimeout(timer)); res.on('close',()=>clearTimeout(timer)); next(); });
const telegramMutationLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false, message: { success:false, error:'Too many Telegram operations. Try again later.' } });
const adminOnlyLimit = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
function safeEqual(a,b) {
  const aa=Buffer.from(String(a||'')); const bb=Buffer.from(String(b||''));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}
function requireAdmin(req,res,next) {
  if (!ADMIN_API_KEY) return res.status(503).json({success:false,error:'Admin API is not configured'});
  if (!safeEqual(req.get('x-vtrade-admin-key'), ADMIN_API_KEY)) return res.status(401).json({success:false,error:'Unauthorized'});
  next();
}


// Lightweight public diagnostic used by the GitHub Pages login screen.
// It never exposes credentials, hashes, or secrets.
app.get('/api/auth/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    auth: 'online',
    version: APP_VERSION,
    adminConfigured: !!ADMIN_EMAIL && !!(ADMIN_PASSWORD_HASH || ADMIN_PASSWORD || authPasswordOverrides.has('owner-admin')),
    twoFactorConfigured: !!ADMIN_TOTP_SECRET
  });
});

// Authentication / RBAC. Frontend visibility is only UX; every protected action is enforced here.
app.post('/api/auth/login', rateLimit({ windowMs: 10 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false }), (req,res) => {
  const email=String(req.body?.email||'').trim().toLowerCase(), password=String(req.body?.password||'');
  if(!email||!password)return res.status(400).json({success:false,error:'Email and password are required'});
  let user=null, secret='';
  if(ADMIN_EMAIL&&email===ADMIN_EMAIL&&verifyAdminPassword(password)){user={id:'owner-admin',email:ADMIN_EMAIL,name:'VET VEN',role:'admin',plan:'Admin',permissions:['*'],twoFactorEnabled:!!ADMIN_TOTP_SECRET};secret=ADMIN_TOTP_SECRET;}
  else {const found=USER_ACCOUNTS.find(u=>{if(!u.enabled||u.email!==email)return false;const override=authPasswordOverrides.get(u.id);return override?verifyPassword(password,override):verifyPassword(password,u.passwordHash);});if(found){user={id:found.id,email:found.email,name:found.name,role:found.role,plan:found.plan,permissions:found.role==='admin'?['*']:planEntitlements(found.plan),twoFactorEnabled:!!userTotpSecret(found)};secret=userTotpSecret(found);}}
  if(!user)return res.status(401).json({success:false,error:'Invalid credentials'});
  if(secret){const challenge=crypto.randomBytes(32).toString('hex');pending2FA.set(challenge,{user,secret,expiresAt:Date.now()+300000,attempts:0});return res.json({success:true,requires2FA:true,challenge,expiresAt:Date.now()+300000,user:{id:user.id,email:user.email,name:user.name,role:user.role,plan:user.plan}});}
  const token=createAuthSession(user); setAuthCookie(res, token); res.set('Cache-Control','no-store'); res.json({success:true,token,expiresAt:Date.now()+AUTH_SESSION_TTL_MS,user});
});

app.post('/api/auth/2fa/verify', rateLimit({windowMs:10*60_000,max:30,standardHeaders:true,legacyHeaders:false}), (req,res)=>{
 const challenge=String(req.body?.challenge||''),code=String(req.body?.code||''),p=pending2FA.get(challenge);
 if(!p||Date.now()>=p.expiresAt){pending2FA.delete(challenge);return res.status(401).json({success:false,error:'2FA challenge expired. Please sign in again.'});}
 p.attempts++; if(p.attempts>5){pending2FA.delete(challenge);return res.status(429).json({success:false,error:'Too many 2FA attempts. Please sign in again.'});}
 if(!verifyTotp(code,p.secret))return res.status(401).json({success:false,error:'Invalid verification code'});
 pending2FA.delete(challenge); const token=createAuthSession(p.user); setAuthCookie(res, token); res.set('Cache-Control','no-store'); res.json({success:true,token,expiresAt:Date.now()+AUTH_SESSION_TTL_MS,user:p.user});
});

app.post('/api/auth/change-password', rateLimit({windowMs:15*60_000,max:8,standardHeaders:true,legacyHeaders:false}), requireAuth, async (req,res)=>{
  const currentPassword=String(req.body?.currentPassword||'');
  const newPassword=String(req.body?.newPassword||'');
  const confirmPassword=String(req.body?.confirmPassword||'');
  if(!currentPassword || !newPassword || !confirmPassword) return res.status(400).json({success:false,error:'Current password, new password and confirmation are required'});
  if(newPassword !== confirmPassword) return res.status(400).json({success:false,error:'New password and confirmation do not match'});
  if(currentPassword === newPassword) return res.status(400).json({success:false,error:'New password must be different from the current password'});
  if(!passwordPolicy(newPassword)) return res.status(400).json({success:false,error:'New password must be at least 12 characters and include uppercase, lowercase, number and symbol'});
  if(!verifyCurrentUserPassword(req.vtradeUser,currentPassword)) return res.status(401).json({success:false,error:'Current password is incorrect'});
  const hash=hashPassword(newPassword);
  const accountId=req.vtradeUser.id==='owner-admin' ? 'owner-admin' : req.vtradeUser.id;
  if(req.vtradeUser.id!=='owner-admin' && !getAccountBySessionUser(req.vtradeUser)) return res.status(404).json({success:false,error:'Account not found'});
  try {
    await storage.saveAuthCredential(accountId,hash);
  } catch (e) {
    console.error('[AUTH] Password persistence failed:', e.message);
    return res.status(503).json({success:false,error:'Password could not be saved securely. Please try again.'});
  }
  authPasswordOverrides.set(accountId,hash);
  if(req.vtradeUser.id!=='owner-admin'){
    const account=getAccountBySessionUser(req.vtradeUser);
    if(account) account.passwordHash=hash;
  }
  invalidateUserSessions(req.vtradeUser.id);
  clearAuthCookie(res);
  res.set('Cache-Control','no-store');
  res.json({success:true,message:'Password changed successfully. Please sign in again.',reauthenticate:true});
});

app.post('/api/auth/forgot-password', rateLimit({windowMs:15*60_000,max:5,standardHeaders:true,legacyHeaders:false}), async (req,res)=>{
 const email=String(req.body?.email||'').trim().toLowerCase(); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({success:false,error:'Enter a valid email address'});
 if(!RESET_WEBHOOK_URL)return res.status(503).json({success:false,error:'Password recovery email service is not configured yet'});
 let account=null;if(ADMIN_EMAIL&&email===ADMIN_EMAIL)account={id:'owner-admin',email,role:'admin'};else{const u=USER_ACCOUNTS.find(x=>x.enabled&&x.email===email);if(u)account={id:u.id,email:u.email,role:u.role};}
 if(account){const token=crypto.randomBytes(32).toString('hex');resetTokens.set(token,{...account,expiresAt:Date.now()+RESET_TOKEN_TTL_MS,used:false});try{await fetch(RESET_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:'password_reset',email,resetUrl:`${APP_BASE_URL||''}/reset-password.html?token=${token}`,expiresAt:Date.now()+RESET_TOKEN_TTL_MS})});}catch(_){} }
 res.status(202).json({success:true,message:'If the account exists, a reset link will be sent shortly.'});
});

app.get('/api/auth/session', requireAuth, (req,res) => {
  res.set('Cache-Control','no-store');
  res.json({success:true,user:req.vtradeUser,expiresAt:req.vtradeUser.expiresAt});
});

app.get('/api/auth/profile', requireAuth, (req,res)=>{
  res.set('Cache-Control','no-store');
  res.json({success:true,user:{id:req.vtradeUser.id,email:req.vtradeUser.email,name:req.vtradeUser.name,role:req.vtradeUser.role,plan:req.vtradeUser.plan,twoFactorEnabled:!!req.vtradeUser.twoFactorEnabled}});
});

app.post('/api/auth/logout', requireAuth, (req,res) => {
  const token = authTokenFrom(req);
  if (token) {
    const session = authSessions.get(token);
    authSessions.delete(token);
    const expiresAt = Number(session?.expiresAt || (Date.now() + AUTH_SESSION_TTL_MS));
    revokedAuthTokens.set(token, expiresAt);
  }
  clearAuthCookie(res);
  res.set('Cache-Control','no-store');
  res.json({success:true});
});

app.get('/api/pricing', (req,res) => {
  res.set('Cache-Control','no-store');
  res.json({success:true, role:req.vtradeUser.role, currentPlan:req.vtradeUser.plan, plans:pricingPlans});
});

app.post('/api/admin/broadcast', requireAuth, requireRole('admin'), telegramMutationLimit, async (req,res) => {
  try {
    const tg = activeTelegramConfig(req);
    if (!tg) return res.status(400).json({success:false,error:'Telegram is not connected'});
    const a = await buildXauAnalysis();
    if (!['BUY','SELL'].includes(a.signal) || !String(a.status || '').includes('ENTRY CONFIRMED') || Number(a.confidence||0) < Number(process.env.TELEGRAM_MIN_SCORE || 80)) {
      return res.status(409).json({success:false,error:'No confirmed high-confidence entry. Admin broadcast blocked.',analysis:a});
    }
    await tg.bot.sendMessage(tg.chatId, telegramText(a));
    return res.json({success:true,analysis:a});
  } catch(e) { return res.status(500).json({success:false,error:'Admin broadcast failed'}); }
});

app.get('/api/admin/session', requireAuth, requireRole('admin'), (req,res) => {
  res.set('Cache-Control','no-store');
  const sessions=[...authSessions.entries()].map(([token,s]) => ({
    sessionId: token.slice(0,16), id:s.id, email:s.email, name:s.name, role:s.role, plan:s.plan,
    createdAt:s.createdAt, lastSeenAt:s.lastSeenAt, expiresAt:s.expiresAt, active:Date.now()<s.expiresAt
  })).filter(s=>s.active);
  res.json({success:true,admin:req.vtradeUser,sessions,sessionCount:sessions.length,capabilities:['users:read','users:manage','pricing:manage','security:audit','telegram:admin','system:read']});
});

app.post('/api/admin/session/:sessionId/logout', requireAuth, requireRole('admin'), (req,res) => {
  const prefix=String(req.params.sessionId||'').trim();
  if(!/^[a-f0-9]{16}$/i.test(prefix)) return res.status(400).json({success:false,error:'Invalid session id'});
  const matches=[...authSessions.keys()].filter(t=>t.startsWith(prefix));
  if(matches.length!==1) return res.status(matches.length?409:404).json({success:false,error:matches.length?'Session id is ambiguous':'Session not found'});
  const token=matches[0];
  const session=authSessions.get(token);
  if(session?.id==='owner-admin') return res.status(400).json({success:false,error:'The primary admin session cannot be remotely logged out here'});
  authSessions.delete(token);
  revokedAuthTokens.set(token, Number(session?.expiresAt || Date.now()+AUTH_SESSION_TTL_MS));
  storage.saveEvent?.('admin_session_logout', null, {admin:req.vtradeUser.email, user:session?.email || session?.id}).catch(()=>{});
  res.json({success:true});
});

app.get('/api/admin/users', requireAuth, requireRole('admin'), (req,res) => {
  res.set('Cache-Control','no-store');
  const users=[{id:'owner-admin',email:ADMIN_EMAIL || 'configured-admin',name:'VET VEN',role:'admin',plan:'Admin',enabled:true}].concat(USER_ACCOUNTS.map(u=>({id:u.id,email:u.email,name:u.name,role:u.role,plan:u.plan,enabled:u.enabled})));
  res.json({success:true,users});
});

app.post('/api/admin/pricing', requireAuth, requireRole('admin'), (req,res) => {
  const plans=Array.isArray(req.body?.plans) ? req.body.plans : null;
  if (!plans || plans.length < 1 || plans.length > 12) return res.status(400).json({success:false,error:'Invalid pricing plans'});
  for (const p of plans) {
    if (!/^[a-z0-9-]{2,40}$/i.test(String(p.id||'')) || !String(p.name||'').trim() || !Number.isFinite(Number(p.price)) || Number(p.price)<0) return res.status(400).json({success:false,error:'Invalid pricing plan fields'});
  }
  pricingPlans.splice(0, pricingPlans.length, ...plans.map(p=>({id:String(p.id),name:String(p.name).slice(0,80),price:Number(p.price),period:String(p.period||'month').slice(0,30),enabled:p.enabled!==false,features:Array.isArray(p.features)?p.features.slice(0,20).map(x=>String(x).slice(0,100)):[]})));
  storage.saveEvent?.('pricing_update', null, {admin:req.vtradeUser.email,plans:pricingPlans}).catch(()=>{});
  res.json({success:true,plans:pricingPlans});
});

app.use(express.static(path.join(__dirname)));

// Canonical UI entrypoint: serve the premium dashboard at the root URL.
// Keep /v-zone-ai/ as a backwards-compatible alias.
app.get('/', (_req,res)=>res.sendFile(path.join(__dirname,'premium-dashboard-live.html')));

// V-ZONE AI CLEAN ROUTES — single canonical MT5/Telegram bridge.
app.get('/v-zone-ai/', (_req,res)=>res.sendFile(path.join(__dirname,'premium-dashboard-live.html')));
app.get('/api/pre-market/mt5-authoritative', async (_req,res)=>{
  res.set('Cache-Control','no-store');
  try { const a=await buildXauAnalysis(); return res.json({success:true, ...a, source:'MT5_AUTHORITATIVE_CLEAN'}); }
  catch(e){ return res.status(503).json({success:false,error:String(e?.message||e),source:'MT5_AUTHORITATIVE_CLEAN'}); }
});
app.get('/api/telegram/market-snapshot', async (_req,res)=>{
  res.set('Cache-Control','no-store');
  try { const a=await buildXauAnalysis(); return res.json({success:true, ...a, source:'TELEGRAM_MARKET_BRIDGE'}); }
  catch(e){ return res.status(503).json({success:false,error:String(e?.message||e)}); }
});


const cache = new Map();
const brokerFeed = {
  quote: null,
  timeframes: null,
  receivedAt: 0,
  symbol: null,
  sequence: 0,
  lastRequestAt: 0,
  lastServerTime: 0,
  lastError: null
};
const newsCache = { at: 0, data: null };
const analysisCache = { key: '', at: 0, data: null };
const ANALYSIS_CACHE_MS = Math.max(250, Number(process.env.ANALYSIS_CACHE_MS || 750));
const bridgeNews = { items: null, receivedAt: 0, source: null };
const newsHealth = { lastAttemptAt: 0, lastSuccessAt: 0, lastSource: null, lastError: null, attempts: 0, successes: 0, rateLimitedUntil: 0 };
const NEWS_CACHE_MS = Math.max(5000, Number(process.env.NEWS_CACHE_MS || 15000));
const NEWS_ERROR_RETRY_MS = Number(process.env.NEWS_ERROR_RETRY_MS || 120000);
const NEWS_429_RETRY_MS = Number(process.env.NEWS_429_RETRY_MS || 10 * 60 * 1000);
const NEWS_STALE_MAX_MS = Number(process.env.NEWS_STALE_MAX_MS || 30 * 60 * 1000);
const NEWS_MAX_SOURCES = Math.max(1, Math.min(6, Number(process.env.NEWS_MAX_SOURCES || 4)));
const AI_DATA_QUALITY_MIN = Math.max(60, Math.min(100, Number(process.env.AI_DATA_QUALITY_MIN || 75)));
const NEWS_URLS = String(process.env.NEWS_CALENDAR_URLS || process.env.NEWS_CALENDAR_URL || 'https://nfs.faireconomy.media/ff_calendar_thisweek.json')
  .split(',').map(x => x.trim()).filter(Boolean);
const NEWS_BRIDGE_MAX_AGE_MS = Number(process.env.NEWS_BRIDGE_MAX_AGE_MS || 10 * 60 * 1000);
const NEWS_PRELOCK_MIN = Number(process.env.NEWS_PRELOCK_MIN || 15);
const NEWS_CAUTION_MIN = Number(process.env.NEWS_CAUTION_MIN || 60);
const NEWS_LIVE_WINDOW_MIN = Number(process.env.NEWS_LIVE_WINDOW_MIN || 2);
const NEWS_POST_MIN = Number(process.env.NEWS_POST_MIN || 15);
const TELEGRAM_NEWS_ALERTS = String(process.env.TELEGRAM_NEWS_ALERTS || 'true').toLowerCase() === 'true';
const MIN_CONFLUENCE = Math.max(65, Math.min(95, Number(process.env.MIN_CONFLUENCE || 76)));
const MAX_ENTRY_SPREAD = Number(process.env.MAX_ENTRY_SPREAD || 1.50);
const CORE_MTF_TFS = ['H4','H1','M15'];
const FULL_MTF_TFS = ['D1','H4','H1','M15','M5','M1'];
const MIN_MTF_ALIGNMENT = Math.max(2, Math.min(3, Number(process.env.MIN_MTF_ALIGNMENT || 2)));
const MIN_ENTRY_SCORE = Math.max(65, Math.min(95, Number(process.env.MIN_ENTRY_SCORE || MIN_CONFLUENCE)));
const NEWS_FAIL_CLOSED = String(process.env.NEWS_FAIL_CLOSED || 'false').toLowerCase() === 'true';
const AI_ENGINE_VERSION = 'advanced-mtf-ict-v7.2.4-direction-score-engine';
const AI_MIN_BARS = Number(process.env.AI_MIN_BARS || 50);
const AI_RSI_PERIOD = Number(process.env.AI_RSI_PERIOD || 14);
const AI_ADX_PERIOD = Number(process.env.AI_ADX_PERIOD || 14);
const AI_FAST_SCAN_MS = Math.max(1000, Number(process.env.AI_FAST_SCAN_MS || 3000));


function newsStateLabel(state) {
  return state === 'LIVE' ? 'NEWS LIVE' : state === 'LOCK' ? 'NEWS SOON / LOCK' : state === 'CAUTION' ? 'NEWS SOON' : state === 'POST_NEWS' ? 'POST-NEWS' : state === 'CLEAR' ? 'NEWS CLEAR' : 'NEWS UNAVAILABLE';
}

function normalizeNewsItems(items, now) {
  const list = Array.isArray(items) ? items : (Array.isArray(items?.data) ? items.data : Array.isArray(items?.events) ? items.events : []);
  return list.map(x => {
      const currency = String(x.currency || x.country || x.ccy || '').toUpperCase();
      const impact = String(x.impact || x.importance || x.impactLevel || '').toLowerCase();
      let timestamp = Number(x.timestamp ?? x.ts ?? x.timeUnix);
      if (Number.isFinite(timestamp)) timestamp *= timestamp < 1e12 ? 1000 : 1;
      else timestamp = Date.parse(x.date || x.datetime || x.time || x.releaseTime || '');
      return {
        title: String(x.title || x.event || x.name || 'USD High Impact News'),
        currency, impact: impact === 'high' || impact === '3' || impact === 'red' ? 'HIGH' : String(x.impact || x.importance || 'UNKNOWN').toUpperCase(),
        timestamp,
        forecast: x.forecast ?? x.consensus ?? null, previous: x.previous ?? null, actual: x.actual ?? null
      };
    })
    .filter(x => x.currency === 'USD' && x.impact === 'HIGH')
    .filter(x => Number.isFinite(x.timestamp) && x.timestamp > now - (NEWS_POST_MIN * 60 * 1000) - 60000)
    .sort((a,b)=>a.timestamp-b.timestamp);
}

function newsResearch(event) {
  if (!event) return null;
  const t = event.title.toLowerCase();
  let className = 'MACRO';
  let reaction = 'VOLATILITY HIGH — WAIT FOR PRICE REACTION';
  if (/cpi|inflation|ppi|pce/.test(t)) className='INFLATION';
  else if (/non.?farm|payroll|employment|unemployment|jobless|claims/.test(t)) className='LABOR';
  else if (/fomc|interest rate|fed|powell|central bank/.test(t)) className='CENTRAL_BANK';
  else if (/gdp|retail sales|ism|pmi|consumer confidence/.test(t)) className='GROWTH';
  const scenarios = {
    hot: 'USD strength risk ↑ → Gold downside risk; wait for confirmation',
    inline: 'Initial volatility likely → wait for MSS/BOS + displacement + retest',
    cool: 'USD weakness risk ↑ → Gold upside risk; wait for confirmation'
  };
  return {eventClass:className, reaction, scenarios, methodology:'Rule-based pre-news research from event type/forecast/previous; not a guaranteed directional prediction.'};
}

function newsStateFromItems(items, now) {
  const upcoming = normalizeNewsItems(items, now);
  const next = upcoming.find(x => x.timestamp >= now) || null;
  const previous = [...upcoming].reverse().find(x => x.timestamp < now) || null;
  const deltaMin = next ? (next.timestamp-now)/60000 : Infinity;
  const sincePreviousMin = previous ? (now-previous.timestamp)/60000 : Infinity;
  let state = 'CLEAR';
  if (next && deltaMin <= NEWS_LIVE_WINDOW_MIN && deltaMin >= 0) state = 'LIVE';
  else if (next && deltaMin <= NEWS_PRELOCK_MIN && deltaMin >= 0) state = 'LOCK';
  else if (next && deltaMin <= NEWS_CAUTION_MIN) state = 'CAUTION';
  else if (previous && sincePreviousMin <= NEWS_POST_MIN) state = 'POST_NEWS';
  return {upcoming,next,previous,deltaMin,sincePreviousMin,state};
}

function refreshCachedNews(data, now) {
  if (!data || data.available === false) return data;
  const items = Array.isArray(data.upcoming) ? data.upcoming : [];
  const st = newsStateFromItems(items, now);
  return {
    ...data,
    state: st.state,
    label: newsStateLabel(st.state),
    next: st.next,
    previous: st.previous,
    deltaMin: Number.isFinite(st.deltaMin) ? Math.max(0, Math.round(st.deltaMin)) : null,
    sincePreviousMin: Number.isFinite(st.sincePreviousMin) ? Math.max(0, Math.round(st.sincePreviousMin)) : null,
    researchStatus: st.state==='LIVE'?'NEWS_LIVE':st.state==='POST_NEWS'?'POST_NEWS_REACTION':st.state==='LOCK'||st.state==='CAUTION'?'PRE_NEWS_RESEARCH':'CLEAR',
    research: newsResearch(st.next)
  };
}

async function fetchNewsSource(url) {
  const controller = new AbortController();
  const timeoutMs = Number(process.env.NEWS_SOURCE_TIMEOUT_MS || 5000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': `VTRADE-AI-NewsRadar/${APP_VERSION}`,
        'Accept': 'application/json,text/plain;q=0.9,*/*;q=0.8',
        'Cache-Control': 'no-cache'
      },
      signal: controller.signal
    });
    const contentType = String(r.headers.get('content-type') || '').toLowerCase();
    if (!r.ok) {
      const retryAfter = Number(r.headers.get('retry-after') || 0);
      const err = new Error(`news http ${r.status}`);
      err.status = r.status;
      err.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
      throw err;
    }
    const text = await r.text();
    const trimmed = text.trim();
    if (!trimmed || /^<!doctype html|^<html/i.test(trimmed)) {
      const err = new Error(`news returned HTML/non-JSON${contentType ? ` (${contentType})` : ''}`);
      err.status = 502;
      throw err;
    }
    try { return JSON.parse(trimmed); }
    catch {
      const err = new Error('news returned invalid JSON');
      err.status = 502;
      throw err;
    }
  } finally { clearTimeout(timer); }
}

async function fetchXauNews() {
  const now = Date.now();
  const cacheWindow = newsCache.data?.available === false ? NEWS_ERROR_RETRY_MS : NEWS_CACHE_MS;
  if (newsCache.data && now - newsCache.at < cacheWindow) return refreshCachedNews(newsCache.data, now);

  // Never hammer a rate-limited provider. Keep the last verified calendar for UI
  // context, but mark it degraded so the trading gate remains fail-closed.
  if (newsHealth.rateLimitedUntil > now && newsCache.data?.available === true) {
    return {
      ...refreshCachedNews(newsCache.data, now),
      sourceStatus: 'DEGRADED',
      degraded: true,
      trusted: false,
      error: `News provider rate-limited; retry after ${new Date(newsHealth.rateLimitedUntil).toISOString()}`
    };
  }

  // Prefer the broker/MT5 calendar bridge when present. This avoids relying on
  // public calendar export rate limits and keeps the news clock aligned with the
  // execution environment.
  if (bridgeNews.items && now - bridgeNews.receivedAt <= NEWS_BRIDGE_MAX_AGE_MS) {
    const st = newsStateFromItems(bridgeNews.items, now);
    const data = {
      available:true, state:st.state, label:newsStateLabel(st.state), next:st.next, previous:st.previous,
      deltaMin:Number.isFinite(st.deltaMin)?Math.max(0,Math.round(st.deltaMin)):null,
      sincePreviousMin:Number.isFinite(st.sincePreviousMin)?Math.max(0,Math.round(st.sincePreviousMin)):null,
      windowMinutes:NEWS_PRELOCK_MIN, postWindowMinutes:NEWS_POST_MIN,
      source:bridgeNews.source || 'MT5 bridge', sourceCount:1, sourceAgeSec:Math.round((now-bridgeNews.receivedAt)/1000),
      updatedAt:new Date(now).toISOString(), verifiedAt:now, sourceStatus:'LIVE', trusted:true, degraded:false, sourceDiagnostics:[{source:bridgeNews.source || 'MT5 bridge',status:'ok',ageSec:Math.round((now-bridgeNews.receivedAt)/1000)}],
      researchStatus:st.state==='LIVE'?'NEWS_LIVE':st.state==='POST_NEWS'?'POST_NEWS_REACTION':st.state==='LOCK'||st.state==='CAUTION'?'PRE_NEWS_RESEARCH':'CLEAR',
      research:newsResearch(st.next), upcoming:st.upcoming.slice(0,8)
    };
    newsHealth.lastSuccessAt=now; newsHealth.lastSource=data.source; newsHealth.lastError=null; newsHealth.successes++;
    newsCache.at=now; newsCache.data=data; return data;
  }

  const sources = [...new Set(NEWS_URLS)].filter(Boolean).slice(0, NEWS_MAX_SOURCES);
  const diagnostics=[];
  newsHealth.lastAttemptAt=now; newsHealth.attempts++;

  // Do NOT hit every public export endpoint in parallel. ForexFactory documents
  // a shared request limit across its weekly exports, so parallel fallback calls
  // can make an otherwise healthy feed look unavailable. Try one source at a time.
  for (const sourceUrl of sources) {
    try {
      const items = await fetchNewsSource(sourceUrl);
      const normalized = normalizeNewsItems(items, now);
      const st = newsStateFromItems(items, now);
      diagnostics.push({source:sourceUrl,status:'ok',items:normalized.length});
      const data = {
        available:true, state:st.state, label:newsStateLabel(st.state), next:st.next, previous:st.previous,
        deltaMin:Number.isFinite(st.deltaMin)?Math.max(0,Math.round(st.deltaMin)):null,
        sincePreviousMin:Number.isFinite(st.sincePreviousMin)?Math.max(0,Math.round(st.sincePreviousMin)):null,
        windowMinutes:NEWS_PRELOCK_MIN, postWindowMinutes:NEWS_POST_MIN,
        source:sourceUrl, sourceCount:sources.length, sourceAgeSec:0, updatedAt:new Date(now).toISOString(), verifiedAt:now,
        sourceStatus:'LIVE', trusted:true, degraded:false, sourceDiagnostics:diagnostics,
        researchStatus:st.state === 'LIVE' ? 'NEWS_LIVE' : st.state === 'POST_NEWS' ? 'POST_NEWS_REACTION' :
          st.state === 'LOCK' || st.state === 'CAUTION' ? 'PRE_NEWS_RESEARCH' : 'CLEAR',
        research:newsResearch(st.next), upcoming:st.upcoming.slice(0,8)
      };
      newsHealth.lastSuccessAt=now; newsHealth.lastSource=sourceUrl; newsHealth.lastError=null; newsHealth.successes++;
      newsCache.at=now; newsCache.data=data; return data;
    } catch (e) {
      const status = Number(e?.status || 0);
      if (status === 429) {
        const waitMs = Math.max(NEWS_429_RETRY_MS, Number(e?.retryAfterMs || 0));
        newsHealth.rateLimitedUntil = Math.max(newsHealth.rateLimitedUntil, now + waitMs);
      }
      diagnostics.push({source:sourceUrl,status:'error',httpStatus:status || null,error:e?.message || 'request failed'});
    }
  }

  const errors = diagnostics.map(d => `${d.source}: ${d.error || d.status}`).join(' | ');

  // A stale calendar is useful for visibility/diagnostics, but NEVER trusted for
  // a live entry decision. This prevents a 429 from making the UI look empty
  // while preserving the safety gate.
  if (newsCache.data?.available === true) {
    const ageMs = now - Number(newsCache.data.verifiedAt || newsCache.at || now);
    if (ageMs <= NEWS_STALE_MAX_MS) {
      const stale = refreshCachedNews(newsCache.data, now);
      const data = {
        ...stale, sourceStatus:'DEGRADED', trusted:false, degraded:true,
        sourceAgeSec:Math.round(ageMs/1000),
        verifiedAt:newsCache.data.verifiedAt || newsCache.at || null,
        error:errors || 'News source temporarily unavailable; using last verified snapshot for context only.'
      };
      newsCache.at=now; newsCache.data=data; return data;
    }
  }
  newsHealth.lastError=errors || 'No news source available';
  const data={
    available:false,state:'UNAVAILABLE',label:'NEWS UNAVAILABLE',next:null,previous:null,
    deltaMin:null,sincePreviousMin:null,windowMinutes:NEWS_PRELOCK_MIN,postWindowMinutes:NEWS_POST_MIN,
    source:sources[0]||null,sourceCount:sources.length,sourceStatus:'OFFLINE',trusted:false,degraded:true,sourceDiagnostics:diagnostics,
    updatedAt:new Date(now).toISOString(), error:errors || 'No news source available',
    researchStatus:'UNAVAILABLE',research:null,upcoming:[]
  };
  newsCache.at=now; newsCache.data=data; return data;
}

function brokerFeedAgeMs() {
  return brokerFeed.quote && brokerFeed.receivedAt
    ? Math.max(0, Date.now() - brokerFeed.receivedAt)
    : null;
}

function brokerFeedFresh() {
  const age = brokerFeedAgeMs();
  return age !== null && age <= MT5_MAX_AGE_MS;
}

function brokerFeedConnected() {
  const age = brokerFeedAgeMs();
  return age !== null && age <= MT5_CONNECTED_MAX_AGE_MS;
}

function brokerFeedState() {
  if (!brokerFeed.quote) return 'DISCONNECTED';
  const age = brokerFeedAgeMs();
  if (age <= MT5_MAX_AGE_MS) return 'READY';
  if (age <= MT5_CONNECTED_MAX_AGE_MS) return 'STALE';
  return 'DISCONNECTED';
}

function roundToDigits(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const d = Math.max(0, Math.min(10, Number(digits) || 0));
  const factor = 10 ** d;
  return Math.round(n * factor) / factor;
}

function brokerLivePrice() {
  if (!brokerFeedFresh()) return null;
  const q = brokerFeed.quote;
  const digits = Number.isFinite(Number(q.digits)) ? Number(q.digits) : 2;
  const bid = Number(q.bid), ask = Number(q.ask), last = Number(q.last);
  if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= 0) return null;
  // NEVER use a synthetic/mid price as the execution price.
  // BUY executes from broker ASK; SELL executes from broker BID.
  const mid = (bid + ask) / 2;
  return {
    price: roundToDigits(mid, digits),
    bid: roundToDigits(bid, digits),
    ask: roundToDigits(ask, digits),
    executionBuy: roundToDigits(ask, digits),
    executionSell: roundToDigits(bid, digits),
    digits,
    spread: Number.isFinite(Number(q.spread)) ? roundToDigits(q.spread, digits) : roundToDigits(ask - bid, digits),
    source: 'VT Markets MT5', sourceDetail: brokerFeed.symbol || 'XAUUSD',
    priceAsOf: new Date(Number(q.serverTime || brokerFeed.receivedAt)).toISOString(),
    ageSec: Math.round((Date.now()-brokerFeed.receivedAt)/1000), stale: false
  };
}

function parseBrokerCandles(tf) {
  if (!brokerFeedFresh() || !brokerFeed.timeframes?.[tf]) return null;
  const arr = brokerFeed.timeframes[tf];
  if (!Array.isArray(arr) || arr.length < 30) return null;
  // Accept both the normalized server shape (t/o/h/l/c) and the Python
  // MT5 bridge shape (time/open/high/low/close).
  return arr.map(x => {
    let t = Number(x.t ?? x.time);
    // Accept Unix seconds or milliseconds from MT5 bridge.
    if (Number.isFinite(t) && t > 0 && t < 1e12) t *= 1000;
    return {
      t,
      o: Number(x.o ?? x.open),
      h: Number(x.h ?? x.high),
      l: Number(x.l ?? x.low),
      c: Number(x.c ?? x.close), v: Number(x.v ?? x.volume ?? x.tickVolume ?? 0)
    };
  }).filter(x => [x.t,x.o,x.h,x.l,x.c].every(Number.isFinite))
    .sort((a,b)=>a.t-b.t);
}

function closedCandles(candles, timeframeMinutes) {
  if (!Array.isArray(candles) || !candles.length) return [];
  const tfMs=Number(timeframeMinutes)*60*1000;
  const now=Date.now();
  return candles.filter(x => Number.isFinite(x.t) && (x.t + tfMs) <= (now + 5000));
}

function avg(a) { return a.length ? a.reduce((x,y)=>x+y,0)/a.length : null; }
function atr(candles, n=14) {
  if (candles.length < n + 1) return null;
  const tr = [];
  for (let i=1;i<candles.length;i++) {
    const x=candles[i], p=candles[i-1];
    tr.push(Math.max(x.h-x.l, Math.abs(x.h-p.c), Math.abs(x.l-p.c)));
  }
  return avg(tr.slice(-n));
}
function ema(values, n) {
  if (!values.length) return null;
  const k=2/(n+1);
  let e=values[0];
  for (let i=1;i<values.length;i++) e=values[i]*k+e*(1-k);
  return e;
}
function swings(c, look=2) {
  const highs=[], lows=[];
  for (let i=look;i<c.length-look;i++) {
    let hi=true, lo=true;
    for (let j=1;j<=look;j++) {
      hi = hi && c[i].h >= c[i-j].h && c[i].h >= c[i+j].h;
      lo = lo && c[i].l <= c[i-j].l && c[i].l <= c[i+j].l;
    }
    if (hi) highs.push({i, price:c[i].h});
    if (lo) lows.push({i, price:c[i].l});
  }
  return {highs,lows};
}

function liquiditySweep(c) {
  const s=swings(c,2);
  if (s.highs.length < 2 || s.lows.length < 2) return {bias:'NONE', detail:'Insufficient swing history'};
  const last=c[c.length-1];
  const priorHigh=s.highs[s.highs.length-2].price;
  const lastHigh=s.highs[s.highs.length-1].price;
  const priorLow=s.lows[s.lows.length-2].price;
  const lastLow=s.lows[s.lows.length-1].price;

  if (last.h > lastHigh && last.c < lastHigh) return {bias:'BEARISH', detail:'Buy-side liquidity sweep', level:lastHigh};
  if (last.l < lastLow && last.c > lastLow) return {bias:'BULLISH', detail:'Sell-side liquidity sweep', level:lastLow};
  return {bias:'NONE', detail:'No confirmed sweep', level:Math.max(priorHigh, lastHigh, priorLow, lastLow)};
}

function structure(c) {
  const s=swings(c,2);
  if (s.highs.length<3 || s.lows.length<3) return {bias:'NONE', mss:'PENDING', bos:'PENDING'};
  const h=s.highs.slice(-3).map(x=>x.price), l=s.lows.slice(-3).map(x=>x.price);
  const bullish=h[2]>h[1] && l[2]>l[1];
  const bearish=h[2]<h[1] && l[2]<l[1];
  const last=c[c.length-1];
  const bosUp=last.c>h[1], bosDown=last.c<l[1];
  return {
    bias: bullish ? 'BULLISH' : bearish ? 'BEARISH' : 'RANGE',
    mss: bosUp ? 'BULLISH' : bosDown ? 'BEARISH' : 'PENDING',
    bos: bosUp ? 'BULLISH' : bosDown ? 'BEARISH' : 'PENDING',
    swingHigh:h[2], swingLow:l[2]
  };
}

function fvg(c) {
  if (c.length<3) return {found:false};
  for (let i=c.length-1;i>=2;i--) {
    const a=c[i-2], b=c[i-1], d=c[i];
    if (a.h < d.l) return {found:true, type:'BULLISH', low:a.h, high:d.l, index:i};
    if (a.l > d.h) return {found:true, type:'BEARISH', low:d.h, high:a.l, index:i};
  }
  return {found:false};
}

function orderBlock(c, bias) {
  for (let i=c.length-2;i>=5;i--) {
    const x=c[i], n=c[i+1];
    if (bias==='BULLISH' && x.c<x.o && n.c>x.h) return {found:true,type:'BULLISH',low:x.l,high:x.h,index:i};
    if (bias==='BEARISH' && x.c>x.o && n.c<x.l) return {found:true,type:'BEARISH',low:x.l,high:x.h,index:i};
  }
  return {found:false};
}

function round2(x) { return Math.round(x*100)/100; }


function rsi(values, n=14) {
  if (!Array.isArray(values) || values.length < n + 1) return null;
  let gain=0, loss=0;
  for(let i=1;i<=n;i++){ const d=values[i]-values[i-1]; if(d>=0) gain+=d; else loss-=d; }
  gain/=n; loss/=n;
  for(let i=n+1;i<values.length;i++){
    const d=values[i]-values[i-1];
    gain=((gain*(n-1)) + Math.max(d,0))/n;
    loss=((loss*(n-1)) + Math.max(-d,0))/n;
  }
  if(loss===0) return 100;
  return 100-(100/(1+(gain/loss)));
}
function macd(values, fast=12, slow=26, signal=9) {
  if(!Array.isArray(values) || values.length < slow+signal) return null;
  const ef=ema(values,fast), es=ema(values,slow);
  const macdLine=ef-es;
  const series=[];
  let f=values[0], s=values[0], sf=2/(fast+1), ss=2/(slow+1);
  for(const v of values){ f=v*sf+f*(1-sf); s=v*ss+s*(1-ss); series.push(f-s); }
  let sig=series[0], ks=2/(signal+1);
  for(let i=1;i<series.length;i++) sig=series[i]*ks+sig*(1-ks);
  return {line:macdLine, signal:sig, histogram:macdLine-sig, bullish:macdLine>sig};
}
function adx(c,n=14) {
  if(!Array.isArray(c) || c.length < n*2+1) return null;
  const tr=[], plus=[], minus=[];
  for(let i=1;i<c.length;i++){
    const cur=c[i], prev=c[i-1];
    tr.push(Math.max(cur.h-cur.l,Math.abs(cur.h-prev.c),Math.abs(cur.l-prev.c)));
    const up=cur.h-prev.h, down=prev.l-cur.l;
    plus.push(up>down && up>0?up:0); minus.push(down>up && down>0?down:0);
  }
  const atrV=avg(tr.slice(-n)) || 0;
  if(!atrV) return null;
  const p=avg(plus.slice(-n))||0, m=avg(minus.slice(-n))||0;
  const pdi=100*p/atrV, mdi=100*m/atrV, dx=(pdi+mdi)?100*Math.abs(pdi-mdi)/(pdi+mdi):0;
  return {value:dx, plusDI:pdi, minusDI:mdi, trendStrength:dx>=25?'STRONG':dx>=18?'MODERATE':'WEAK'};
}
function volumeBias(c) {
  const vals=c.map(x=>Number(x.v ?? x.volume ?? x.tickVolume ?? 0)).filter(Number.isFinite);
  if(vals.length<10 || vals.every(v=>v<=0)) return {available:false,bias:'UNAVAILABLE'};
  const recent=avg(vals.slice(-5))||0, base=avg(vals.slice(-20))||0;
  return {available:true,bias:recent>base*1.1?'EXPANDING':recent<base*0.9?'CONTRACTING':'NORMAL',ratio:base?recent/base:null};
}
function analyzeTF(c) {
  const closes=c.slice(-200).map(x=>x.c);
  const s=structure(c), sweep=liquiditySweep(c), a=atr(c,14);
  const e20=ema(closes,20), e50=ema(closes,50);
  const r=rsi(closes,AI_RSI_PERIOD), m=macd(closes), dx=adx(c,AI_ADX_PERIOD), vb=volumeBias(c);
  const trend=e20&&e50 ? (e20>e50?'BULLISH':e20<e50?'BEARISH':'NEUTRAL') : 'UNKNOWN';
  // Expose the same fresh ICT zones used by the opportunity engine so every
  // MTF row (including M1) can show a directional setup without inventing one.
  const side=s?.bias==='BULLISH'||s?.bias==='BEARISH' ? s.bias : trend;
  const fvg=latestFreshFvg(c, Math.min(12, Math.max(6, c.length-3)));
  const ob=latestAlignedOrderBlock(c, side, Math.min(20, Math.max(6, c.length-3)));
  return {
    structure:s,sweep,atr:a,ema20:e20,ema50:e50,trend,rsi:r==null?null:Math.round(r*100)/100,
    macd:m?{line:m.line,signal:m.signal,histogram:m.histogram,bias:m.histogram>0?'BULLISH':m.histogram<0?'BEARISH':'NEUTRAL'}:null,
    adx:dx,volume:vb,last:c[c.length-1]?.c,fvg,orderBlock:ob
  };
}

function zoneContains(price, zone) {
  return !!zone && Number.isFinite(price) && price >= zone.low && price <= zone.high;
}

function zoneDistance(price, zone) {
  if (!zone || !Number.isFinite(price)) return Infinity;
  if (price < zone.low) return zone.low - price;
  if (price > zone.high) return price - zone.high;
  return 0;
}

function candleDisplacement(candles) {
  if (!candles || candles.length < 20) return {confirmed:false, direction:'NONE', ratio:0};
  const last=candles[candles.length-1];
  const ranges=candles.slice(-21,-1).map(x=>x.h-x.l).filter(x=>x>0);
  const avgRange=avg(ranges) || 0;
  const body=Math.abs(last.c-last.o);
  const ratio=avgRange ? body/avgRange : 0;
  const bullish=last.c>last.o && ratio>=1.25;
  const bearish=last.c<last.o && ratio>=1.25;
  return {confirmed:bullish||bearish,direction:bullish?'BULLISH':bearish?'BEARISH':'NONE',ratio:round2(ratio)};
}

function nearestTarget(entry, direction, candles) {
  const s=swings(candles,2);
  const highs=s.highs.map(x=>x.price).filter(x=>x>entry);
  const lows=s.lows.map(x=>x.price).filter(x=>x<entry);
  if(direction==='BULLISH') return highs.length ? Math.min(...highs) : null;
  if(direction==='BEARISH') return lows.length ? Math.max(...lows) : null;
  return null;
}

function recentLiquiditySweep(c, lookback=8) {
  if (!c || c.length < 30) return {bias:'NONE', detail:'Insufficient swing history', fresh:false, index:null, ageBars:null};
  const start=Math.max(10,c.length-lookback);
  for(let i=c.length-1;i>=start;i--){
    const prior=c.slice(0,i), sw=swings(prior,2); if(sw.highs.length<2||sw.lows.length<2) continue;
    const last=c[i], priorHigh=sw.highs[sw.highs.length-1].price, priorLow=sw.lows[sw.lows.length-1].price;
    const ageBars=c.length-1-i;
    if(last.h>priorHigh&&last.c<priorHigh) return {bias:'BEARISH',detail:'Buy-side liquidity swept',level:priorHigh,index:i,fresh:ageBars<=5,ageBars};
    if(last.l<priorLow&&last.c>priorLow) return {bias:'BULLISH',detail:'Sell-side liquidity swept',level:priorLow,index:i,fresh:ageBars<=5,ageBars};
  }
  return {bias:'NONE',detail:'No recent confirmed liquidity sweep',fresh:false,index:null,ageBars:null};
}
function executionStructure(c) {
  if(!c||c.length<45) return {bias:'NONE',mss:'PENDING',bos:'PENDING',swingHigh:null,swingLow:null,mssFresh:false,bosFresh:false,mssBar:null,bosBar:null,mssAgeBars:null,bosAgeBars:null};
  // v7: MSS/BOS are allowed to unfold over several closed candles instead of
  // forcing the two events to occur on two consecutive candles. This removes
  // an artificial gate that was suppressing valid ICT continuations.
  const lookback=8, end=c.length-1, start=Math.max(20,end-lookback);
  let found=null;
  for(let i=end;i>=start;i--){
    const prior=c.slice(0,i), sw=swings(prior,2); if(sw.highs.length<3||sw.lows.length<3) continue;
    const hi=sw.highs[sw.highs.length-1].price, lo=sw.lows[sw.lows.length-1].price;
    const bar=c[i];
    if(bar.c>hi) { found={side:'BULLISH',mssIndex:i,mssLevel:hi}; break; }
    if(bar.c<lo) { found={side:'BEARISH',mssIndex:i,mssLevel:lo}; break; }
  }
  const recentSw=swings(c.slice(0,-1),2);
  const hs=recentSw.highs.slice(-2), ls=recentSw.lows.slice(-2);
  const bullishTrend=hs.length===2&&ls.length===2&&hs[1].price>hs[0].price&&ls[1].price>ls[0].price;
  const bearishTrend=hs.length===2&&ls.length===2&&hs[1].price<hs[0].price&&ls[1].price<ls[0].price;
  const fallbackBias=bullishTrend?'BULLISH':bearishTrend?'BEARISH':'RANGE';
  if(!found) {
    return {bias:fallbackBias,mss:'PENDING',bos:'PENDING',swingHigh:recentSw.highs.at(-1)?.price??null,swingLow:recentSw.lows.at(-1)?.price??null,mssFresh:false,bosFresh:false,mssBar:null,bosBar:null,mssAgeBars:null,bosAgeBars:null};
  }
  let bosIndex=null;
  for(let j=found.mssIndex+1;j<=end;j++){
    const bar=c[j];
    if(found.side==='BULLISH' && bar.c>c[j-1].h){ bosIndex=j; break; }
    if(found.side==='BEARISH' && bar.c<c[j-1].l){ bosIndex=j; break; }
  }
  const mssAge=end-found.mssIndex, bosAge=bosIndex==null?null:end-bosIndex;
  const bosFresh=bosIndex!=null && bosAge<=5;
  const mssFresh=mssAge<=6;
  return {
    bias:found.side,
    mss:found.side,
    bos:bosIndex!=null?found.side:'PENDING',
    swingHigh:recentSw.highs.at(-1)?.price??null,
    swingLow:recentSw.lows.at(-1)?.price??null,
    mssFresh,bosFresh,
    mssBar:{timestamp:c[found.mssIndex].t,close:c[found.mssIndex].c},
    bosBar:bosIndex!=null?{timestamp:c[bosIndex].t,close:c[bosIndex].c}:null,
    mssAgeBars:mssAge,bosAgeBars:bosAge
  };
}
function latestFreshFvg(c,maxAge=12){
  if(!c||c.length<3) return {found:false,reason:'No FVG'};
  for(let i=c.length-1;i>=2&&(c.length-1-i)<=maxAge;i--){
    const a=c[i-2],d=c[i]; let zone=null; if(a.h<d.l) zone={found:true,type:'BULLISH',low:a.h,high:d.l,index:i}; else if(a.l>d.h) zone={found:true,type:'BEARISH',low:d.h,high:a.l,index:i}; if(!zone) continue;
    const after=c.slice(i+1), fullyFilled=zone.type==='BULLISH'?after.some(x=>x.l<=zone.low):after.some(x=>x.h>=zone.high); if(fullyFilled) continue;
    zone.ageBars=c.length-1-i; zone.fresh=zone.ageBars<=maxAge; zone.mitigated=false; return zone;
  }
  return {found:false,reason:'No fresh unmitigated FVG'};
}
function evaluateOpportunityHorizon({key,label,minutes,candles,higherBiases,live,threshold,minRR,triggerCandles}) {
  if (!Array.isArray(candles) || candles.length < 45 || !live) {
    return {key,label,minutes,state:'UNAVAILABLE',signal:'WAIT',score:0,confidence:0,entry:null,entryZone:null,stopLoss:null,takeProfit:[],riskReward:null,reason:'Insufficient closed-candle history'};
  }
  const tf = analyzeTF(candles);
  const structure = executionStructure(candles);
  // M1 is a micro-timing trigger only. It can improve timing for an M5/M15/H1
  // opportunity, but it can never create a standalone entry by itself.
  const micro = Array.isArray(triggerCandles) && triggerCandles.length >= 45 ? analyzeTF(triggerCandles) : null;
  const microStructure = Array.isArray(triggerCandles) && triggerCandles.length >= 45 ? executionStructure(triggerCandles) : null;
  const microSweep = Array.isArray(triggerCandles) && triggerCandles.length >= 30 ? recentLiquiditySweep(triggerCandles, 8) : null;
  const microFvg = Array.isArray(triggerCandles) && triggerCandles.length >= 3 ? latestFreshFvg(triggerCandles, 8) : null;
  const microSide = microStructure && ['BULLISH','BEARISH'].includes(microStructure.bias) ? microStructure.bias : 'NEUTRAL';
  const microTrigger = microSide !== 'NEUTRAL' && microSweep?.fresh && microSweep.bias === microSide
    ? `${microSide} M1 trigger: fresh liquidity sweep + structure`
    : microSide !== 'NEUTRAL' && microFvg?.found && microFvg.type === microSide
      ? `${microSide} M1 trigger: fresh aligned FVG`
      : 'M1 trigger: WAIT';
  const side = structure.bias === 'BULLISH' || structure.bias === 'BEARISH' ? structure.bias : 'NEUTRAL';
  if (side === 'NEUTRAL') {
    return {key,label,minutes,state:'RANGE',signal:'WAIT',score:0,confidence:0,bias:'NEUTRAL',entry:null,entryZone:null,stopLoss:null,takeProfit:[],riskReward:null,reason:'Market structure is neutral/ranging'};
  }
  const sweep = recentLiquiditySweep(candles, Math.min(10, Math.max(6, Math.floor(minutes <= 5 ? 8 : 6))));
  const displacement = candleDisplacement(candles);
  const fvg = latestFreshFvg(candles, minutes <= 5 ? 12 : 8);
  const ob = latestAlignedOrderBlock(candles, side, minutes <= 5 ? 20 : 12);
  const alignedFvg = fvg.found && fvg.type === side;
  const alignedOb = ob.found && ob.type === side;
  const zone = alignedFvg ? {type:'FVG',low:Number(fvg.low),high:Number(fvg.high),ageBars:fvg.ageBars,bias:side} : alignedOb ? {type:'OB',low:Number(ob.low),high:Number(ob.high),ageBars:ob.ageBars,bias:side} : null;
  const inZone = zone ? zoneContains(live.price, zone) : false;
  const zoneDistanceNow = zone ? zoneDistance(live.price, zone) : Infinity;
  const atr = Number(tf.atr || 5);
  const zoneIsNear = !!zone && zoneDistanceNow <= Math.max(atr * (minutes <= 5 ? 2.5 : 3), 8);
  const higher = Array.isArray(higherBiases) ? higherBiases : [];
  const higherAligned = higher.filter(x=>x===side).length;
  const higherAvailable = higher.filter(x=>x==='BULLISH'||x==='BEARISH').length;
  const htfOk = higherAvailable === 0 ? false : higherAligned >= Math.max(1, Math.ceil(higherAvailable * 0.5));
  const rsi=tf.rsi, macd=tf.macd, adx=tf.adx;
  const momentumOk = side==='BULLISH' ? (rsi!=null && rsi>=50 && macd?.bias==='BULLISH') : (rsi!=null && rsi<=50 && macd?.bias==='BEARISH');
  const trendOk = !adx || Number(adx.value) >= 18;
  const pdSwingHigh=structure.swingHigh, pdSwingLow=structure.swingLow;
  const mid=Number.isFinite(pdSwingHigh)&&Number.isFinite(pdSwingLow)?(pdSwingHigh+pdSwingLow)/2:live.price;
  const pd=live.price>mid?'PREMIUM':'DISCOUNT';
  const pdOk=side==='BULLISH'?pd==='DISCOUNT':pd==='PREMIUM';
  const sweepOk=sweep.bias===side && sweep.fresh;
  const mssOk=structure.mss===side && structure.mssFresh;
  const bosOk=structure.bos===side && structure.bosFresh;
  const displacementOk=displacement.confirmed && displacement.direction===side;
  const retestOk=inZone;
  const structureOk=mssOk || bosOk;
  const points=[
    {key:'htf',label:'Higher-TF alignment',points:htfOk?20:0,max:20,passed:htfOk},
    {key:'liquidity',label:'Fresh liquidity sweep',points:sweepOk?15:0,max:15,passed:sweepOk},
    {key:'mss',label:'Fresh MSS',points:mssOk?12:0,max:12,passed:mssOk},
    {key:'bos',label:'Fresh BOS',points:bosOk?12:0,max:12,passed:bosOk},
    {key:'zone',label:'Aligned FVG / OB',points:(alignedFvg||alignedOb)?12:0,max:12,passed:alignedFvg||alignedOb},
    {key:'retest',label:'Execution retest / near zone',points:retestOk?8:(zoneIsNear?5:0),max:8,passed:retestOk||zoneIsNear},
    {key:'displacement',label:'Directional displacement',points:displacementOk?6:0,max:6,passed:displacementOk},
    {key:'momentum',label:'RSI + MACD momentum',points:momentumOk?5:0,max:5,passed:momentumOk},
    {key:'trend',label:'ADX trend strength',points:trendOk?5:0,max:5,passed:trendOk},
    {key:'location',label:'Premium / Discount',points:pdOk?5:0,max:5,passed:pdOk}
  ];
  const score=Math.min(100,points.reduce((n,x)=>n+x.points,0));
  let entry=null,stopLoss=null,takeProfit=[],riskReward=null,entryMode='WATCH';
  if (zone) {
    // v7 supports both MARKET and LIMIT execution. If price is outside the ICT zone,
    // the signal can still define a valid limit entry instead of waiting forever for retest.
    entry = inZone ? (side==='BULLISH'?live.executionBuy:live.executionSell) : roundToDigits((zone.low+zone.high)/2,live.digits);
    entryMode = inZone ? 'MARKET' : 'LIMIT';
    const buffer=Math.max(atr*0.30,0.8);
    stopLoss=side==='BULLISH'?roundToDigits(zone.low-buffer,live.digits):roundToDigits(zone.high+buffer,live.digits);
    const risk=Math.max(Math.abs(entry-stopLoss),0.5);
    const target=nearestTarget(entry,side,candles);
    const tp1=target && (side==='BULLISH'?target>entry:target<entry) ? target : (side==='BULLISH'?entry+risk*minRR:entry-risk*minRR);
    takeProfit=[roundToDigits(tp1,live.digits),roundToDigits(side==='BULLISH'?entry+risk*(minRR+1):entry-risk*(minRR+1),live.digits),roundToDigits(side==='BULLISH'?entry+risk*(minRR+2):entry-risk*(minRR+2),live.digits),roundToDigits(side==='BULLISH'?entry+risk*(minRR+3.5):entry-risk*(minRR+3.5),live.digits)];
    riskReward=Number((Math.abs(takeProfit[0]-entry)/risk).toFixed(2));
  }
  const setupReady=score>=threshold && htfOk && structureOk && (sweepOk || bosOk) && (alignedFvg||alignedOb) && pdOk && (displacementOk||momentumOk) && trendOk && Number(riskReward||0)>=minRR && (retestOk||zoneIsNear);
  const confirmedReady=setupReady && (retestOk || (sweepOk && bosOk && displacementOk && score>=threshold+4));
  const signal=confirmedReady?(side==='BULLISH'?'BUY':'SELL'):'WAIT';
  const state=confirmedReady?'CONFIRMED':setupReady?'READY':'WATCH';
  const reason=confirmedReady
    ? `${label}: ${side} ${entryMode} setup confirmed with ICT structure + liquidity + zone + RR ${riskReward}`
    : setupReady
      ? `${label}: ${side} setup ready; ${entryMode==='LIMIT'?'wait for limit zone touch':'wait for final trigger'}`
      : `${label}: waiting for ${points.filter(x=>!x.passed).map(x=>x.label).slice(0,3).join(', ') || 'better risk/reward'}`;
  return {key,label,minutes,state,signal,bias:side,score,confidence:score,entry,entryMode,entryZone:zone?{...zone,low:round2(zone.low),high:round2(zone.high)}:null,stopLoss,takeProfit,riskReward,higherAlignment:`${higherAligned}/${higherAvailable}`,zoneIsNear,inZone,microTrigger,microTimeframe:'M1',ict:{liquiditySweep:sweep,mss:structure.mss,bos:structure.bos,fvg,orderBlock:ob,displacement,m1:{bias:microSide,sweep:microSweep,fvg:microFvg,structure:microStructure}},technical:{rsi,macd,adx,m1Rsi:micro?.rsi,m1Macd:micro?.macd},premiumDiscount:pd,premiumDiscountOk:pdOk,scoreItems:points,reason};
}

function latestAlignedOrderBlock(c,bias,maxAge=20){
  if(!c||!bias||bias==='NEUTRAL') return {found:false};
  for(let i=c.length-2;i>=5&&(c.length-1-i)<=maxAge;i--){const x=c[i],n=c[i+1]; if(bias==='BULLISH'&&x.c<x.o&&n.c>x.h) return {found:true,type:'BULLISH',low:x.l,high:x.h,index:i,ageBars:c.length-1-i}; if(bias==='BEARISH'&&x.c>x.o&&n.c<x.l) return {found:true,type:'BEARISH',low:x.l,high:x.h,index:i,ageBars:c.length-1-i};}
  return {found:false};
}

async function openAIConfirmXauAnalysis(a) {
  if (!OPENAI_ENABLED || !OPENAI_API_KEY) {
    return { enabled:false, configured:!!OPENAI_API_KEY, model:OPENAI_MODEL, status:'disabled' };
  }
  const compact = {
    symbol:a.symbol, signal:a.signal, bias:a.bias, confidence:a.confidence, setupGrade:a.setupGrade,
    status:a.status, actionable:a.actionable, entry:a.entry, stopLoss:a.stopLoss, takeProfit:a.takeProfit,
    executionTimeframe:a.executionTimeframe, entryMode:a.entryMode, spread:a.spread, priceAgeSec:a.priceAgeSec,
    score:a.score, confirmations:a.confirmations, decision:a.decision,
    mt5:{brokerConnected:a.brokerConnected,feedMode:a.feedMode,bid:a.bid,ask:a.ask,spread:a.spread},
    mtf:a.mtf, ict:a.ict,
    timeframes:Object.fromEntries(Object.entries(a.timeframes||{}).map(([tf,v])=>[tf,{bias:v?.structure?.bias,rsi:v?.rsi,macd:v?.macd,adx:v?.adx,structure:v?.structure,liquiditySweep:v?.liquiditySweep}])),
    zoneRadar:a.zoneRadar, referenceZone:a.referenceZone, entryTiming:a.entryTiming
  };
  const system = `You are the independent AI confirmation layer for V-TRADE AI XAUUSD.\n`+
    `Analyze ONLY the supplied broker-native MT5/ICT data. Do not invent prices, candles, news, or confirmations.\n`+
    `You are NOT allowed to override the deterministic risk/entry gate. If the engine says WAIT/NO TRADE or mandatory gates are missing, recommend WAIT.\n`+
    `A BUY/SELL recommendation is valid only when the supplied evidence supports liquidity + MSS/BOS + aligned FVG/OB + displacement/momentum + premium/discount + MTF alignment + acceptable RR/spread.\n`+
    `Evaluate every supplied zone independently. For the configured EX Zone 4346.92-4350.54, label BULLISH, BEARISH, or WAIT from the live evidence; never force a direction. Prefer event-based entry timing (zone touch + M1 confirmation) over inventing an exact future clock time.\n`+
    `Return strict JSON with: decision (BUY|SELL|WAIT), confidence (0-100), agreement (AGREE|DISAGREE|NEUTRAL), reasons (array of short strings), missingConfirmations (array), riskFlags (array), summary (string).`;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),OPENAI_TIMEOUT_MS);
  try {
    const r=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',signal:controller.signal,
      headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        model:OPENAI_MODEL,
        reasoning:{effort:'low'},
        store:false,
        input:[
          {role:'system',content:[{type:'input_text',text:system}]},
          {role:'user',content:[{type:'input_text',text:JSON.stringify(compact)}]}
        ],
        text:{format:{type:'json_object'}}
      })
    });
    const body=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(body?.error?.message || `OpenAI HTTP ${r.status}`);
    const raw=body?.output_text || body?.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('') || '';
    let parsed;
    try { parsed=JSON.parse(raw); } catch (_) { throw new Error('OpenAI returned non-JSON confirmation'); }
    const decision=['BUY','SELL','WAIT'].includes(parsed.decision)?parsed.decision:'WAIT';
    const confidence=Math.max(0,Math.min(100,Number(parsed.confidence)||0));
    return {enabled:true,configured:true,model:OPENAI_MODEL,status:'ok',decision,confidence,
      agreement:['AGREE','DISAGREE','NEUTRAL'].includes(parsed.agreement)?parsed.agreement:'NEUTRAL',
      reasons:Array.isArray(parsed.reasons)?parsed.reasons.slice(0,8).map(String):[],
      missingConfirmations:Array.isArray(parsed.missingConfirmations)?parsed.missingConfirmations.slice(0,8).map(String):[],
      riskFlags:Array.isArray(parsed.riskFlags)?parsed.riskFlags.slice(0,8).map(String):[],
      summary:String(parsed.summary||'').slice(0,1000),
      usage:body?.usage?{inputTokens:body.usage.input_tokens,outputTokens:body.usage.output_tokens,totalTokens:body.usage.total_tokens}:null,
      gate:{engineSignal:a.signal,engineConfidence:a.confidence,enginePassed:a.confirmations?.allGatesPassed===true,
        aiEligible:confidence>=OPENAI_MIN_SCORE && a.confirmations?.allGatesPassed===true,
        finalSignal:(a.confirmations?.allGatesPassed===true && confidence>=OPENAI_MIN_SCORE && decision===a.signal && agreement==='AGREE' && ['BUY','SELL'].includes(decision))?decision:'WAIT'}
    };
  } catch(e) {
    return {enabled:true,configured:true,model:OPENAI_MODEL,status:e.name==='AbortError'?'timeout':'error',error:String(e.message||'OpenAI confirmation failed').slice(0,300),decision:'WAIT',confidence:0,agreement:'NEUTRAL',reasons:[],missingConfirmations:[],riskFlags:['AI confirmation unavailable; deterministic gate remains authoritative'],summary:'AI confirmation unavailable; no trade signal is promoted.'};
  } finally { clearTimeout(timer); }
}

async function buildXauAnalysis() {
  const analysisStartedAt = Date.now();
  const analysisKey = `${brokerFeed.receivedAt}:${bridgeNews.receivedAt}:${newsCache.at}`;
  const now = Date.now();
  if (analysisCache.data && analysisCache.key === analysisKey && now - analysisCache.at < ANALYSIS_CACHE_MS) return analysisCache.data;
  const newsPromise = fetchXauNews();
  const rawM1=parseBrokerCandles('M1'),rawM5=parseBrokerCandles('M5'),rawM15=parseBrokerCandles('M15'),rawH1=parseBrokerCandles('H1'),rawH4=parseBrokerCandles('H4'),rawD1=parseBrokerCandles('D1'),rawW1=parseBrokerCandles('W1');
  const live=brokerLivePrice();
  const readinessMissing=[];
  if(!live) readinessMissing.push('QUOTE');
  for (const tf of ['M5','M15','H1','H4']) {
    const rows = {M5:rawM5,M15:rawM15,H1:rawH1,H4:rawH4}[tf];
    if(!rows) readinessMissing.push(tf);
  }
  if(readinessMissing.length) {
    const age = brokerFeed.quote ? Math.max(0,Math.round((Date.now()-brokerFeed.receivedAt)/1000)) : null;
    const detail = `VT Markets MT5 feed not ready: missing=${readinessMissing.join(',')} ageSec=${age===null?'null':age} maxAgeMs=${MT5_MAX_AGE_MS}`;
    throw new Error(detail);
  }
  // Structure/ICT decisions use CLOSED candles; live quote remains the execution price.
  const m1=rawM1?closedCandles(rawM1,1):[],m5=closedCandles(rawM5,5),m15=closedCandles(rawM15,15),h1=closedCandles(rawH1,60),h4=closedCandles(rawH4,240),d1=rawD1?closedCandles(rawD1,1440):[],w1=rawW1?closedCandles(rawW1,10080):[];
  if(m5.length<AI_MIN_BARS||m15.length<30||h1.length<30||h4.length<30) throw new Error('VT Markets MT5 closed-candle history not ready');
  const [m1a,m5a,m15a,h1a,h4a,d1a,w1a]=await Promise.all([
    Promise.resolve(m1.length>=30?analyzeTF(m1):null),Promise.resolve(analyzeTF(m5)),Promise.resolve(analyzeTF(m15)),
    Promise.resolve(analyzeTF(h1)),Promise.resolve(analyzeTF(h4)),Promise.resolve(d1.length>=30?analyzeTF(d1):null),Promise.resolve(w1.length>=20?analyzeTF(w1):null)
  ]);
  const feedMode='VT Markets MT5',tfs={M1:m1a,M5:m5a,M15:m15a,H1:h1a,H4:h4a,D1:d1a,W1:w1a},a=tfs.M5.atr||5;
  const candleAgeSec=m5.length?Math.max(0,(Date.now()-m5[m5.length-1].t)/1000):Infinity,candlesFresh=candleAgeSec<=15*60;
  // Full MTF context is visible to the engine, while the execution gate remains
  // intentionally strict on H4/H1/M15. D1 and M5/M1 add context; they cannot
  // manufacture an entry by themselves.
  const coreBiases = CORE_MTF_TFS.map(tf => tfs[tf]?.structure?.bias || 'UNAVAILABLE');
  const fullBiases = FULL_MTF_TFS.map(tf => ({tf, bias:tfs[tf]?.structure?.bias || 'UNAVAILABLE'}));
  const coreBull = coreBiases.filter(x=>x==='BULLISH').length;
  const coreBear = coreBiases.filter(x=>x==='BEARISH').length;
  const fullBull = fullBiases.filter(x=>x.bias==='BULLISH').length;
  const fullBear = fullBiases.filter(x=>x.bias==='BEARISH').length;
  const d1Bias=tfs.D1?.structure?.bias||'UNAVAILABLE';
  const macroBias=coreBull>coreBear?'BULLISH':coreBear>coreBull?'BEARISH':'NEUTRAL';
  const mtfCount=Math.max(coreBull,coreBear);
  const fullMtfCount=Math.max(fullBull,fullBear);
  // History availability is independent from directional bias. SIDEWAY is valid data,
  // not a missing timeframe. Alignment remains a separate safety gate below.
  const availableHtf=CORE_MTF_TFS.filter(tf=>Array.isArray({M5:m5,M15:m15,H1:h1,H4:h4}[tf]) && {M5:m5,M15:m15,H1:h1,H4:h4}[tf].length>=30).length;
  const fullMtfAvailable=FULL_MTF_TFS.filter(tf=>Array.isArray({M1:m1,M5:m5,M15:m15,H1:h1,H4:h4,D1:d1,W1:w1}[tf]) && {M1:m1,M5:m5,M15:m15,H1:h1,H4:h4,D1:d1,W1:w1}[tf].length>=30).length;

  const execStruct=executionStructure(m5),sweep=recentLiquiditySweep(m5,6),displacement=candleDisplacement(m5),f=latestFreshFvg(m5,12),ob=latestAlignedOrderBlock(m5,macroBias,20),side=macroBias;
  const alignedFvg=f.found&&f.type===side,alignedOb=ob.found&&ob.type===side,zoneCandidates=[];
  if(alignedFvg) zoneCandidates.push({type:'FVG',low:Number(f.low),high:Number(f.high),bias:side,ageBars:f.ageBars});
  if(alignedOb) zoneCandidates.push({type:'OB',low:Number(ob.low),high:Number(ob.high),bias:side,ageBars:ob.ageBars});
  zoneCandidates.sort((x,y)=>zoneDistance(live.price,x)-zoneDistance(live.price,y));
  const candidateZone=zoneCandidates[0]||null,inZone=zoneContains(live.price,candidateZone),zoneIsNear=!!candidateZone&&zoneDistance(live.price,candidateZone)<=Math.max(a*2,8);
  const swingHigh=execStruct.swingHigh,swingLow=execStruct.swingLow,mid=(Number.isFinite(swingHigh)&&Number.isFinite(swingLow))?(swingHigh+swingLow)/2:live.price;
  const premiumDiscount=live.price>mid?'PREMIUM':'DISCOUNT';
  const pdOk=side==='BULLISH'?premiumDiscount==='DISCOUNT':side==='BEARISH'?premiumDiscount==='PREMIUM':false;
  const spreadOk=Number.isFinite(live.spread)&&live.spread<=MAX_ENTRY_SPREAD;
  const biasOk=(side==='BULLISH'&&coreBull>=MIN_MTF_ALIGNMENT)||(side==='BEARISH'&&coreBear>=MIN_MTF_ALIGNMENT),sweepOk=sweep.bias===side&&sweep.fresh,mssOk=execStruct.mss===side&&execStruct.mssFresh,bosOk=execStruct.bos===side&&execStruct.bosFresh,displacementOk=displacement.confirmed&&displacement.direction===side,retestOk=!!candidateZone&&inZone,zoneNearOk=!!candidateZone&&zoneDistance(live.price,candidateZone)<=Math.max(a*3.5,12),structureAgreement=mssOk||bosOk;
  const rsiM5=tfs.M5.rsi,macdM5=tfs.M5.macd,adxM5=tfs.M5.adx;
  const technicalMomentumOk=(side==='BULLISH'&&rsiM5!=null&&rsiM5>=50&&macdM5?.bias==='BULLISH')||(side==='BEARISH'&&rsiM5!=null&&rsiM5<=50&&macdM5?.bias==='BEARISH');
  const trendStrengthOk=!adxM5||adxM5.value>=18;
  const mtfEvidenceCount = side==='BULLISH' ? fullBull : side==='BEARISH' ? fullBear : 0;
  const mtfEvidencePoints = fullMtfAvailable ? Math.round(20 * mtfEvidenceCount / fullMtfAvailable) : 0;
  const scoreItems=[
    {key:'mtf',label:'MTF alignment',points:mtfEvidencePoints,max:20,passed:biasOk},
    {key:'liquidity',label:'Fresh liquidity sweep',points:sweepOk?15:0,max:15,passed:sweepOk},
    {key:'mss',label:'Fresh MSS',points:mssOk?15:0,max:15,passed:mssOk},
    {key:'bos',label:'Fresh BOS',points:bosOk?10:0,max:10,passed:bosOk},
    {key:'fvgOb',label:'Aligned FVG / OB',points:(alignedFvg||alignedOb)?10:0,max:10,passed:alignedFvg||alignedOb},
    {key:'retest',label:'Execution retest',points:retestOk?10:0,max:10,passed:retestOk},
    {key:'displacement',label:'Directional displacement',points:displacementOk?5:0,max:5,passed:displacementOk},
    {key:'location',label:'Premium / Discount location',points:pdOk?5:0,max:5,passed:pdOk},
    {key:'momentum',label:'RSI + MACD momentum',points:technicalMomentumOk?5:0,max:5,passed:technicalMomentumOk},
    {key:'trend',label:'ADX trend strength',points:trendStrengthOk?5:0,max:5,passed:trendStrengthOk}
  ];
  const rawScore=scoreItems.reduce((s,x)=>s+x.points,0),confluenceScore=Math.min(100,rawScore);

  // Direction score is separate from setup/confluence strength.
  // 80-100 = bullish, 60-79 = bullish bias, 40-59 = neutral,
  // 20-39 = bearish bias, 0-19 = bearish. A low score is therefore
  // a bearish direction score, not merely a weak setup. Entry still
  // requires the deterministic ICT/MTF/risk gates below.
  let directionScore=50;
  if (side==='BULLISH') directionScore += 12;
  else if (side==='BEARISH') directionScore -= 12;
  directionScore += side==='BULLISH' ? Math.min(18, coreBull*6) : side==='BEARISH' ? -Math.min(18, coreBear*6) : 0;
  if (sweepOk) directionScore += side==='BULLISH' ? 8 : -8;
  if (mssOk) directionScore += side==='BULLISH' ? 7 : -7;
  if (bosOk) directionScore += side==='BULLISH' ? 5 : -5;
  if (displacementOk) directionScore += side==='BULLISH' ? 5 : -5;
  if (technicalMomentumOk) directionScore += side==='BULLISH' ? 4 : -4;
  if (alignedFvg || alignedOb) directionScore += side==='BULLISH' ? 4 : -4;
  directionScore=Math.max(0,Math.min(100,Math.round(directionScore)));
  const directionBand=directionScore>=80?'BULLISH':directionScore>=60?'BULLISH_BIAS':directionScore>=40?'NEUTRAL':directionScore>=20?'BEARISH_BIAS':'BEARISH';

  let signal='WAIT',status='WAIT — CONFIRMATION PENDING',entry=null,sl=null,tp=[],trigger=''; const reasons=[];
  if(!candlesFresh) reasons.push('Closed-candle data is stale — wait for fresh MT5 history');
  if(!biasOk) reasons.push('MTF core bias not aligned — need 2/3 H4/H1/M15 agreement');
  if(availableHtf < 2) reasons.push(`Core MTF context incomplete — ${availableHtf}/3 H4/H1/M15 timeframes available`);
  if(!sweepOk) reasons.push('Fresh liquidity sweep not confirmed');
  if(!mssOk) reasons.push('Fresh M5 MSS not confirmed');
  if(!displacementOk) reasons.push('Directional displacement not confirmed');
  if(!(alignedFvg||alignedOb)) reasons.push('No fresh aligned FVG/OB');
  if(!retestOk && !zoneNearOk) reasons.push('Price is outside the execution zone');
  if(!bosOk && !mssOk) reasons.push('Fresh M5 MSS/BOS structure break not confirmed');
  if(!pdOk) reasons.push(`Price is in ${premiumDiscount} — wait for ${side==='BULLISH'?'discount':'premium'} execution`);
  if(!spreadOk) reasons.push(`Spread ${live.spread ?? '—'} exceeds max ${MAX_ENTRY_SPREAD}`);
  if(!technicalMomentumOk && !displacementOk) reasons.push('Momentum/displacement does not confirm the execution direction');
  if(!trendStrengthOk) reasons.push('ADX trend strength is too weak for the execution gate');
  const provisionalEntry=candidateZone ? (retestOk ? (side==='BULLISH'?live.executionBuy:live.executionSell) : roundToDigits((candidateZone.low+candidateZone.high)/2,live.digits)) : null;
  const provisionalBuffer=Math.max(a*0.35,0.8);
  const provisionalSL=candidateZone ? (side==='BULLISH'?candidateZone.low-provisionalBuffer:candidateZone.high+provisionalBuffer) : null;
  const provisionalRisk=candidateZone&&Number.isFinite(provisionalEntry)&&Number.isFinite(provisionalSL)?Math.max(Math.abs(provisionalEntry-provisionalSL),0.5):null;
  const provisionalTarget=provisionalRisk!=null?nearestTarget(provisionalEntry,side,m5):null;
  const provisionalTP1=provisionalRisk!=null ? (provisionalTarget && (side==='BULLISH'?provisionalTarget>provisionalEntry:provisionalTarget<provisionalEntry) ? provisionalTarget : (side==='BULLISH'?provisionalEntry+provisionalRisk*1.8:provisionalEntry-provisionalRisk*1.8)) : null;
  const provisionalRR=provisionalRisk!=null&&provisionalTP1!=null?Math.abs(provisionalTP1-provisionalEntry)/provisionalRisk:0;
  const setupReady=candlesFresh&&biasOk&&structureAgreement&&(sweepOk||bosOk)&&(alignedFvg||alignedOb)&&pdOk&&spreadOk&&(displacementOk||technicalMomentumOk)&&trendStrengthOk&&provisionalRR>=1.5&&confluenceScore>=MIN_ENTRY_SCORE&&(retestOk||zoneNearOk);
  if(setupReady){
    signal=side==='BULLISH'?'BUY':'SELL';
    const z=candidateZone;
    const limitEntry=!retestOk && !!z;
    entry=limitEntry?roundToDigits((z.low+z.high)/2,live.digits):(side==='BULLISH'?live.executionBuy:live.executionSell);
    const buffer=Math.max(a*0.35,0.8);
    sl=side==='BULLISH'?roundToDigits(z.low-buffer,live.digits):roundToDigits(z.high+buffer,live.digits);
    const risk=Math.max(Math.abs(entry-sl),0.5),structureTarget=nearestTarget(entry,side,m5),minTp1=side==='BULLISH'?entry+risk*1.8:entry-risk*1.8,target1=structureTarget&&(side==='BULLISH'?structureTarget>minTp1:structureTarget<minTp1)?structureTarget:minTp1;
    tp=[roundToDigits(target1,live.digits),roundToDigits(side==='BULLISH'?entry+risk*2.7:entry-risk*2.7,live.digits),roundToDigits(side==='BULLISH'?entry+risk*3.8:entry-risk*3.8,live.digits),roundToDigits(side==='BULLISH'?entry+risk*4.8:entry-risk*4.8,live.digits)];
    const rr=Number((Math.abs(tp[0]-entry)/risk).toFixed(2));
    status=limitEntry?'ENTRY CONFIRMED — LIMIT':'ENTRY CONFIRMED — MARKET';
    trigger=`${side} confirmed: ${sweepOk?'liquidity sweep + ':''}${mssOk?'MSS + ':''}${bosOk?'BOS + ':''}${displacementOk?'displacement + ':''}${alignedFvg?'FVG':'OB'} ${limitEntry?'limit zone':'retest'} · RR ${rr}`;
  } else { if(side==='NEUTRAL') status='NO TRADE — MARKET NEUTRAL'; else if(side==='BULLISH'&&coreBull>=MIN_MTF_ALIGNMENT) status='WAIT — BULLISH BIAS, NO ENTRY'; else if(side==='BEARISH'&&coreBear>=MIN_MTF_ALIGNMENT) status='WAIT — BEARISH BIAS, NO ENTRY'; else status='NO TRADE — MTF CONFLICT'; trigger=reasons.slice(0,4).join('; ')||'No confirmed execution setup'; }
  const horizon5 = evaluateOpportunityHorizon({key:'M5',label:'5M SCALP',minutes:5,candles:m5,triggerCandles:m1,higherBiases:[tfs.M15?.structure?.bias,tfs.H1?.structure?.bias,tfs.H4?.structure?.bias],live,threshold:72,minRR:1.5});
  const horizon15 = evaluateOpportunityHorizon({key:'M15',label:'15M INTRADAY',minutes:15,candles:m15,triggerCandles:m5,higherBiases:[tfs.H1?.structure?.bias,tfs.H4?.structure?.bias],live,threshold:78,minRR:2});
  const horizon60 = evaluateOpportunityHorizon({key:'H1',label:'1H SWING',minutes:60,candles:h1,triggerCandles:m15,higherBiases:[tfs.H4?.structure?.bias,tfs.D1?.structure?.bias],live,threshold:82,minRR:2.5});
  const horizonCandidates=[horizon5,horizon15,horizon60].filter(x=>x.state==='CONFIRMED');
  const bestOpportunity=horizonCandidates.sort((x,y)=>(y.score-x.score)||((y.riskReward||0)-(x.riskReward||0)))[0] || null;
  const news=await newsPromise;
  const newsBlocked = (NEWS_FAIL_CLOSED && (!news.available || news.trusted === false || news.degraded === true)) || news.state==='LIVE' || news.state==='LOCK' || news.state==='POST_NEWS';
  if(newsBlocked){
    signal='WAIT'; entry=null; sl=null; tp=[];
    if(!news.available){ status='NEWS UNAVAILABLE — NO ENTRY'; trigger='News feed unavailable; do not trade until USD high-impact calendar is verified'; }
    else if(news.degraded || news.trusted === false){ status='NEWS DEGRADED — CONTEXT ONLY'; trigger='News provider is degraded/stale; ICT + MT5 analysis remains active, but verify high-impact USD events before execution'; }
    else if(news.state==='LIVE'){ status='NEWS LIVE — NO ENTRY'; trigger=`${news.next?.title || 'High-impact USD news'} is live; wait for post-news sweep + MSS/BOS + displacement + retest`; }
    else if(news.state==='POST_NEWS'){ status='POST-NEWS — WAIT FOR REACTION'; trigger='High-impact USD news just passed; wait for post-news sweep + MSS/BOS + displacement + retest'; }
    else { status='NEWS LOCK — WAIT AFTER NEWS'; trigger=`${news.next?.title || 'High-impact USD news'} is due soon; wait for post-news confirmation`; }
  }
  const opportunityEntryBlocked = newsBlocked || !brokerFeedFresh();
  const safeOpportunities = [horizon5,horizon15,horizon60].map(o=> opportunityEntryBlocked ? {...o,state:'NEWS_LOCK',signal:'WAIT',reason:newsBlocked ? 'Global news gate is locked; opportunity shown for context only' : 'Broker feed is stale'} : o);
  const safeConfirmed = safeOpportunities.filter(o=>o.state==='CONFIRMED' && o.signal!=='WAIT');
  const selectedOpportunity = safeConfirmed.sort((x,y)=>(y.score-x.score)||((y.riskReward||0)-(x.riskReward||0)))[0] || null;
  // Keep the canonical M5 gate for legacy fields, but expose the best confirmed horizon as the actionable opportunity.
  if (selectedOpportunity && !setupReady && !newsBlocked) {
    signal=selectedOpportunity.signal;
    status=`${selectedOpportunity.label} — ENTRY CONFIRMED`;
    entry=selectedOpportunity.entry;
    sl=selectedOpportunity.stopLoss;
    tp=selectedOpportunity.takeProfit;
    trigger=selectedOpportunity.reason;
  }
  if (newsBlocked) {
    horizon5.state=horizon15.state=horizon60.state='NEWS_LOCK';
  }
  let phase='NO_TRADE';
  if((setupReady || selectedOpportunity) && !newsBlocked) phase=signal;
  else if(newsBlocked) phase='NEWS_LOCK';
  else if((side==='BULLISH'||side==='BEARISH') && confluenceScore>=50) phase='MIDWAY';
  else phase='WAIT';

  const effectiveScore=selectedOpportunity?.score ?? confluenceScore;
  const setupGrade=effectiveScore>=90?'HIGH CONFLUENCE':effectiveScore>=MIN_CONFLUENCE?'CONFIRMED CANDIDATE':effectiveScore>=65?'WATCH':'WAIT';
  const dataQualityItems = [
    {key:'mt5', label:'MT5 quote freshness', passed:brokerFeedFresh(), points:brokerFeedFresh()?20:0, max:20},
    {key:'candles', label:'Closed-candle freshness', passed:candlesFresh, points:candlesFresh?15:0, max:15},
    {key:'mtf', label:'MTF history coverage', passed:availableHtf===CORE_MTF_TFS.length, points:availableHtf===CORE_MTF_TFS.length?15:0, max:15},
    {key:'news', label:'News verification', passed:!!news.available && news.trusted===true && news.degraded!==true, points:!!news.available && news.trusted===true && news.degraded!==true?20:0, max:20},
    {key:'spread', label:'Execution spread quality', passed:spreadOk, points:spreadOk?10:0, max:10},
    {key:'engine', label:'Engine calculation integrity', passed:true, points:20, max:20}
  ];
  const dataQuality = dataQualityItems.reduce((sum,x)=>sum+x.points,0);
  const dataQualityGrade = dataQuality>=95?'A+':dataQuality>=AI_DATA_QUALITY_MIN?'A':dataQuality>=75?'B':'C';
  const confirmations={mtfAligned:selectedOpportunity ? true : biasOk,mtfCount:selectedOpportunity ? Math.max(2, mtfCount) : mtfCount,liquiditySweep:selectedOpportunity ? true : sweepOk,mss:selectedOpportunity ? true : mssOk,bos:selectedOpportunity ? true : bosOk,mssState:execStruct.mss,bosState:execStruct.bos,displacement,retest:selectedOpportunity ? true : retestOk,inZone,zoneIsNear,freshFvg:alignedFvg,freshOb:alignedOb,premiumDiscount,premiumDiscountOk:pdOk,spreadOk,maxSpread:MAX_ENTRY_SPREAD,rsi:rsiM5,macd:macdM5,adx:adxM5,technicalMomentumOk,trendStrengthOk,allGatesPassed:(setupReady || !!selectedOpportunity) && !newsBlocked};
  const result = {symbol:'XAUUSD',engineVersion:AI_ENGINE_VERSION,scanIntervalMs:AI_FAST_SCAN_MS,feedMode,brokerConnected:brokerFeedFresh(),bid:live.bid,ask:live.ask,spread:live.spread,livePrice:live.price,executionPrice:(selectedOpportunity?.entryMode==='LIMIT' || (!selectedOpportunity && setupReady && !retestOk))?entry:(signal==='BUY'?live.executionBuy:signal==='SELL'?live.executionSell:null),quoteExecutionPrice:signal==='BUY'?live.executionBuy:signal==='SELL'?live.executionSell:null,executionSide:signal==='BUY'?'ASK':signal==='SELL'?'BID':null,brokerDigits:live.digits,source:live.source,sourceDetail:live.sourceDetail,priceAsOf:live.priceAsOf,priceAgeSec:live.ageSec,stalePrice:live.stale,candleAgeSec:Math.round(candleAgeSec),timestamp:Date.now(),signal,phase,bias:macroBias,confidence:effectiveScore,aiScore:directionScore,directionScore,directionBand,setupGrade,status,actionable:signal==='BUY'?'BUY':signal==='SELL'?'SELL':'NO TRADE',entry,entryZone:selectedOpportunity?.entryZone || (setupReady?{...candidateZone,low:round2(candidateZone.low),high:round2(candidateZone.high)}:null),candidateZone:candidateZone?{...candidateZone,low:round2(candidateZone.low),high:round2(candidateZone.high)}:null,stopLoss:sl,takeProfit:tp,trigger,executionTimeframe:(selectedOpportunity?.key || (setupReady?'M5':'—')),entryMode:selectedOpportunity?.entryMode || (setupReady?(retestOk?'MARKET':'LIMIT'):'WATCH'),opportunities:{M5:horizon5,M15:horizon15,H1:horizon60},microTiming:{timeframe:'M1',bias:tfs.M1?.structure?.bias || 'UNAVAILABLE',rsi:tfs.M1?.rsi ?? null,macd:tfs.M1?.macd ?? null,liquidity:tfs.M1?.liquiditySweep || null,structure:tfs.M1?.structure || null},bestOpportunity:selectedOpportunity,macroBias,availableHtf,score:{bull:directionScore>=50?directionScore:0,bear:directionScore<50?100-directionScore:0,confidence:effectiveScore,aiScore:directionScore,directionScore,directionBand,confluence:effectiveScore,grade:setupGrade,items:scoreItems,blockedReasons:reasons},dataQuality:{score:dataQuality,grade:dataQualityGrade,items:dataQualityItems,minRequired:AI_DATA_QUALITY_MIN},setupScore:effectiveScore,confirmations,ict:{liquiditySweep:sweep,mss:execStruct.mss,bos:execStruct.bos,fvg:f,orderBlock:ob,premiumDiscount},news,timeframes:tfs,mtf:{coreTimeframes:CORE_MTF_TFS,fullTimeframes:FULL_MTF_TFS,coreBiases,fullBiases,coreBull,coreBear,fullBull,fullBear,fullMtfCount,fullMtfAvailable,d1Bias,requiredAlignment:MIN_MTF_ALIGNMENT},decision:{state:((setupReady || !!selectedOpportunity) && !newsBlocked)?(signal==='BUY'?'CONFIRMED_BUY':'CONFIRMED_SELL'):(side==='NEUTRAL'?'NO_TRADE':'WAIT'),reason:(setupReady || selectedOpportunity)?trigger:reasons.join(' | '),mandatoryGates:['News not in live/lock/post-news window','At least one valid opportunity horizon (M5/M15/H1)','MTF alignment','ICT structure break (MSS or BOS) + liquidity','Risk/Reward >= 1.5','Aligned FVG/OB','Displacement or momentum','Premium/Discount alignment','Spread <= max','Confluence >= threshold','Retest or valid LIMIT zone'],passed:(setupReady || !!selectedOpportunity) && !newsBlocked,evidenceSummary:{passed:scoreItems.filter(x=>x.passed).map(x=>x.label),waiting:scoreItems.filter(x=>!x.passed).map(x=>x.label),dataQuality:dataQualityGrade}},
aiReasoning:{
  direction:macroBias,
  confidence:effectiveScore,
  summary: (setupReady || selectedOpportunity) && !newsBlocked
    ? (selectedOpportunity ? selectedOpportunity.reason : `All defined execution gates passed for ${side}.`)
    : `${reasons.slice(0,4).join('; ') || 'Waiting for additional confirmation.'}`,
  fullMtf:`${fullMtfCount}/6`,
  coreMtf:`${mtfCount}/3`,
  newsState:news?.state || 'UNAVAILABLE'
},
performance:{analysisMs:Date.now()-analysisStartedAt,cacheMs:ANALYSIS_CACHE_MS,scanIntervalMs:AI_FAST_SCAN_MS},
riskNote:'No system can guarantee profit or prevent losses. This engine blocks entries unless all defined confirmation gates pass. Verify broker price, spread, size and risk before any order.'};
  // v7.3 Manual Smart Signal mode:
  // Server analyzes; Telegram alerts; the trader manually opens the position.
  // MT5 EA may manage manual XAUUSD positions with step-based +2.00 account-currency trailing.
  result.tradeMode = 'MANUAL_SIGNAL_ONLY';
  result.executionPolicy = {
    autoEntry: false,
    manualEntry: true,
    allowedLots: [0.01, 0.02, 0.05, 0.10],
    defaultLots: [0.01, 0.02],
    largeLotRequiresManualConfirmation: true,
    scanIntervalMs: 60000,
    trailing: {
      enabled: true,
      stepProfitMoney: 2.00,
      rule: 'BUY: SL moves upward; SELL: SL moves downward; each new step protects the previous profit step.'
    }
  };
  result.mtfTopDown = {
    order: ['H4','H1','M15','M5','M1'],
    roles: {
      H4: 'macro bias',
      H1: 'primary trend',
      M15: 'setup confirmation',
      M5: 'entry setup',
      M1: 'entry trigger'
    }
  };
  result.zoneRadar=buildZoneRadar(result);
  result.longTerm=buildLongTermRadar(result);
  result.entryTiming=result.zoneRadar.entryTiming;
  result.referenceZone=result.zoneRadar.referenceZone;
  analysisCache.key = `${brokerFeed.receivedAt}:${bridgeNews.receivedAt}:${newsCache.at}`;
  analysisCache.at = Date.now();
  analysisCache.data = result;
  return result;
}

function buildLongTermRadar(a) {
  const live=Number(a?.livePrice);
  const tfs=a?.timeframes||{};
  const macroBias=String(tfs.W1?.structure?.bias || tfs.D1?.structure?.bias || tfs.H4?.structure?.bias || a?.bias || 'NEUTRAL').toUpperCase();
  const candidates=[];
  const add=(tf,obj,type)=>{
    if(!obj || !Number.isFinite(Number(obj.low)) || !Number.isFinite(Number(obj.high))) return;
    const low=Math.min(Number(obj.low),Number(obj.high)), high=Math.max(Number(obj.low),Number(obj.high));
    const width=high-low;
    const dist=zoneDistance(live,{low,high});
    const atr=Number(tfs[tf]?.atr||0);
    const near=zoneContains(live,{low,high}) || dist<=Math.max(atr*1.25,2);
    const direction=String(obj.type||obj.bias||macroBias).toUpperCase();
    candidates.push({timeframe:tf,type,low:round2(low),high:round2(high),width:round2(width),direction:direction.includes('BEAR')?'BEARISH':direction.includes('BULL')?'BULLISH':macroBias,inside:zoneContains(live,{low,high}),near,distance:round2(dist),source:'VT Markets MT5 closed candles'});
  };
  for(const tf of ['W1','D1','H4']) {
    const x=tfs[tf];
    if(!x) continue;
    if(x.fvg?.found) add(tf,x.fvg,'FVG');
    if(x.orderBlock?.found) add(tf,x.orderBlock,'ORDER BLOCK');
  }
  candidates.sort((x,y)=>(x.near===y.near?x.distance-y.distance:(x.near?-1:1)));
  const top=candidates.slice(0,8);
  const aligned=(macroBias==='BULLISH'&&['BULLISH'].includes(String(tfs.D1?.structure?.bias||'')))||(macroBias==='BEARISH'&&['BEARISH'].includes(String(tfs.D1?.structure?.bias||'')));
  let state='WAIT';
  if(top.some(z=>z.inside) && aligned) state='LONG-TERM WATCH';
  if(top.some(z=>z.near) && aligned) state='LONG-TERM SETUP NEAR';
  return {mode:'LONG_TERM',macroBias,weeklyBias:tfs.W1?.structure?.bias||'UNAVAILABLE',dailyBias:tfs.D1?.structure?.bias||'UNAVAILABLE',h4Bias:tfs.H4?.structure?.bias||'UNAVAILABLE',state,zones:top,holdingHorizon:'H4 → D1 → W1',entryRule:'Do not enter from long-term zone alone. Wait for M15/M5 liquidity sweep + MSS/BOS + displacement + RR gate.',note:'Long-term zones are dynamic and recalculated from broker-native MT5 closed candles. W1 is optional; D1/H4 remain authoritative when W1 history is unavailable.'};
}

function zoneBiasFromEvidence(a, zone) {
  const live=Number(a?.livePrice);
  const bias=String(a?.bias || 'NEUTRAL').toUpperCase();
  const signal=String(a?.signal || 'WAIT').toUpperCase();
  const inside=zoneContains(live, zone);
  const distance=zoneDistance(live, zone);
  const atr=Number(a?.timeframes?.M5?.atr || a?.timeframes?.M15?.atr || 0);
  const near=inside || distance <= Math.max(atr*ZONE_PROXIMITY_ATR, 2);
  const ictSide=signal==='BUY'?'BULLISH':signal==='SELL'?'BEARISH':bias;
  let direction='WAIT';
  let reason='No confirmed direction for this zone';
  if (inside) {
    if (signal==='BUY' && a?.confirmations?.allGatesPassed===true) { direction='BULLISH'; reason='Price is inside zone and broker-native BUY gates are confirmed'; }
    else if (signal==='SELL' && a?.confirmations?.allGatesPassed===true) { direction='BEARISH'; reason='Price is inside zone and broker-native SELL gates are confirmed'; }
    else if (bias==='BULLISH' || bias==='BEARISH') { direction=bias; reason=`Price is inside zone; ${bias} is the current MTF bias, but entry confirmation is pending`; }
  } else if (near) {
    if (bias==='BULLISH' && zone.high <= live) { direction='BULLISH'; reason='Bullish discount/pullback zone is near price'; }
    else if (bias==='BEARISH' && zone.low >= live) { direction='BEARISH'; reason='Bearish premium/retest zone is near price'; }
    else if (signal==='BUY' || signal==='SELL') { direction=ictSide; reason=`Zone is near price and current execution side is ${ictSide}`; }
  } else if (bias==='BULLISH' && zone.high < live) {
    direction='BULLISH'; reason='Zone is below live price and aligned with bullish pullback logic';
  } else if (bias==='BEARISH' && zone.low > live) {
    direction='BEARISH'; reason='Zone is above live price and aligned with bearish retest logic';
  }
  return {direction,inside,near,distance:round2(distance),reason};
}

function zoneProfile(a, zone, label='ZONE') {
  if (!zone || !Number.isFinite(Number(zone.low)) || !Number.isFinite(Number(zone.high))) return null;
  const low=Math.min(Number(zone.low),Number(zone.high)), high=Math.max(Number(zone.low),Number(zone.high));
  const width=round2(high-low);
  const atr=Number(a?.timeframes?.M5?.atr || a?.timeframes?.M15?.atr || 0);
  const rangeType=width <= Math.max(2, atr*0.75) ? 'SHORT' : 'LONG';
  const evidence=zoneBiasFromEvidence(a,{low,high});
  const confirmed=['BUY','SELL'].includes(String(a?.signal||'')) && a?.confirmations?.allGatesPassed===true;
  let entryTiming='WAIT — confirmation pending';
  if (confirmed) entryTiming=String(a.entryMode||'MARKET').toUpperCase()==='MARKET' ? 'NOW — broker-native confirmation passed' : 'LIMIT — wait for zone touch + M1 confirmation';
  else if (evidence.near) entryTiming='NEAR — wait for fresh M1 sweep + MSS/BOS + displacement';
  return {label,low:round2(low),high:round2(high),width,rangeType,direction:evidence.direction,inside:evidence.inside,near:evidence.near,distance:evidence.distance,reason:evidence.reason,entryTiming};
}

function buildZoneRadar(a) {
  const hasReference=Number.isFinite(EX_ZONE_LOW)&&Number.isFinite(EX_ZONE_HIGH);
  const reference=hasReference?zoneProfile(a,{low:EX_ZONE_LOW,high:EX_ZONE_HIGH},'EX ZONE'):null;
  const zones=[];
  if(reference) zones.push(reference);
  const seen=new Set(reference?[`${EX_ZONE_LOW}:${EX_ZONE_HIGH}`]:[]);
  for(const [key,o] of Object.entries(a?.opportunities||{})) {
    if (!o?.entryZone) continue;
    const k=`${Number(o.entryZone.low)}:${Number(o.entryZone.high)}`;
    if(seen.has(k)) continue;
    seen.add(k);
    zones.push(zoneProfile(a,o.entryZone,`${key} ${o.entryZone.type||'ZONE'}`));
  }
  if (a?.candidateZone) {
    const k=`${Number(a.candidateZone.low)}:${Number(a.candidateZone.high)}`;
    if(!seen.has(k)) zones.push(zoneProfile(a,a.candidateZone,`ENGINE ${a.candidateZone.type||'ZONE'}`));
  }
  const confirmed=['BUY','SELL'].includes(String(a?.signal||'')) && a?.confirmations?.allGatesPassed===true;
  const entryTiming = confirmed
    ? (String(a.entryMode||'MARKET').toUpperCase()==='MARKET' ? 'NOW — confirmed market entry' : 'LIMIT — enter only after price reaches the calculated zone')
    : 'WAIT — no exact future clock time is guaranteed; enter only after live confirmation';
  const scanTimeLocal=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Phnom_Penh',dateStyle:'short',timeStyle:'medium'}).format(new Date(a?.timestamp||Date.now()));
  return {
    referenceZone:reference,
    zones,
    longTerm:buildLongTermRadar(a),
    direction: String(a?.signal||'WAIT')==='BUY'?'BULLISH':String(a?.signal||'WAIT')==='SELL'?'BEARISH':String(a?.bias||'NEUTRAL'),
    entryTiming,
    scanTimeLocal,
    exactClockForecast:false,
    note:'Entry timing is event-based, not a guaranteed clock-time forecast. Zones are recalculated from live VT Markets MT5 candles/quote.'
  };
}

function formatPrice(n) {
  return Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '—';
}

function mtfPreviewLevels(tf, a, t, side, zone) {
  if (!zone || !Number.isFinite(Number(zone.low)) || !Number.isFinite(Number(zone.high))) return null;
  const low=Math.min(Number(zone.low),Number(zone.high));
  const high=Math.max(Number(zone.low),Number(zone.high));
  const digits=Number.isFinite(Number(a?.brokerDigits)) ? Number(a.brokerDigits) : 2;
  const atrValue=Number(t?.atr || a?.timeframes?.M5?.atr || a?.timeframes?.M15?.atr || 0);
  const buffer=Math.max(atrValue*0.30,0.80);
  const entry=roundToDigits((low+high)/2,digits);
  const sl=side==='BULLISH' ? roundToDigits(low-buffer,digits) : roundToDigits(high+buffer,digits);
  const risk=Math.max(Math.abs(entry-sl),0.50);
  const tp1=roundToDigits(side==='BULLISH'?entry+risk*1.5:entry-risk*1.5,digits);
  const tp2=roundToDigits(side==='BULLISH'?entry+risk*2.5:entry-risk*2.5,digits);
  const tp3=roundToDigits(side==='BULLISH'?entry+risk*3.5:entry-risk*3.5,digits);
  return {zone:{low:round2(low),high:round2(high)},entry,sl,tp:[tp1,tp2,tp3],preview:true};
}

function mtfSignalFromTimeframe(tf, a) {
  const t = a?.timeframes?.[tf];
  const bias = String(t?.structure?.bias || t?.trend || 'NEUTRAL').toUpperCase();

  // A confirmed opportunity remains the only source of an actionable entry.
  // For the MTF dashboard we also show a directional WATCH setup when the
  // timeframe has a real ICT FVG/OB zone but its confirmation gates are not ready.
  const op = a?.opportunities?.[tf];
  if (op && (op.signal === 'BUY' || op.signal === 'SELL')) {
    const side=op.signal;
    if (op.entryZone && Number.isFinite(Number(op.entry)) && Number.isFinite(Number(op.stopLoss))) {
      return {
        signal: side,
        zone: op.entryZone,
        entry: op.entry,
        sl: op.stopLoss,
        tp: Array.isArray(op.takeProfit) ? op.takeProfit : [],
        score: op.score,
        state: op.state === 'CONFIRMED' ? 'CONFIRMED' : 'WATCH'
      };
    }
    const preview=mtfPreviewLevels(tf,a,t,side,op.entryZone);
    if(preview) return {signal:side,...preview,score:op.score,state:op.state==='CONFIRMED'?'CONFIRMED':'WATCH'};
  }

  if (bias === 'BULLISH' || bias === 'BEARISH') {
    const side=bias;
    const fvg=t?.fvg?.found && String(t.fvg.type).toUpperCase()===side ? t.fvg : null;
    const ob=t?.orderBlock?.found && String(t.orderBlock.type).toUpperCase()===side ? t.orderBlock : null;
    const zone=fvg || ob;
    const preview=mtfPreviewLevels(tf,a,t,side,zone);
    if(preview) return {signal:side,...preview,score:null,state:'WATCH'};
    return {signal:side,state:'WATCH'};
  }

  return { signal: 'SIDEWAY', state: 'RANGE' };
}

function telegramMtfText(a) {
  const order = ['H4', 'H1', 'M15', 'M5', 'M1'];
  const lines = [];
  for (const tf of order) {
    const s=mtfSignalFromTimeframe(tf,a);
    const label=tf;
    if (s.signal==='BUY' || s.signal==='SELL') {
      const icon=s.signal==='BUY'?'🟢':'🔴';
      const sideName=s.signal==='BUY'?'Buy':'Sell';
      const zone=s.zone && Number.isFinite(Number(s.zone.low)) && Number.isFinite(Number(s.zone.high))
        ? `${formatPrice(s.zone.low)} – ${formatPrice(s.zone.high)}` : '—';
      const state=s.state==='CONFIRMED'?'CONFIRMED':'WATCH — confirmation pending';
      lines.push(
        `${icon} *${label} ${s.signal}* — ${state}`,
        `${sideName} Zone: *${zone}*`,
        `Entry: *${formatPrice(s.entry)}*`,
        `SL: *${formatPrice(s.sl)}*`,
        `TP1: *${formatPrice(s.tp?.[0])}*`,
        `TP2: *${formatPrice(s.tp?.[1])}*`,
        `TP3: *${formatPrice(s.tp?.[2])}*`,
        ''
      );
    } else {
      lines.push(
        `🟡 *${label} SIDEWAY*`,
        `No Trade`,
        ''
      );
    }
  }
  return lines.join('\n').trim();
}

function telegramWaitText(a) {
  const score = Number(a?.directionScore ?? a?.aiScore ?? 0);
  const bias = String(a?.bias || a?.directionBand || 'NEUTRAL').toUpperCase();
  const blocked = Array.isArray(a?.score?.blockedReasons)
    ? a.score.blockedReasons.slice(0, 6)
    : [];

  return `🟡 *V TRADE AI — XAUUSD WAIT*\n\n` +
    `Price: *${formatPrice(a?.livePrice ?? a?.bid)}*\n` +
    `Bias: *${bias}*\n` +
    `Direction Score: *${score}/100*\n` +
    `Confidence: *${Number(a?.confidence ?? 0)}/100*\n` +
    `Status: *${a?.status || 'NO TRADE — confirmation pending'}*\n` +
    `AI Confirm: *${a?.aiConfirmation?.decision || 'NOT RUN'}* | Confidence: *${a?.aiConfirmation?.confidence ?? '—'}/100* | Agreement: *${a?.aiConfirmation?.agreement || '—'}*\n\n` +
    `*MTF LIVE SIGNALS*\n\n` +
    `${telegramMtfText(a)}\n\n` +
    `Waiting for:\n` +
    `${blocked.length
      ? blocked.map(x => `• ${x}`).join('\n')
      : '• Final ICT entry confirmation'}\n\n` +
    `⚠️ WAIT only — no order is authorized until all entry gates pass.\n` +
    `Broker: *VT Markets MT5* | Quote age: *${a?.priceAgeSec ?? '—'}s*`;
}

function telegramText(a) {
  const o=a?.bestOpportunity;
  const actionable =
    ['BUY','SELL'].includes(a?.signal) &&
    String(a?.status || '').includes('ENTRY CONFIRMED') &&
    Number.isFinite(Number(a?.entry)) &&
    (!!o || a?.confirmations?.allGatesPassed === true);

  if (!actionable) return telegramWaitText(a);

  const icon=a.signal==='BUY'?'🟢':'🔴';
  const side=a.signal==='BUY'?(a.entryMode==='LIMIT'?'BUY LIMIT':'BUY NOW'):(a.entryMode==='LIMIT'?'SELL LIMIT':'SELL NOW');
  const quoteSide=a.executionSide || (a.signal==='BUY'?'ASK':'BID');
  const tp=a.takeProfit || [];
  return `${icon} *V TRADE AI — XAUUSD*\n\n`+
    `*${side}*\n`+
    `Entry: *${a.entry}* (${quoteSide})\n`+
    `SL: *${a.stopLoss}*\n`+
    `TP1: *${tp[0] ?? '—'}*\n`+
    `TP2: *${tp[1] ?? '—'}*\n`+
    `TP3: *${tp[2] ?? '—'}*\n`+
    `TP4: *${tp[3] ?? '—'}*\n\n`+
    `Mode: *${a.entryMode || 'MARKET'}*\n`+`Broker: *VT Markets MT5*\n`+
    `Quote age: *${a.priceAgeSec ?? '—'}s* | Spread: *${a.spread ?? '—'}*\n`+
    `AI Score: *${a.directionScore ?? a.aiScore ?? 50}/100* | Bias: *${a.directionBand || a.bias || 'NEUTRAL'}*\n`+`Confluence: *${a.confidence}/100* | TF: *${a.executionTimeframe}* | RR: *${o?.riskReward ?? '—'}*\n`+
    `AI Confirm: *${a.aiConfirmation?.decision || 'NOT RUN'}* | Confidence: *${a.aiConfirmation?.confidence ?? '—'}/100* | Agreement: *${a.aiConfirmation?.agreement || '—'}*\n`+
    `EX Zone: *${a.referenceZone ? `${a.referenceZone.low}–${a.referenceZone.high}` : 'Dynamic — AI calculated'}* | Bias: *${a.referenceZone?.direction ?? a.bias}* | ${a.referenceZone?.rangeType ?? 'DYNAMIC'} zone\n`+
    `Entry timing: *${a.entryTiming || 'WAIT'}*\n`+
    `Time: *${a.priceAsOf || new Date().toISOString()}*\n\n`+
    `⚠️ Broker-native quote at scan time. Verify MT5 quote/spread before execution.`;
}

async function maybeTelegramAlert(a, tg, sessionId) {
  if (!tg || !tg.bot || !tg.chatId) return false;
  const dedupeKey=sessionId || `env:${tg.chatId}`;
  let sent=false;

  // News alerts are state-change based: CLEAR -> SOON, SOON -> LIVE, LIVE -> POST-NEWS, etc.
  // This gives the user a real warning without spamming every 15-second scan.
  if (TELEGRAM_NEWS_ALERTS && a.news?.available !== false) {
    const newsKey=`${a.news?.state || 'UNAVAILABLE'}:${a.news?.next?.timestamp || '-'}:${a.news?.previous?.timestamp || '-'}`;
    if (telegramNewsKeys.get(dedupeKey) !== newsKey) {
      const interesting=['CAUTION','LOCK','LIVE','POST_NEWS'].includes(a.news?.state);
      if (interesting) {
        const icon=a.news.state==='LIVE'?'🔴':a.news.state==='POST_NEWS'?'🟣':'🟠';
        const title=a.news.next?.title || a.news.previous?.title || 'USD High Impact News';
        const timing=a.news.state==='LIVE'?'NOW':a.news.state==='POST_NEWS'?`${a.news.sincePreviousMin ?? 0} min ago`:`in ${a.news.deltaMin ?? '?'} min`;
        await tg.bot.sendMessage(tg.chatId,`${icon} V TRADE AI — XAUUSD NEWS ALERT\n\nEvent: ${title}\nState: ${a.news.label}\nTiming: ${timing}\nAction: NO NEW ENTRY — wait for price reaction + ICT confirmation.`);
        sent=true;
      }
      telegramNewsKeys.set(dedupeKey,newsKey);
    }
  }

  // Reference-zone radar: state-change based, so it does not spam every scan.
  if (ZONE_ALERT_ENABLED && a?.zoneRadar?.referenceZone) {
    const z=a.zoneRadar.referenceZone;
    const state=`${z.direction}:${z.inside?'IN':z.near?'NEAR':'FAR'}:${a.signal}:${a.entryMode}`;
    if (telegramZoneKeys.get(dedupeKey)!==state && (z.inside || z.near)) {
      const icon=z.direction==='BULLISH'?'🟢':z.direction==='BEARISH'?'🔴':'🟡';
      const msg=`${icon} V TRADE AI — XAUUSD ZONE RADAR\n\n`+
        `EX Zone: ${z.low}–${z.high}\n`+
        `AI Direction: ${z.direction}\n`+
        `Zone Type: ${z.rangeType}\n`+
        `Distance: ${z.distance}\n`+
        `Status: ${z.inside?'PRICE INSIDE ZONE':'PRICE NEAR ZONE'}\n`+
        `Timing: ${z.entryTiming}\n`+
        `Reason: ${z.reason}\n\n`+
        `⚠️ Zone alert is not an entry order. Wait for live ICT confirmation.`;
      await tg.bot.sendMessage(tg.chatId,msg);
      sent=true;
    }
    telegramZoneKeys.set(dedupeKey,state);
  }

  // Entry alerts remain strict and deduplicated.
  const o=a?.bestOpportunity;
  const actionable = ['BUY','SELL'].includes(a.signal) && (a.status === 'ENTRY CONFIRMED' || String(a.status||'').includes('ENTRY CONFIRMED')) && Number.isFinite(Number(a.entry)) && (!!o || a.confirmations?.allGatesPassed === true);
  const aiGateRequired = OPENAI_ENABLED && !!OPENAI_API_KEY;
  const aiGateOk = !aiGateRequired || (
    a.aiConfirmation?.status === 'ok' &&
    a.aiConfirmation?.gate?.finalSignal === a.signal &&
    a.aiConfirmation?.agreement === 'AGREE' &&
    Number(a.aiConfirmation?.confidence) >= OPENAI_MIN_SCORE
  );
  const aiScore=Number(a.directionScore ?? a.aiScore ?? 50);
  const buyScoreMin=80;
  const sellScoreMax=19;
  const directionScoreOk=(a.signal==='BUY' && aiScore>=buyScoreMin) || (a.signal==='SELL' && aiScore<=sellScoreMax);
  if(actionable && directionScoreOk && aiGateOk && (!o || o.state==='CONFIRMED')) {
    const key=`${a.signal}:${a.status}:${a.entryZone?.low ?? '-'}:${a.entryZone?.high ?? '-'}:${a.entry ?? '-'}:${a.stopLoss ?? '-'}:${(a.takeProfit||[]).join(',')}`;
    if(telegramAlertKeys.get(dedupeKey)!==key) {
      telegramAlertKeys.set(dedupeKey,key);
      await tg.bot.sendMessage(tg.chatId,telegramText(a));
      sent=true;
    }
  }
  return sent;
}

let telegramAutoLastReadinessLog = '';
let telegramAutoLastState = '';
let telegramAutoLastWaitKey = '';
let telegramAutoLastWaitSentAt = 0;
const TELEGRAM_WAIT_ALERT_COOLDOWN_MS = Math.max(
  60000,
  Number(process.env.TELEGRAM_WAIT_ALERT_COOLDOWN_MS || 15 * 60 * 1000)
);

function telegramAutoReadinessSnapshot() {
  const q=brokerFeed.quote;
  const ageSec=q ? Math.max(0,Math.round((Date.now()-brokerFeed.receivedAt)/1000)) : null;
  const required=['M5','M15','H1','H4'];
  const frames={};
  for (const tf of required) {
    const arr=brokerFeed.timeframes?.[tf];
    frames[tf]=Array.isArray(arr)?arr.length:0;
  }
  const connected=brokerFeedFresh();
  const ready=connected && required.every(tf=>frames[tf]>=30);
  return {ready,connected,ageSec,frames};
}

async function runTelegramAutoAlertScan() {
  if (!TELEGRAM_AUTO_ALERT_ENABLED || !bot || !TELEGRAM_CHAT_ID || telegramAutoAlertRunning) return;
  telegramAutoAlertRunning = true;
  try {
    const r=telegramAutoReadinessSnapshot();
    const readinessKey=`${r.ready?'READY':'NOT_READY'}:${r.connected?'CONNECTED':'DISCONNECTED'}:${r.frames.M5}:${r.frames.M15}:${r.frames.H1}:${r.frames.H4}`;
    if (readinessKey !== telegramAutoLastReadinessLog) {
      if (r.ready) {
        console.log(`[TELEGRAM AUTO] MT5 READY | ageSec=${r.ageSec} | M5=${r.frames.M5} M15=${r.frames.M15} H1=${r.frames.H1} H4=${r.frames.H4}`);
      } else {
        console.warn(`[TELEGRAM AUTO] Waiting for MT5 MTF | connected=${r.connected} ageSec=${r.ageSec===null?'null':r.ageSec} | M5=${r.frames.M5} M15=${r.frames.M15} H1=${r.frames.H1} H4=${r.frames.H4}`);
      }
      telegramAutoLastReadinessLog=readinessKey;
    }
    if (!r.ready) return;

    const a = await buildXauAnalysis();
    // Run the independent AI confirmation on every auto scan. The deterministic ICT/MTF engine
    // remains authoritative; AI can only confirm or veto an already-qualified BUY/SELL.
    const ai = OPENAI_ENABLED ? await openAIConfirmXauAnalysis(a) : {enabled:false,configured:!!OPENAI_API_KEY,model:OPENAI_MODEL,status:'disabled'};
    a.aiConfirmation = ai;
    if (OPENAI_ENABLED && OPENAI_API_KEY) {
      console.log(`[AI CONFIRM] status=${ai.status} decision=${ai.decision} confidence=${ai.confidence ?? 0} agreement=${ai.agreement || 'NEUTRAL'} final=${ai.gate?.finalSignal || 'WAIT'}`);
    }
    const tg = { bot, chatId: TELEGRAM_CHAT_ID, botUsername: 'ENV_AUTO' , session: false };
    const dedupeKey=`env:${TELEGRAM_CHAT_ID}`;
    let sent = await maybeTelegramAlert(a, tg, dedupeKey);

    // Telegram AUTO is entry-only. WAIT/bias/watch states are logged locally
    // but are never broadcast. maybeTelegramAlert() remains responsible for
    // confirmed BUY/SELL alerts only.

    // State logging is also stable: score/status/price changes alone do not count as a new state.
    const stateKey=`${a.signal}:${a.bias || 'NEUTRAL'}:${a.confirmations?.allGatesPassed===true?'PASS':'WAIT'}`;
    if (stateKey !== telegramAutoLastState) {
      if (sent) console.log(`[TELEGRAM AUTO] Alert sent | signal=${a.signal} | score=${a.directionScore ?? a.aiScore ?? '-'} | status=${a.status}`);
      else console.log(`[TELEGRAM AUTO] Scan OK | signal=${a.signal} | bias=${a.bias} | score=${a.directionScore ?? a.aiScore ?? '-'} | status=${a.status} | gates=${a.confirmations?.allGatesPassed===true?'PASS':'WAIT'}`);
      telegramAutoLastState=stateKey;
    }
  } catch (e) {
  // Fail closed: never manufacture an alert. Log the exact readiness/analysis reason.
  const msg = String(e?.message || e);

  console.warn('[TELEGRAM AUTO] Scan blocked:', msg);
  telegramAutoLastState = msg;
} finally {
  telegramAutoAlertRunning = false;
}
}
app.get('/api/v5/news/diagnostics', async (_req,res) => {
  try {
    const news = await fetchXauNews();
    res.json({success:true,version:APP_VERSION,news,health:{...newsHealth,now:new Date().toISOString()},bridge:{available:Array.isArray(bridgeNews.items),ageSec:bridgeNews.receivedAt ? Math.round((Date.now()-bridgeNews.receivedAt)/1000) : null,source:bridgeNews.source}});
  } catch (e) {
    res.status(500).json({success:false,error:'News diagnostics unavailable'});
  }
});

app.get('/health',(_req,res)=>res.json({ok:true,version:APP_VERSION,service:'vtrade-ai'}));
app.get('/api/storage/status', async (_req,res)=>{ try { res.json({success:true, ...(await storage.getStatus())}); } catch(e) { res.status(500).json({success:false,error:'Storage status unavailable'}); } });
app.get('/api/storage/history', adminOnlyLimit, requireAdmin, async (req,res)=>{ try { const type=String(req.query.type||'analysis'); const limit=Number(req.query.limit||50); res.set('Cache-Control','no-store'); res.json({success:true,type,items:await storage.getHistory({type,limit})}); } catch(e) { res.status(500).json({success:false,error:'Storage history unavailable'}); } });
app.get('/api/health',(req,res)=>{
  const tg = activeTelegramConfig(req);
  res.json({
    ok:true,
    version:APP_VERSION,
    telegramConfigured:!!tg,
    telegramMode:getSessionConfig(req)?'user-session':(bot&&TELEGRAM_CHAT_ID?'env-fallback':'not-configured'),
    ai:{enabled:OPENAI_ENABLED,configured:!!OPENAI_API_KEY,model:OPENAI_MODEL},
    ictEngine:'mtf-v3-smart-entry-radar-vtmarkets-mt5',
    dataFeed:'VT Markets MT5 bridge (broker-native, authoritative for XAUUSD signals)',
    mt5Connected:brokerFeedFresh(),
    mt5AgeSec:brokerFeed.quote ? Math.round((Date.now()-brokerFeed.receivedAt)/1000) : null,
    render:!!process.env.RENDER,
    news:{state:newsCache.data?.state||'UNAVAILABLE',available:newsCache.data?.available===true,trusted:newsCache.data?.trusted===true,source:newsCache.data?.source||null,ageSec:newsCache.data?.verifiedAt?Math.round((Date.now()-newsCache.data.verifiedAt)/1000):null}
  });
});

function isAllowedXauSymbol(symbol) {
  const incoming = String(symbol || '').trim().toUpperCase();
  const configured = String(process.env.MT5_SYMBOL || 'XAUUSD').trim().toUpperCase();
  // VT Markets may append a suffix (e.g. XAUUSD-STDc). Keep the bridge XAU-only.
  if (!incoming || !incoming.startsWith('XAUUSD')) return false;
  if (configured === 'XAUUSD') return true;
  return incoming === configured;
}

app.post('/api/v5/news/calendar', (req,res) => {
  try {
    if (!MT5_BRIDGE_API_KEY || req.get('x-vtrade-key') !== MT5_BRIDGE_API_KEY) return res.status(401).json({success:false,error:'Unauthorized'});
    const items = req.body?.events || req.body?.items || req.body?.calendar;
    if (!Array.isArray(items)) return res.status(400).json({success:false,error:'events/items/calendar array is required'});
    bridgeNews.items = items.slice(0,500);
    bridgeNews.receivedAt = Date.now();
    bridgeNews.source = String(req.body?.source || 'MT5 News Calendar');
    newsCache.at = 0; newsCache.data = null; analysisCache.key=''; analysisCache.data=null;
    res.json({success:true,received:bridgeNews.items.length,receivedAt:bridgeNews.receivedAt});
  } catch(e) { res.status(400).json({success:false,error:'Invalid news calendar payload'}); }
});

app.post('/api/v5/mt5/quote', (req,res) => {
  try {
    if (!MT5_BRIDGE_API_KEY || req.get('x-vtrade-key') !== MT5_BRIDGE_API_KEY) return res.status(401).json({success:false,error:'Unauthorized'});
    const q=req.body || {};
    if (!isAllowedXauSymbol(q.symbol)) return res.status(400).json({success:false,error:'Unsupported symbol'});
    const bid=Number(q.bid), ask=Number(q.ask), last=Number(q.last), serverTimeRaw=Number(q.serverTime);
    const serverTime = Number.isFinite(serverTimeRaw) && serverTimeRaw > 0 ? (serverTimeRaw < 1e12 ? serverTimeRaw*1000 : serverTimeRaw) : Date.now();
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid<=0 || ask<=0 || ask<bid) return res.status(400).json({success:false,error:'Invalid quote'});
    const receivedAt = Date.now();
    const incomingFrames = q.timeframes || q.bars || {};
    if (!incomingFrames || typeof incomingFrames !== 'object') {
      return res.status(400).json({success:false,error:'Invalid MT5 timeframe payload'});
    }

    brokerFeed.quote={
      bid, ask, last,
      spread:Number.isFinite(Number(q.spread)) ? Number(q.spread) : ask-bid,
      serverTime
    };
    // Python bridge v2 sends MTF candles under `bars`; older builds used `timeframes`.
    brokerFeed.timeframes=incomingFrames;
    brokerFeed.receivedAt=receivedAt;
    brokerFeed.lastRequestAt=receivedAt;
    brokerFeed.lastServerTime=serverTime;
    brokerFeed.symbol=String(q.symbol);
    brokerFeed.sequence += 1;
    brokerFeed.lastError=null;
    analysisCache.key=''; analysisCache.data=null;
    storage.saveQuote(q).catch(()=>{});

    const frames=['M5','M15','H1','H4'];
    const counts=Object.fromEntries(frames.map(tf=>[
      tf,
      Array.isArray(incomingFrames[tf]) ? incomingFrames[tf].length : 0
    ]));
    console.log(`[MT5 FEED] QUOTE OK | seq=${brokerFeed.sequence} | symbol=${brokerFeed.symbol} | state=READY | M5=${counts.M5} M15=${counts.M15} H1=${counts.H1} H4=${counts.H4}`);
    res.json({
      success:true,
      source:'VT Markets MT5',
      symbol:brokerFeed.symbol,
      receivedAt,
      sequence:brokerFeed.sequence,
      state:'READY',
      ageSec:0,
      counts
    });
  } catch(e){ res.status(400).json({success:false,error:'Invalid MT5 payload'}); }
});

app.get('/api/v5/mt5/readiness',(_req,res)=>{
  const q=brokerFeed.quote;
  const ageSec=q?Math.max(0,Math.round((Date.now()-brokerFeed.receivedAt)/1000)):null;
  const frames={};
  for (const tf of ['M1','M5','M15','H1','H4','D1','W1']) {
    const arr=brokerFeed.timeframes?.[tf];
    frames[tf]={available:Array.isArray(arr)&&arr.length>=30,bars:Array.isArray(arr)?arr.length:0};
  }
  const required=['M5','M15','H1','H4'];
  const ready=brokerFeedFresh() && required.every(tf=>frames[tf].available);
  res.json({success:true,ready,connected:brokerFeedFresh(),feedMode:'VT Markets MT5',symbol:brokerFeed.symbol,ageSec,maxAgeMs:MT5_MAX_AGE_MS,required,frames});
});

app.get('/api/v5/mt5/status',(_req,res)=>{
  const q=brokerFeed.quote;
  const ageMs=brokerFeedAgeMs();
  const state=brokerFeedState();
  const frames=brokerFeed.timeframes || {};
  const required=['M5','M15','H1','H4'];
  const counts=Object.fromEntries(required.map(tf=>[
    tf, Array.isArray(frames[tf]) ? frames[tf].length : 0
  ]));
  const mtfReady=required.every(tf=>counts[tf] > 0);
  res.set('Cache-Control','no-store');
  res.json({
    success:true,
    connected:brokerFeedConnected(),
    fresh:brokerFeedFresh(),
    state,
    mtfReady,
    feedMode:'VT Markets MT5',
    authoritative:true,
    symbol:brokerFeed.symbol,
    ageSec:ageMs===null?null:Math.round(ageMs/1000),
    maxAgeMs:MT5_MAX_AGE_MS,
    connectedMaxAgeMs:MT5_CONNECTED_MAX_AGE_MS,
    sequence:brokerFeed.sequence,
    lastRequestAt:brokerFeed.lastRequestAt || null,
    lastServerTime:brokerFeed.lastServerTime || null,
    serverTimeAgeSec:brokerFeed.lastServerTime ? Math.max(0,Math.round((Date.now()-brokerFeed.lastServerTime)/1000)) : null,
    counts,
    bid:q?.bid??null,
    ask:q?.ask??null,
    spread:q?.spread??null,
    lastError:brokerFeed.lastError
  });
});

app.get('/api/market/xauusd',requireAuth,requirePermission('terminal'),async(_req,res)=>{
  const p=brokerLivePrice();
  if (!p) return res.status(503).json({success:false,error:'VT Markets MT5 feed unavailable or stale'});
  res.json({
    success:true,symbol:'XAUUSD',price:p.price,bid:p.bid,ask:p.ask,spread:p.spread,
    source:p.source,sourceDetail:p.sourceDetail,priceAsOf:p.priceAsOf,
    priceAgeSec:p.ageSec,stale:p.stale,timestamp:Date.now()
  });
});

app.get('/api/v5/news/diagnostics', adminOnlyLimit, requireAdmin, async (_req,res)=>{
  const news = await fetchXauNews();
  res.set('Cache-Control','no-store');
  res.json({
    success:true,
    available:news.available,
    state:news.state,
    label:news.label,
    source:news.source,
    sourceCount:news.sourceCount,
    updatedAt:news.updatedAt,
    sourceAgeSec:news.sourceAgeSec ?? null,
    configuredSources:NEWS_URLS,
    bridge: { available:Array.isArray(bridgeNews.items), ageSec:bridgeNews.receivedAt ? Math.round((Date.now()-bridgeNews.receivedAt)/1000) : null, source:bridgeNews.source },
    failClosed:NEWS_FAIL_CLOSED,
    error:news.error || null,health:{...newsHealth,now:new Date().toISOString()}
  });
});

app.get('/api/news/xauusd',requireAuth,requirePermission('news'), async (_req,res)=>{
  const news=await fetchXauNews();
  res.set('Cache-Control','no-store');
  res.json({success:true,...news});
});

app.get('/api/ai/status',requireAuth,requirePermission('ai'),(_req,res)=>res.json({success:true,enabled:OPENAI_ENABLED,configured:!!OPENAI_API_KEY,model:OPENAI_MODEL,minScore:OPENAI_MIN_SCORE,provider:'OpenAI Responses API'}));

app.get('/api/ai/analysis/xauusd',requireAuth,requirePermission('ai'),async(req,res)=>{
  try {
    const a=await buildXauAnalysis();
    const ai=await openAIConfirmXauAnalysis(a);
    res.set('Cache-Control','no-store');
    res.json({success:true,engine:a,ai});
  } catch(e) { res.status(503).json({success:false,error:'AI analysis temporarily unavailable'}); }
});


function requireMt5Bridge(req, res) {
  if (!MT5_BRIDGE_API_KEY || req.get('x-vtrade-key') !== MT5_BRIDGE_API_KEY) {
    res.status(401).json({success:false,error:'Unauthorized MT5 bridge'});
    return false;
  }
  return true;
}

function autoTradeSignalKey(a) {
  return [
    a?.signal || 'WAIT',
    a?.entryMode || '',
    a?.entry || '',
    a?.stopLoss || '',
    ...(Array.isArray(a?.takeProfit) ? a.takeProfit : [])
  ].join('|');
}

// The EA polls this endpoint. Server-side analysis remains the single source of truth.
app.get('/api/v7/mt5/auto-signal', async (req, res) => {
  if (!requireMt5Bridge(req, res)) return;
  try {
    const now = Date.now();
    autoTradeState.lastHeartbeatAt = now;

    if (!AUTO_TRADE_ENABLED) {
      return res.json({success:true, enabled:false, action:'WAIT', reason:'AUTO_TRADE_ENABLED=false'});
    }
    if (!brokerFeedFresh()) {
      return res.json({success:true, enabled:true, action:'WAIT', reason:'MT5 market feed is stale'});
    }
    if (autoTradeState.openPositions >= AUTO_TRADE_MAX_OPEN) {
      return res.json({success:true, enabled:true, action:'WAIT', reason:'Max open positions reached'});
    }

    const a = await buildXauAnalysis();
    autoTradeState.lastAnalysisAt = now;

    const signal = String(a?.signal || 'WAIT').toUpperCase();
    const score = Number(a?.confidence ?? a?.score ?? 0);
    const entryMode = String(a?.entryMode || 'WATCH').toUpperCase();
    const actionable = a?.actionable === true || a?.setupReady === true;
    const marketOk = !AUTO_TRADE_REQUIRE_MARKET || entryMode === 'MARKET';

    if (!['BUY','SELL'].includes(signal)) {
      return res.json({success:true,enabled:true,action:'WAIT',reason:'No BUY/SELL signal',analysis:a});
    }
    if (score < AUTO_TRADE_MIN_SCORE) {
      return res.json({success:true,enabled:true,action:'WAIT',reason:`Score ${score} below ${AUTO_TRADE_MIN_SCORE}`,analysis:a});
    }
    if (!actionable) {
      return res.json({success:true,enabled:true,action:'WAIT',reason:'Signal is not actionable',analysis:a});
    }
    if (!marketOk) {
      return res.json({success:true,enabled:true,action:'WAIT',reason:'LIMIT signal skipped by AUTO_TRADE_REQUIRE_MARKET',analysis:a});
    }
    if (!Number.isFinite(Number(a.entry)) || !Number.isFinite(Number(a.stopLoss))) {
      return res.json({success:true,enabled:true,action:'WAIT',reason:'Entry/SL unavailable',analysis:a});
    }

    const key = autoTradeSignalKey(a);
    if (key === autoTradeState.lastSignalKey && now - autoTradeState.lastSignalAt < AUTO_TRADE_COOLDOWN_MS) {
      return res.json({success:true,enabled:true,action:'WAIT',reason:'Duplicate/cooldown',analysis:a});
    }

    const lot = Math.min(AUTO_TRADE_MAX_LOT, AUTO_TRADE_LOT);
    const command = {
      id: crypto.randomUUID(),
      createdAt: now,
      expiresAt: now + AUTO_TRADE_SIGNAL_TTL_MS,
      symbol: String(process.env.MT5_SYMBOL || 'XAUUSD'),
      side: signal,
      lot,
      magic: AUTO_TRADE_MAGIC,
      entry: Number(a.entry),
      stopLoss: Number(a.stopLoss),
      takeProfit: Array.isArray(a.takeProfit) ? a.takeProfit.slice(0,4).map(Number).filter(Number.isFinite) : [],
      score,
      timeframe: a.executionTimeframe || 'M5',
      entryMode,
      trailTriggerMoney: AUTO_TRADE_TRAIL_TRIGGER,
      trailDistancePoints: AUTO_TRADE_TRAIL_DISTANCE_POINTS,
      lockProfitMoney: AUTO_TRADE_LOCK_PROFIT
    };

    autoTradeState.lastSignalKey = key;
    autoTradeState.lastSignalAt = now;
    autoTradeState.lastExecution = command;

    return res.json({success:true,enabled:true,action:'OPEN',command,analysis:a});
  } catch (e) {
    console.error('[AUTO-TRADE] signal error:', e.message);
    return res.status(503).json({success:false,error:'Auto-trade signal unavailable'});
  }
});

app.post('/api/v7/mt5/auto-status', (req, res) => {
  if (!requireMt5Bridge(req, res)) return;
  const body = req.body || {};
  autoTradeState.openPositions = Math.max(0, Number(body.openPositions || 0));
  autoTradeState.lastHeartbeatAt = Date.now();
  if (body.lastExecution) autoTradeState.lastExecution = body.lastExecution;
  res.json({
    success:true,
    receivedAt:autoTradeState.lastHeartbeatAt,
    enabled:AUTO_TRADE_ENABLED,
    openPositions:autoTradeState.openPositions,
    maxOpen:AUTO_TRADE_MAX_OPEN,
    lastAnalysisAt:autoTradeState.lastAnalysisAt
  });
});

app.get('/api/v7/mt5/auto-config', (req, res) => {
  if (!requireMt5Bridge(req, res)) return;
  res.json({
    success:true,
    enabled:AUTO_TRADE_ENABLED,
    symbol:String(process.env.MT5_SYMBOL || 'XAUUSD'),
    minScore:AUTO_TRADE_MIN_SCORE,
    lot:AUTO_TRADE_LOT,
    maxLot:AUTO_TRADE_MAX_LOT,
    maxOpen:AUTO_TRADE_MAX_OPEN,
    magic:AUTO_TRADE_MAGIC,
    trailTriggerMoney:AUTO_TRADE_TRAIL_TRIGGER,
    trailDistancePoints:AUTO_TRADE_TRAIL_DISTANCE_POINTS,
    lockProfitMoney:AUTO_TRADE_LOCK_PROFIT,
    requireMarket:AUTO_TRADE_REQUIRE_MARKET
  });
});

app.get('/api/analysis/xauusd',requireAuth,requirePermission('terminal'),async(req,res)=>{
  try {
    if (req.get('x-vtrade-request') && !/^[a-zA-Z0-9._:-]{8,80}$/.test(req.get('x-vtrade-request'))) return res.status(400).json({success:false,error:'Invalid request id'});
    const a=await buildXauAnalysis();
    const tg = activeTelegramConfig(req);
    const sid = sessionIdFrom(req);
    const ai = OPENAI_ENABLED ? await openAIConfirmXauAnalysis(a) : null;
    if (res.headersSent) return;
    res.json({success:true,...a,telegramConfigured:!!tg,aiConfirmation:ai});
    storage.saveAnalysis(a).catch(()=>{});
    maybeTelegramAlert(a, tg, sid).catch(e=>console.error('Telegram alert:',e.message));
  } catch(e) {
    console.error('ICT analysis:',e.message);
    if (!res.headersSent) res.status(503).json({success:false,error:'ICT analysis temporarily unavailable'});
  }
});

app.get('/api/telegram/session',requireAuth,requirePermission('telegram'),(req,res)=>{
  const sid = sessionIdFrom(req) || createSessionId();
  res.set('Cache-Control','no-store');
  res.json({success:true,sessionId:sid,connected:!!telegramSessions.get(sid)});
});

app.get('/api/telegram/status',requireAuth,requirePermission('telegram'),async(req,res)=>{
  const sid=sessionIdFrom(req);
  const tg=getSessionConfig(req);
  if (!tg) {
    return res.json({success:true,connected:false,configured:!!(bot&&TELEGRAM_CHAT_ID),mode:(bot&&TELEGRAM_CHAT_ID)?'env-fallback':'not-configured'});
  }
  res.json({success:true,connected:true,mode:'user-session',botUsername:tg.botUsername,chatId:maskChatId(tg.chatId),connectedAt:tg.connectedAt});
});

app.post('/api/telegram/connect',requireAuth,requirePermission('telegram'),telegramMutationLimit,async(req,res)=>{
  try {
    const token=String(req.body?.token||'').trim();
    const chatId=String(req.body?.chatId||'').trim();
    if (!token || !chatId) return res.status(400).json({success:false,error:'Bot Token and Chat ID are required'});
    if (token.length < 20 || token.length > 200) return res.status(400).json({success:false,error:'Invalid Telegram bot token format'});

    const testBot=new TelegramBot(token,{polling:false});
    const me=await testBot.getMe();
    if (!me?.is_bot) throw new Error('The provided token is not a Telegram bot token');
    const chat=await testBot.getChat(chatId);
    if (!chat?.id) throw new Error('Chat not found. Open the bot and press Start, or add the bot to the group/channel first.');

    const sid=sessionIdFrom(req) || createSessionId();
    setSessionConfig(sid,{
      bot:testBot,
      chatId,
      botUsername:me.username || me.first_name || 'Telegram Bot',
      connectedAt:new Date().toISOString(),
      expiresAt:Date.now()+TELEGRAM_SESSION_TTL_MS
    });
    res.set('Cache-Control','no-store');
    res.json({success:true,sessionId:sid,connected:true,botUsername:me.username||me.first_name||'Telegram Bot',chatId:maskChatId(chatId)});
  } catch(e) {
    console.error('Telegram connect:',e.message);
    if (!res.headersSent) res.status(400).json({success:false,error:e.message||'Telegram connection failed'});
  }
});

app.post('/api/telegram/test',requireAuth,requirePermission('telegram'),telegramMutationLimit,async(req,res)=>{
  try {
    const tg=activeTelegramConfig(req);
    if(!tg) return res.status(400).json({success:false,error:'Telegram is not connected. Enter your Bot Token and Chat ID first.'});
    await tg.bot.sendMessage(tg.chatId,'✅ V TRADE AI Telegram test — connection OK.');
    res.json({success:true,message:'Test message sent'});
  } catch(e){
    console.error('Telegram test:',e.message);
    res.status(500).json({success:false,error:'Telegram test failed. Check that the bot token is valid and the bot can message this chat.'});
  }
});

app.post('/api/telegram/disconnect',requireAuth,requirePermission('telegram'),telegramMutationLimit,(req,res)=>{
  const sid=sessionIdFrom(req);
  if(sid) {
    telegramSessions.delete(sid);
    telegramAlertKeys.delete(sid);
    telegramZoneKeys.delete(sid);
  }
  res.json({success:true,connected:false});
});

app.post('/api/v5/signal',requireAuth,requirePermission('signals'),telegramMutationLimit,async(req,res)=>{
  try {
    const tg = activeTelegramConfig(req);
    if(!tg) return res.status(400).json({success:false,error:'Telegram is not connected. Enter your Bot Token and Chat ID first.'});
    const a = await buildXauAnalysis();
    const requested = String(req.body?.type || '').toUpperCase();
    if (!['BUY','SELL'].includes(requested)) {
      return res.status(409).json({success:false,error:'Telegram Entry alert accepts BUY or SELL only. WAIT is never broadcast as an entry.',analysis:a});
    }
    if (requested !== a.signal || !String(a.status || '').includes('ENTRY CONFIRMED') || a.confirmations?.allGatesPassed !== true || !Number.isFinite(Number(a.entry))) {
      return res.status(409).json({success:false,error:`No confirmed ${requested} entry from VT Markets MT5 right now. Current engine: ${a.signal} / ${a.status}`,analysis:a});
    }
    await tg.bot.sendMessage(tg.chatId, telegramText(a), {parse_mode:'Markdown'});
    res.json({success:true,analysis:a});
  } catch(e) {
    console.error('Manual Telegram signal:', e.message);
    res.status(500).json({success:false,error:e.message || 'Telegram send failed'});
  }
});

app.post('/telegram/webhook',async(req,res)=>{
  if(!bot) return res.sendStatus(503);
  if(REQUIRE_WEBHOOK_SECRET && !TELEGRAM_WEBHOOK_SECRET) return res.sendStatus(503);
  if(TELEGRAM_WEBHOOK_SECRET && !safeEqual(req.get('x-telegram-bot-api-secret-token'),TELEGRAM_WEBHOOK_SECRET)) return res.sendStatus(401);

  try { await bot.processUpdate(req.body); } catch(e){ console.error(e.message); }
  res.sendStatus(200);
});

setInterval(()=>{ const now=Date.now(); for (const [token,session] of authSessions) { if (!session.expiresAt || now>=session.expiresAt) authSessions.delete(token); } for (const [token,expiresAt] of revokedAuthTokens) { if (now>=expiresAt) revokedAuthTokens.delete(token); } for (const [sid,session] of telegramSessions) { if (!session.expiresAt || now>=session.expiresAt) { telegramSessions.delete(sid); telegramAlertKeys.delete(sid); telegramNewsKeys.delete(sid);
    telegramZoneKeys.delete(sid); } } }, 10*60*1000);

if(bot){
  bot.onText(/^\/price$/,async msg=>{
    try {
      const p=brokerLivePrice();
      if (!p) throw new Error('VT Markets MT5 feed unavailable or stale');
      await bot.sendMessage(msg.chat.id,`💰 XAUUSD live: ${p.price.toFixed(2)}\nBid: ${p.bid.toFixed(2)} | Ask: ${p.ask.toFixed(2)}\nSource: VT Markets MT5 | Age: ${p.ageSec}s`);
    } catch(_) {
      await bot.sendMessage(msg.chat.id,'⚠️ XAUUSD MT5 feed unavailable/stale.');
    }
  });
  bot.onText(/^\/signal$/,async msg=>{
    try {
      const a=await buildXauAnalysis();
      const isEntry=['BUY','SELL'].includes(String(a?.signal||'')) &&
        (a?.status === 'ENTRY CONFIRMED' || String(a?.status||'').includes('ENTRY CONFIRMED')) &&
        Number.isFinite(Number(a?.entry)) &&
        (a?.bestOpportunity || a?.confirmations?.allGatesPassed === true);
      await bot.sendMessage(msg.chat.id, isEntry ? telegramText(a) : telegramWaitText(a));
    } catch(e){
      const reason=String(e?.message||'Unknown analysis error');
      console.error(`[TELEGRAM /signal] Analysis blocked: ${reason}`);
      if (analysisCache.data) {
        const cached={...analysisCache.data,cached:true,cacheAgeSec:Math.max(0,Math.round((Date.now()-analysisCache.at)/1000))};
        const isEntry=['BUY','SELL'].includes(String(cached?.signal||'')) &&
          (cached?.status === 'ENTRY CONFIRMED' || String(cached?.status||'').includes('ENTRY CONFIRMED')) &&
          Number.isFinite(Number(cached?.entry)) &&
          (cached?.bestOpportunity || cached?.confirmations?.allGatesPassed === true);
        await bot.sendMessage(msg.chat.id, isEntry ? telegramText(cached) : telegramWaitText(cached));
      } else {
        await bot.sendMessage(msg.chat.id,`⚠️ ICT analysis unavailable.\nReason: ${reason.slice(0,220)}`);
      }
    }
  });
  bot.onText(/^\/status$/,msg=>bot.sendMessage(msg.chat.id,'🟢 V TRADE AI online — MTF ICT engine active.'));
  if(process.env.RENDER && APP_BASE_URL && TELEGRAM_WEBHOOK_SECRET){
    bot.setWebHook(`${APP_BASE_URL}/telegram/webhook`,{secret_token:TELEGRAM_WEBHOOK_SECRET})
      .catch(e=>console.error('Webhook setup:',e.message));
  }
}

app.use((err,req,res,next)=>{
  if (err?.message === 'CORS origin not allowed') return res.status(403).json({success:false,error:'Origin not allowed'});
  if (err?.type === 'entity.too.large') return res.status(413).json({success:false,error:'Request body too large'});
  console.error('[HTTP]',err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({success:false,error:'Internal server error'});
});

(async()=>{
  await storage.initStorage();
  try {
    const storedAuth = await storage.loadAuthCredentials();
    for (const row of storedAuth) if (row.userId && row.passwordHash) authPasswordOverrides.set(row.userId,row.passwordHash);
    console.log(`[AUTH] Loaded ${storedAuth.length} persisted password override(s)`);
  } catch (e) { console.error('[AUTH] Failed to load persisted credentials:', e.message); }
  setInterval(()=>storage.cleanup().catch(()=>{}), 6*60*60*1000);
  app.listen(PORT,HOST,()=>{
    console.log(`V TRADE AI v${APP_VERSION} Smart Entry PRO server listening on ${HOST}:${PORT}`);
    if (TELEGRAM_AUTO_ALERT_ENABLED && bot && TELEGRAM_CHAT_ID) {
      console.log(`[TELEGRAM AUTO] Enabled — interval ${TELEGRAM_AUTO_ALERT_INTERVAL_MS}ms`);
      console.log('[TELEGRAM AUTO] Waiting for broker-native MT5 quote + M5/M15/H1/H4 history before scanning.');
      runTelegramAutoAlertScan().catch(()=>{});
      setInterval(()=>runTelegramAutoAlertScan().catch(()=>{}), TELEGRAM_AUTO_ALERT_INTERVAL_MS);
    } else {
      console.log('[TELEGRAM AUTO] Disabled or Telegram env credentials missing');
    }
  });
})();
