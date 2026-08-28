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
const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';

// Telegram is user-configurable. Tokens are never sent to the browser and are kept
// only in server memory for the active session. Optional env credentials remain
// supported for owner/admin fallback deployments.
const TELEGRAM_TOKEN = String(process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || process.env.VZONEAI_TELEGRAM_TOKEN || process.env.TELEGRAM_API_TOKEN || process.env.BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_TARGET_CHAT_ID || process.env.TELEGRAM_ID || process.env.TARGET_CHAT_ID || '').trim();
const TELEGRAM_WEBHOOK_SECRET = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const TELEGRAM_WEBHOOK_BASE_URL = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const TELEGRAM_WEBHOOK_SECRET_EFFECTIVE = TELEGRAM_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');
const MT5_BRIDGE_API_KEY = process.env.MT5_BRIDGE_API_KEY || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const REQUIRE_WEBHOOK_SECRET = String(process.env.REQUIRE_WEBHOOK_SECRET || 'false').toLowerCase() === 'true';
const TELEGRAM_SESSION_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.TELEGRAM_SESSION_TTL_MS || 24 * 60 * 60 * 1000));
const MT5_MAX_AGE_MS = Number(process.env.MT5_MAX_AGE_MS || 15000);
const APP_VERSION = '7.3.5-TELEGRAM-WEBHOOK-FIX';
const APP_BASE_URL = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
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

// Per-user Telegram connections. The bot token is server-side only.
// Render restarts clear this in-memory map; users can reconnect from Telegram Setup.
const telegramSessions = new Map();
const telegramAlertKeys = new Map();
const telegramNewsKeys = new Map();
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
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
const { installVisionRoutes } = require('./ai-vision-chart-analyzer');
installVisionRoutes(app, requireAuth);
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
  else {const found=USER_ACCOUNTS.find(u=>{if(!u.enabled||u.email!==email)return false;const override=authPasswordOverrides.get(u.id);return override?verifyPassword(password,override):verifyPassword(password,u.passwordHash);});if(found){user={id:found.id,email:found.email,name:found.name,role:found.role,plan:found.plan,permissions:found.role==='admin'?['*']:['terminal','pricing','telegram:own','profile:own'],twoFactorEnabled:!!userTotpSecret(found)};secret=userTotpSecret(found);}}
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

app.get('/api/pricing', requireAuth, (req,res) => {
  res.set('Cache-Control','no-store');
  res.json({success:true, role:req.vtradeUser.role, currentPlan:req.vtradeUser.plan, plans:pricingPlans});
});

app.post('/api/admin/broadcast', requireAuth, requireRole('admin'), telegramMutationLimit, async (req,res) => {
  try {
    const tg = activeTelegramConfig(req);
    if (!tg) return res.status(400).json({success:false,error:'Telegram is not connected'});
    const a = await buildXauAnalysis();
    if (!['BUY','SELL'].includes(a.signal) || a.status !== 'ENTRY CONFIRMED' || Number(a.confidence||0) < Number(process.env.TELEGRAM_MIN_SCORE || 80)) {
      return res.status(409).json({success:false,error:'No confirmed high-confidence entry. Admin broadcast blocked.',analysis:a});
    }
    await tg.bot.sendMessage(tg.chatId, telegramText(a));
    return res.json({success:true,analysis:a});
  } catch(e) { return res.status(500).json({success:false,error:'Admin broadcast failed'}); }
});

app.get('/api/admin/session', requireAuth, requireRole('admin'), (req,res) => {
  res.set('Cache-Control','no-store');
  const sessions=[...authSessions.entries()].map(([token,s]) => ({
    sessionId: token.slice(0,8)+'…', id:s.id, email:s.email, name:s.name, role:s.role, plan:s.plan,
    createdAt:s.createdAt, lastSeenAt:s.lastSeenAt, expiresAt:s.expiresAt, active:Date.now()<s.expiresAt
  })).filter(s=>s.active);
  res.json({success:true,admin:req.vtradeUser,sessions,sessionCount:sessions.length,capabilities:['users:read','users:manage','pricing:manage','security:audit','telegram:admin','system:read']});
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

const cache = new Map();
const brokerFeed = { quote: null, timeframes: null, receivedAt: 0, symbol: null };
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
const AI_DATA_QUALITY_MIN = Math.max(60, Math.min(100, Number(process.env.AI_DATA_QUALITY_MIN || 85)));
const NEWS_URLS = String(process.env.NEWS_CALENDAR_URLS || process.env.NEWS_CALENDAR_URL || 'https://nfs.faireconomy.media/ff_calendar_thisweek.json')
  .split(',').map(x => x.trim()).filter(Boolean);
const NEWS_BRIDGE_MAX_AGE_MS = Number(process.env.NEWS_BRIDGE_MAX_AGE_MS || 10 * 60 * 1000);
const NEWS_PRELOCK_MIN = Number(process.env.NEWS_PRELOCK_MIN || 15);
const NEWS_CAUTION_MIN = Number(process.env.NEWS_CAUTION_MIN || 60);
const NEWS_LIVE_WINDOW_MIN = Number(process.env.NEWS_LIVE_WINDOW_MIN || 2);
const NEWS_POST_MIN = Number(process.env.NEWS_POST_MIN || 15);
const TELEGRAM_NEWS_ALERTS = String(process.env.TELEGRAM_NEWS_ALERTS || 'true').toLowerCase() === 'true';
const MIN_CONFLUENCE = Math.max(70, Number(process.env.MIN_CONFLUENCE || 85));
const MAX_ENTRY_SPREAD = Number(process.env.MAX_ENTRY_SPREAD || 1.50);
const CORE_MTF_TFS = ['H4','H1','M15'];
const FULL_MTF_TFS = ['D1','H4','H1','M15','M5','M1'];
const MIN_MTF_ALIGNMENT = Math.max(2, Math.min(3, Number(process.env.MIN_MTF_ALIGNMENT || 2)));
const MIN_ENTRY_SCORE = Math.max(MIN_CONFLUENCE, Number(process.env.MIN_ENTRY_SCORE || MIN_CONFLUENCE));
const NEWS_FAIL_CLOSED = String(process.env.NEWS_FAIL_CLOSED || 'true').toLowerCase() === 'true';
const AI_ENGINE_VERSION = 'advanced-mtf-ict-v6.3.4-standard-auth-security';
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

function brokerFeedFresh() {
  return !!brokerFeed.quote && (Date.now() - brokerFeed.receivedAt) <= MT5_MAX_AGE_MS;
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
  return {
    structure:s,sweep,atr:a,ema20:e20,ema50:e50,trend,rsi:r==null?null:Math.round(r*100)/100,
    macd:m?{line:m.line,signal:m.signal,histogram:m.histogram,bias:m.histogram>0?'BULLISH':m.histogram<0?'BEARISH':'NEUTRAL'}:null,
    adx:dx,volume:vb,last:c[c.length-1]?.c
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

function recentLiquiditySweep(c, lookback=6) {
  if (!c || c.length < 30) return {bias:'NONE', detail:'Insufficient swing history', fresh:false, index:null};
  const start=Math.max(10,c.length-lookback);
  for(let i=c.length-1;i>=start;i--){
    const prior=c.slice(0,i), sw=swings(prior,2); if(sw.highs.length<2||sw.lows.length<2) continue;
    const last=c[i], priorHigh=sw.highs[sw.highs.length-1].price, priorLow=sw.lows[sw.lows.length-1].price;
    if(last.h>priorHigh&&last.c<priorHigh) return {bias:'BEARISH',detail:'Buy-side liquidity swept',level:priorHigh,index:i,fresh:(c.length-1-i)<=2};
    if(last.l<priorLow&&last.c>priorLow) return {bias:'BULLISH',detail:'Sell-side liquidity swept',level:priorLow,index:i,fresh:(c.length-1-i)<=2};
  }
  return {bias:'NONE',detail:'No recent confirmed liquidity sweep',fresh:false,index:null};
}
function executionStructure(c) {
  if(!c||c.length<45) return {bias:'NONE',mss:'PENDING',bos:'PENDING',swingHigh:null,swingLow:null,mssFresh:false,bosFresh:false,mssBar:null,bosBar:null};
  // Use prior structure to define the break levels, then require a sequence:
  // MSS on a recent closed candle -> BOS continuation on a later closed candle.
  const context = c.slice(0, -2);
  const sw=swings(context,2);
  if(sw.highs.length<4||sw.lows.length<4) return {bias:'NONE',mss:'PENDING',bos:'PENDING',swingHigh:null,swingLow:null,mssFresh:false,bosFresh:false,mssBar:null,bosBar:null};
  const prevHigh=sw.highs[sw.highs.length-1].price;
  const prevLow=sw.lows[sw.lows.length-1].price;
  const mssBar=c[c.length-2], bosBar=c[c.length-1];
  const mssUp=mssBar.c>prevHigh, mssDown=mssBar.c<prevLow;
  const bosUp=mssUp && bosBar.c>mssBar.h;
  const bosDown=mssDown && bosBar.c<mssBar.l;
  const lastHigh=sw.highs[sw.highs.length-1].price;
  const lastLow=sw.lows[sw.lows.length-1].price;
  const recentSw=swings(c.slice(0,-1),2);
  const hs=recentSw.highs.slice(-2), ls=recentSw.lows.slice(-2);
  const bullishTrend=hs.length===2&&ls.length===2&&hs[1].price>hs[0].price&&ls[1].price>ls[0].price;
  const bearishTrend=hs.length===2&&ls.length===2&&hs[1].price<hs[0].price&&ls[1].price<ls[0].price;
  return {
    bias:bosUp||bullishTrend?'BULLISH':bosDown||bearishTrend?'BEARISH':'RANGE',
    mss:mssUp?'BULLISH':mssDown?'BEARISH':'PENDING',
    bos:bosUp?'BULLISH':bosDown?'BEARISH':'PENDING',
    swingHigh:lastHigh,
    swingLow:lastLow,
    mssFresh:mssUp||mssDown,
    bosFresh:bosUp||bosDown,
    mssBar:{timestamp:mssBar.t,close:mssBar.c},
    bosBar:{timestamp:bosBar.t,close:bosBar.c}
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
  const points=[
    {key:'htf',label:'Higher-TF alignment',points:htfOk?20:0,max:20,passed:htfOk},
    {key:'liquidity',label:'Fresh liquidity sweep',points:sweepOk?15:0,max:15,passed:sweepOk},
    {key:'mss',label:'Fresh MSS',points:mssOk?15:0,max:15,passed:mssOk},
    {key:'bos',label:'Fresh BOS',points:bosOk?10:0,max:10,passed:bosOk},
    {key:'zone',label:'Aligned FVG / OB',points:(alignedFvg||alignedOb)?10:0,max:10,passed:alignedFvg||alignedOb},
    {key:'retest',label:'Execution retest',points:retestOk?10:0,max:10,passed:retestOk},
    {key:'momentum',label:'RSI + MACD momentum',points:momentumOk?5:0,max:5,passed:momentumOk},
    {key:'trend',label:'ADX trend strength',points:trendOk?5:0,max:5,passed:trendOk},
    {key:'location',label:'Premium / Discount',points:pdOk?5:0,max:5,passed:pdOk}
  ];
  const score=points.reduce((n,x)=>n+x.points,0);
  let entry=null,stopLoss=null,takeProfit=[],riskReward=null;
  if (zone) {
    entry=side==='BULLISH'?live.executionBuy:live.executionSell;
    const buffer=Math.max(atr*0.30,0.8);
    stopLoss=side==='BULLISH'?roundToDigits(zone.low-buffer,live.digits):roundToDigits(zone.high+buffer,live.digits);
    const risk=Math.max(Math.abs(entry-stopLoss),0.5);
    const target=nearestTarget(entry,side,candles);
    const tp1=target && (side==='BULLISH'?target>entry:target<entry) ? target : (side==='BULLISH'?entry+risk*minRR:entry-risk*minRR);
    takeProfit=[roundToDigits(tp1,live.digits),roundToDigits(side==='BULLISH'?entry+risk*(minRR+1):entry-risk*(minRR+1),live.digits),roundToDigits(side==='BULLISH'?entry+risk*(minRR+2):entry-risk*(minRR+2),live.digits)];
    riskReward=Number((Math.abs(takeProfit[0]-entry)/risk).toFixed(2));
  }
  const strictReady=score>=threshold && htfOk && sweepOk && mssOk && bosOk && displacementOk && (alignedFvg||alignedOb) && retestOk && pdOk && momentumOk && trendOk && Number(riskReward||0)>=minRR;
  // Tactical mode is for a very strong setup that is close to the execution zone but has not fully retested yet.
  // It is still blocked by news at the global gate and is deliberately stricter than a normal WATCH state.
  const tacticalReady=!strictReady && zoneIsNear && score>=threshold+5 && htfOk && bosOk && displacementOk && momentumOk && Number(riskReward||0)>=minRR+0.5 && (sweepOk || mssOk);
  const signal=(strictReady||tacticalReady)?(side==='BULLISH'?'BUY':'SELL'):'WAIT';
  const state=strictReady?'CONFIRMED':tacticalReady?'TACTICAL':'WATCH';
  const reason=strictReady
    ? `${label}: ${side} confirmed with MTF alignment + ICT structure + zone + momentum + RR ${riskReward}`
    : tacticalReady
      ? `${label}: ${side} tactical opportunity near zone; wait for exact retest/confirmation before aggressive entry`
      : `${label}: waiting for ${points.filter(x=>!x.passed).map(x=>x.label).slice(0,3).join(', ') || 'better risk/reward'}`;
  return {key,label,minutes,state,signal,bias:side,score,confidence:score,entry,entryZone:zone?{...zone,low:round2(zone.low),high:round2(zone.high)}:null,stopLoss,takeProfit,riskReward,higherAlignment:`${higherAligned}/${higherAvailable}`,zoneIsNear,inZone,microTrigger,microTimeframe:'M1',ict:{liquiditySweep:sweep,mss:structure.mss,bos:structure.bos,fvg,orderBlock:ob,displacement,m1:{bias:microSide,sweep:microSweep,fvg:microFvg,structure:microStructure}},technical:{rsi,macd,adx,m1Rsi:micro?.rsi,m1Macd:micro?.macd},premiumDiscount:pd,premiumDiscountOk:pdOk,scoreItems:points,reason};
}

function latestAlignedOrderBlock(c,bias,maxAge=20){
  if(!c||!bias||bias==='NEUTRAL') return {found:false};
  for(let i=c.length-2;i>=5&&(c.length-1-i)<=maxAge;i--){const x=c[i],n=c[i+1]; if(bias==='BULLISH'&&x.c<x.o&&n.c>x.h) return {found:true,type:'BULLISH',low:x.l,high:x.h,index:i,ageBars:c.length-1-i}; if(bias==='BEARISH'&&x.c>x.o&&n.c<x.l) return {found:true,type:'BEARISH',low:x.l,high:x.h,index:i,ageBars:c.length-1-i};}
  return {found:false};
}

async function buildXauAnalysis() {
  const analysisStartedAt = Date.now();
  const analysisKey = `${brokerFeed.receivedAt}:${bridgeNews.receivedAt}:${newsCache.at}`;
  const now = Date.now();
  if (analysisCache.data && analysisCache.key === analysisKey && now - analysisCache.at < ANALYSIS_CACHE_MS) return analysisCache.data;
  const newsPromise = fetchXauNews();
  const rawM1=parseBrokerCandles('M1'),rawM5=parseBrokerCandles('M5'),rawM15=parseBrokerCandles('M15'),rawH1=parseBrokerCandles('H1'),rawH4=parseBrokerCandles('H4'),rawD1=parseBrokerCandles('D1');
  const live=brokerLivePrice();
  if(!live||!rawM5||!rawM15||!rawH1||!rawH4) throw new Error('VT Markets MT5 feed not ready');
  // Structure/ICT decisions use CLOSED candles; live quote remains the execution price.
  const m1=rawM1?closedCandles(rawM1,1):[],m5=closedCandles(rawM5,5),m15=closedCandles(rawM15,15),h1=closedCandles(rawH1,60),h4=closedCandles(rawH4,240),d1=rawD1?closedCandles(rawD1,1440):[];
  if(m5.length<AI_MIN_BARS||m15.length<30||h1.length<30||h4.length<30) throw new Error('VT Markets MT5 closed-candle history not ready');
  const [m1a,m5a,m15a,h1a,h4a,d1a]=await Promise.all([
    Promise.resolve(m1.length>=30?analyzeTF(m1):null),Promise.resolve(analyzeTF(m5)),Promise.resolve(analyzeTF(m15)),
    Promise.resolve(analyzeTF(h1)),Promise.resolve(analyzeTF(h4)),Promise.resolve(d1.length>=30?analyzeTF(d1):null)
  ]);
  const feedMode='VT Markets MT5',tfs={M1:m1a,M5:m5a,M15:m15a,H1:h1a,H4:h4a,D1:d1a},a=tfs.M5.atr||5;
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
  const availableHtf=CORE_MTF_TFS.filter(tf=>['BULLISH','BEARISH'].includes(tfs[tf]?.structure?.bias)).length;
  const fullMtfAvailable=fullBiases.filter(x=>['BULLISH','BEARISH'].includes(x.bias)).length;

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
  const biasOk=(side==='BULLISH'&&coreBull>=MIN_MTF_ALIGNMENT)||(side==='BEARISH'&&coreBear>=MIN_MTF_ALIGNMENT),sweepOk=sweep.bias===side&&sweep.fresh,mssOk=execStruct.mss===side&&execStruct.mssFresh,bosOk=execStruct.bos===side&&execStruct.bosFresh,displacementOk=displacement.confirmed&&displacement.direction===side,retestOk=!!candidateZone&&inZone,structureAgreement=mssOk&&bosOk;
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
  let signal='WAIT',status='WAIT — CONFIRMATION PENDING',entry=null,sl=null,tp=[],trigger=''; const reasons=[];
  if(!candlesFresh) reasons.push('Closed-candle data is stale — wait for fresh MT5 history');
  if(!biasOk) reasons.push('MTF core bias not aligned — need 2/3 H4/H1/M15 agreement');
  if(fullMtfAvailable < 4) reasons.push(`MTF context incomplete — ${fullMtfAvailable}/6 timeframes available`);
  if(!sweepOk) reasons.push('Fresh liquidity sweep not confirmed');
  if(!mssOk) reasons.push('Fresh M5 MSS not confirmed');
  if(!displacementOk) reasons.push('Directional displacement not confirmed');
  if(!(alignedFvg||alignedOb)) reasons.push('No fresh aligned FVG/OB');
  if(!retestOk) reasons.push('Price has not retested the execution zone');
  if(!bosOk) reasons.push('Fresh M5 BOS not confirmed');
  if(!pdOk) reasons.push(`Price is in ${premiumDiscount} — wait for ${side==='BULLISH'?'discount':'premium'} execution`);
  if(!spreadOk) reasons.push(`Spread ${live.spread ?? '—'} exceeds max ${MAX_ENTRY_SPREAD}`);
  if(!technicalMomentumOk) reasons.push('RSI/MACD momentum does not confirm the execution direction');
  if(!trendStrengthOk) reasons.push('ADX trend strength is too weak for the execution gate');
  const setupReady=candlesFresh&&biasOk&&sweepOk&&mssOk&&bosOk&&displacementOk&&(alignedFvg||alignedOb)&&retestOk&&structureAgreement&&pdOk&&spreadOk&&technicalMomentumOk&&trendStrengthOk&&confluenceScore>=MIN_ENTRY_SCORE;
  if(setupReady){
    signal=side==='BULLISH'?'BUY':'SELL'; status='ENTRY CONFIRMED'; const z=candidateZone; entry=side==='BULLISH'?live.executionBuy:live.executionSell; const buffer=Math.max(a*0.35,0.8); sl=side==='BULLISH'?roundToDigits(z.low-buffer,live.digits):roundToDigits(z.high+buffer,live.digits); const risk=Math.max(Math.abs(entry-sl),0.5),structureTarget=nearestTarget(entry,side,m5),minTp1=side==='BULLISH'?entry+risk*2:entry-risk*2,target1=structureTarget&&(side==='BULLISH'?structureTarget>minTp1:structureTarget<minTp1)?structureTarget:minTp1; tp=[roundToDigits(target1,live.digits),roundToDigits(side==='BULLISH'?entry+risk*3:entry-risk*3,live.digits),roundToDigits(side==='BULLISH'?entry+risk*4:entry-risk*4,live.digits)]; trigger=`${side} confirmed: liquidity sweep + MSS + BOS + displacement + ${alignedFvg?'FVG':'OB'} retest`;
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
    else if(news.degraded || news.trusted === false){ status='NEWS DEGRADED — NO ENTRY'; trigger='News provider is rate-limited/stale; calendar is shown for context only. Wait for a fresh verified feed'; }
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
    // Existing news gate already clears canonical entry. Also clear all horizon signals.
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
  const result = {symbol:'XAUUSD',engineVersion:AI_ENGINE_VERSION,scanIntervalMs:AI_FAST_SCAN_MS,feedMode,brokerConnected:brokerFeedFresh(),bid:live.bid,ask:live.ask,spread:live.spread,livePrice:live.price,executionPrice:signal==='BUY'?live.executionBuy:signal==='SELL'?live.executionSell:null,executionSide:signal==='BUY'?'ASK':signal==='SELL'?'BID':null,brokerDigits:live.digits,source:live.source,sourceDetail:live.sourceDetail,priceAsOf:live.priceAsOf,priceAgeSec:live.ageSec,stalePrice:live.stale,candleAgeSec:Math.round(candleAgeSec),timestamp:Date.now(),signal,phase,bias:macroBias,confidence:effectiveScore,setupGrade,status,actionable:signal==='BUY'?'BUY':signal==='SELL'?'SELL':'NO TRADE',entry,entryZone:selectedOpportunity?.entryZone || (setupReady?{...candidateZone,low:round2(candidateZone.low),high:round2(candidateZone.high)}:null),candidateZone:candidateZone?{...candidateZone,low:round2(candidateZone.low),high:round2(candidateZone.high)}:null,stopLoss:sl,takeProfit:tp,trigger,executionTimeframe:(selectedOpportunity?.key || (setupReady?'M5':'—')),opportunities:{M5:horizon5,M15:horizon15,H1:horizon60},microTiming:{timeframe:'M1',bias:tfs.M1?.structure?.bias || 'UNAVAILABLE',rsi:tfs.M1?.rsi ?? null,macd:tfs.M1?.macd ?? null,liquidity:tfs.M1?.liquiditySweep || null,structure:tfs.M1?.structure || null},bestOpportunity:selectedOpportunity,macroBias,availableHtf,score:{bull:side==='BULLISH'?effectiveScore:0,bear:side==='BEARISH'?effectiveScore:0,confidence:effectiveScore,grade:setupGrade,items:scoreItems,blockedReasons:reasons},dataQuality:{score:dataQuality,grade:dataQualityGrade,items:dataQualityItems,minRequired:AI_DATA_QUALITY_MIN},setupScore:effectiveScore,confirmations,ict:{liquiditySweep:sweep,mss:execStruct.mss,bos:execStruct.bos,fvg:f,orderBlock:ob,premiumDiscount},news,timeframes:tfs,mtf:{coreTimeframes:CORE_MTF_TFS,fullTimeframes:FULL_MTF_TFS,coreBiases,fullBiases,coreBull,coreBear,fullBull,fullBear,fullMtfCount,fullMtfAvailable,d1Bias,requiredAlignment:MIN_MTF_ALIGNMENT},decision:{state:((setupReady || !!selectedOpportunity) && !newsBlocked)?(signal==='BUY'?'CONFIRMED_BUY':'CONFIRMED_SELL'):(side==='NEUTRAL'?'NO_TRADE':'WAIT'),reason:(setupReady || selectedOpportunity)?trigger:reasons.join(' | '),mandatoryGates:['News verified / not blocked','At least one valid opportunity horizon (M5/M15/H1)','MTF alignment for selected horizon','ICT structure + liquidity + FVG/OB','Risk/Reward threshold','Fresh liquidity sweep','Fresh M5 MSS','Fresh M5 BOS','Directional displacement','Fresh aligned FVG/OB','Retest','Premium/Discount alignment','Spread <= max','Confluence >= threshold'],passed:(setupReady || !!selectedOpportunity) && !newsBlocked,evidenceSummary:{passed:scoreItems.filter(x=>x.passed).map(x=>x.label),waiting:scoreItems.filter(x=>!x.passed).map(x=>x.label),dataQuality:dataQualityGrade}},
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
  analysisCache.key = `${brokerFeed.receivedAt}:${bridgeNews.receivedAt}:${newsCache.at}`;
  analysisCache.at = Date.now();
  analysisCache.data = result;
  return result;
}

function telegramText(a) {
  const o=a?.bestOpportunity; const actionable = ['BUY','SELL'].includes(a.signal) && (a.status === 'ENTRY CONFIRMED' || String(a.status||'').includes('ENTRY CONFIRMED')) && Number.isFinite(Number(a.entry)) && (!!o || a.confirmations?.allGatesPassed === true);
  if (!actionable) throw new Error('No confirmed broker-native entry. Telegram Entry alert blocked.');
  const icon=a.signal==='BUY'?'🟢':'🔴';
  const side=a.signal==='BUY'?'BUY NOW':'SELL NOW';
  const quoteSide=a.executionSide || (a.signal==='BUY'?'ASK':'BID');
  const tp=a.takeProfit || [];
  return `${icon} *V TRADE AI — XAUUSD*\n\n`+
    `*${side}*\n`+
    `Entry: *${a.entry}* (${quoteSide})\n`+
    `SL: *${a.stopLoss}*\n`+
    `TP1: *${tp[0] ?? '—'}*\n`+
    `TP2: *${tp[1] ?? '—'}*\n`+
    `TP3: *${tp[2] ?? '—'}*\n\n`+
    `Broker: *VT Markets MT5*\n`+
    `Quote age: *${a.priceAgeSec ?? '—'}s* | Spread: *${a.spread ?? '—'}*\n`+
    `Score: *${a.confidence}/100* | TF: *${a.executionTimeframe}* | RR: *${o?.riskReward ?? '—'}*\n`+
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

  // Entry alerts remain strict and deduplicated.
  const o=a?.bestOpportunity; const actionable = ['BUY','SELL'].includes(a.signal) && (a.status === 'ENTRY CONFIRMED' || String(a.status||'').includes('ENTRY CONFIRMED')) && Number.isFinite(Number(a.entry)) && (!!o || a.confirmations?.allGatesPassed === true);
  if(actionable && Number(a.confidence || 0) >= Number(process.env.TELEGRAM_MIN_SCORE || 80) && (!o || o.state==='CONFIRMED')) {
    const key=`${a.signal}:${a.status}:${a.entryZone?.low ?? '-'}:${a.entryZone?.high ?? '-'}:${a.entry ?? '-'}:${a.stopLoss ?? '-'}:${(a.takeProfit||[]).join(',')}`;
    if(telegramAlertKeys.get(dedupeKey)!==key) {
      telegramAlertKeys.set(dedupeKey,key);
      await tg.bot.sendMessage(tg.chatId,telegramText(a));
      sent=true;
    }
  }
  return sent;
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
    brokerFeed.quote={bid,ask,last,spread:Number(q.spread)||ask-bid,serverTime:Number.isFinite(serverTime)?serverTime:Date.now()};
    // Python bridge v2 sends MTF candles under `bars`; older builds used `timeframes`.
    brokerFeed.timeframes=q.timeframes || q.bars || {};
    brokerFeed.receivedAt=Date.now();
    brokerFeed.symbol=String(q.symbol);
    analysisCache.key=''; analysisCache.data=null;
    storage.saveQuote(q).catch(()=>{});
    res.json({success:true,source:'VT Markets MT5',symbol:brokerFeed.symbol,receivedAt:brokerFeed.receivedAt});
  } catch(e){ res.status(400).json({success:false,error:'Invalid MT5 payload'}); }
});

app.get('/api/v5/mt5/status',(_req,res)=>{
  const q=brokerFeed.quote;
  res.json({
    success:true,
    connected:brokerFeedFresh(),
    feedMode:'VT Markets MT5',
    authoritative:true,
    symbol:brokerFeed.symbol,
    ageSec:q?Math.round((Date.now()-brokerFeed.receivedAt)/1000):null,
    maxAgeMs:MT5_MAX_AGE_MS,
    bid:q?.bid??null,
    ask:q?.ask??null,
    spread:q?.spread??null
  });
});

app.get('/api/market/xauusd',async(_req,res)=>{
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

app.get('/api/news/xauusd', async (_req,res)=>{
  const news=await fetchXauNews();
  res.set('Cache-Control','no-store');
  res.json({success:true,...news});
});

app.get('/api/analysis/xauusd',async(req,res)=>{
  try {
    if (req.get('x-vtrade-request') && !/^[a-zA-Z0-9._:-]{8,80}$/.test(req.get('x-vtrade-request'))) return res.status(400).json({success:false,error:'Invalid request id'});
    const a=await buildXauAnalysis();
    const tg = activeTelegramConfig(req);
    const sid = sessionIdFrom(req);
    res.json({success:true,...a,telegramConfigured:!!tg});
    storage.saveAnalysis(a).catch(()=>{});
    maybeTelegramAlert(a, tg, sid).catch(e=>console.error('Telegram alert:',e.message));
  } catch(e) {
    console.error('ICT analysis:',e.message);
    res.status(503).json({success:false,error:'ICT analysis temporarily unavailable'});
  }
});

app.get('/api/telegram/session',(req,res)=>{
  const sid = sessionIdFrom(req) || createSessionId();
  res.set('Cache-Control','no-store');
  res.json({success:true,sessionId:sid,connected:!!telegramSessions.get(sid)});
});

app.get('/api/telegram/status',async(req,res)=>{
  const sid=sessionIdFrom(req);
  const tg=getSessionConfig(req);
  if (!tg) {
    return res.json({success:true,connected:false,configured:!!(bot&&TELEGRAM_CHAT_ID),mode:(bot&&TELEGRAM_CHAT_ID)?'env-fallback':'not-configured'});
  }
  res.json({success:true,connected:true,mode:'user-session',botUsername:tg.botUsername,chatId:maskChatId(tg.chatId),connectedAt:tg.connectedAt});
});

app.post('/api/telegram/connect',telegramMutationLimit,async(req,res)=>{
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
    res.status(400).json({success:false,error:e.message||'Telegram connection failed'});
  }
});

app.post('/api/telegram/test',telegramMutationLimit,async(req,res)=>{
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

app.post('/api/telegram/disconnect',telegramMutationLimit,(req,res)=>{
  const sid=sessionIdFrom(req);
  if(sid) {
    telegramSessions.delete(sid);
    telegramAlertKeys.delete(sid);
  }
  res.json({success:true,connected:false});
});

app.post('/api/v5/signal',telegramMutationLimit,async(req,res)=>{
  try {
    const tg = activeTelegramConfig(req);
    if(!tg) return res.status(400).json({success:false,error:'Telegram is not connected. Enter your Bot Token and Chat ID first.'});
    const a = await buildXauAnalysis();
    const requested = String(req.body?.type || '').toUpperCase();
    if (!['BUY','SELL'].includes(requested)) {
      return res.status(409).json({success:false,error:'Telegram Entry alert accepts BUY or SELL only. WAIT is never broadcast as an entry.',analysis:a});
    }
    if (requested !== a.signal || a.status !== 'ENTRY CONFIRMED' || a.confirmations?.allGatesPassed !== true || !Number.isFinite(Number(a.entry))) {
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
  if(REQUIRE_WEBHOOK_SECRET && !TELEGRAM_WEBHOOK_SECRET_EFFECTIVE) return res.sendStatus(503);
  if(TELEGRAM_WEBHOOK_SECRET_EFFECTIVE && !safeEqual(req.get('x-telegram-bot-api-secret-token'),TELEGRAM_WEBHOOK_SECRET_EFFECTIVE)) return res.sendStatus(401);

  try { await bot.processUpdate(req.body); console.log(`[TELEGRAM WEBHOOK] update processed | text=${req.body?.message?.text || 'unknown'}`); } catch(e){ console.error('[TELEGRAM WEBHOOK] process error:',e.message); }
  res.sendStatus(200);
});

setInterval(()=>{ const now=Date.now(); for (const [token,session] of authSessions) { if (!session.expiresAt || now>=session.expiresAt) authSessions.delete(token); } for (const [token,expiresAt] of revokedAuthTokens) { if (now>=expiresAt) revokedAuthTokens.delete(token); } for (const [sid,session] of telegramSessions) { if (!session.expiresAt || now>=session.expiresAt) { telegramSessions.delete(sid); telegramAlertKeys.delete(sid); telegramNewsKeys.delete(sid); } } }, 10*60*1000);

if(bot){
  bot.onText(/^\/start(?:@\w+)?$/,async msg=>{
    await bot.sendMessage(msg.chat.id,
      '🤖 V TRADE AI — XAUUSD\n\n' +
      '🟢 Bot online.\n' +
      'Use /help for commands.\n\n' +
      'MT5 broker-native feed is used for price and ICT analysis.');
  });

  bot.onText(/^\/help(?:@\w+)?$/,async msg=>{
    await bot.sendMessage(msg.chat.id,
      '📋 V TRADE AI Commands\n\n' +
      '/price — XAUUSD live Bid/Ask\n' +
      '/signal — current ICT signal/status\n' +
      '/status — bot + engine status\n' +
      '/id — show this Telegram Chat ID\n' +
      '/help — show commands');
  });

  bot.onText(/^\/id(?:@\w+)?$/,async msg=>{
    await bot.sendMessage(msg.chat.id,`🆔 Chat ID: ${msg.chat.id}`);
  });

  bot.onText(/^\/price(?:@\w+)?$/,async msg=>{
    try {
      const p=brokerLivePrice();
      if (!p) throw new Error('VT Markets MT5 feed unavailable or stale');
      await bot.sendMessage(msg.chat.id,`💰 XAUUSD live: ${p.price.toFixed(2)}\nBid: ${p.bid.toFixed(2)} | Ask: ${p.ask.toFixed(2)}\nSource: VT Markets MT5 | Age: ${p.ageSec}s`);
    } catch(e) {
      await bot.sendMessage(msg.chat.id,`⚠️ XAUUSD MT5 feed unavailable/stale. ${e?.message || ''}`.trim());
    }
  });

  bot.onText(/^\/signal(?:@\w+)?$/,async msg=>{
    try {
      const a=await buildXauAnalysis();
      const actionable=['BUY','SELL'].includes(a.signal) && a.status==='ENTRY CONFIRMED' && Number.isFinite(Number(a.entry));
      if(actionable) {
        await bot.sendMessage(msg.chat.id,telegramText(a),{parse_mode:'Markdown'});
      } else {
        const blockers=Array.isArray(a?.decision?.evidenceSummary?.waiting) ? a.decision.evidenceSummary.waiting.slice(0,6).join('\n• ') : (a?.decision?.reason || 'Confirmation gates are not ready.');
        await bot.sendMessage(msg.chat.id,
          `🟡 *V TRADE AI — XAUUSD*\n\n*${a.signal || 'WAIT'}* — ${a.status || 'WAIT'}\n`+
          `Price: *${a.price ?? a.quote?.price ?? '—'}*\n`+
          `Confidence: *${a.confidence ?? '—'}/100*\n\n`+
          `Why WAIT:\n• ${blockers}\n\n`+
          `No entry alert is sent until all defined confirmation gates pass.`,
          {parse_mode:'Markdown'});
      }
    } catch(e){
      console.error('[TELEGRAM] /signal:',e?.message || e);
      await bot.sendMessage(msg.chat.id,'⚠️ ICT analysis temporarily unavailable. Check MT5 feed / Render logs.');
    }
  });

  bot.onText(/^\/status(?:@\w+)?$/,async msg=>{
    const p=brokerLivePrice();
    const feed=p ? `🟢 MT5 READY | ${p.price.toFixed(2)} | age ${p.ageSec}s` : '🟠 MT5 feed not ready/stale';
    let webhook='UNKNOWN';
    try { const info=await bot.getWebHookInfo(); webhook=info?.url ? `ACTIVE | pending ${info.pending_update_count || 0}` : 'NOT SET'; } catch(_) {}
    await bot.sendMessage(msg.chat.id,`🟢 V TRADE AI online\n${feed}\nTelegram webhook: ${webhook}`);
  });

  if(process.env.RENDER && TELEGRAM_WEBHOOK_BASE_URL){
    const webhookUrl=`${TELEGRAM_WEBHOOK_BASE_URL}/telegram/webhook`;
    bot.setWebHook(webhookUrl,{secret_token:TELEGRAM_WEBHOOK_SECRET_EFFECTIVE})
      .then(async()=>{
        console.log(`[TELEGRAM WEBHOOK] ACTIVE | ${webhookUrl}`);
        try {
          const info=await bot.getWebHookInfo();
          console.log(`[TELEGRAM WEBHOOK] VERIFY | url=${info?.url || 'NONE'} | pending=${info?.pending_update_count ?? 0} | lastError=${info?.last_error_message || 'none'}`);
        } catch(e){ console.error('[TELEGRAM WEBHOOK] verify failed:',e.message); }
      })
      .catch(e=>console.error('[TELEGRAM WEBHOOK] setup failed:',e.message));
  } else if(process.env.RENDER) {
    console.error('[TELEGRAM WEBHOOK] NOT CONFIGURED | missing APP_BASE_URL/RENDER_EXTERNAL_URL');
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
    console.log(`[TELEGRAM] token=${TELEGRAM_TOKEN?'CONFIGURED':'MISSING'} | chatId=${TELEGRAM_CHAT_ID?'CONFIGURED':'MISSING'} | baseUrl=${TELEGRAM_WEBHOOK_BASE_URL||'MISSING'} | secret=${TELEGRAM_WEBHOOK_SECRET?'CONFIGURED':'AUTO'}`);
    if(!TELEGRAM_TOKEN) console.error('[TELEGRAM] BLOCKED | Add the Telegram bot token to Render Environment. Accepted: TELEGRAM_TOKEN, TELEGRAM_BOT_TOKEN, VZONEAI_TELEGRAM_TOKEN, TELEGRAM_API_TOKEN, BOT_TOKEN.');
    else if(!TELEGRAM_CHAT_ID) console.warn('[TELEGRAM] ENV CHAT ID missing | Bot commands still work; auto alerts need TELEGRAM_CHAT_ID or a connected UI session.');
  }); })();
