const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.VTRADE_DATA_DIR || path.join(__dirname, 'data');
const LOCAL_FILE = path.join(DATA_DIR, 'vtrade-storage.jsonl');
const AUTH_FILE = path.join(DATA_DIR, 'vtrade-auth.json');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const RETENTION_DAYS = Math.max(1, Number(process.env.STORAGE_RETENTION_DAYS || 30));
const QUOTE_INTERVAL_MS = Math.max(5000, Number(process.env.STORAGE_QUOTE_INTERVAL_MS || 10000));

let pool = null;
let mode = 'local';
let ready = false;
let lastQuoteSavedAt = 0;
let lastError = null;

function safeJson(value) {
  try { return JSON.stringify(value); } catch (_) { return '{}'; }
}

async function initStorage() {
  if (DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      pool = new Pool({ connectionString: DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 });
      await pool.query(`CREATE TABLE IF NOT EXISTS vtrade_events (
        id BIGSERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        symbol TEXT,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_vtrade_events_created ON vtrade_events(created_at DESC)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS vtrade_auth_credentials (user_id TEXT PRIMARY KEY, password_hash TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_vtrade_events_type ON vtrade_events(event_type, created_at DESC)`);
      mode = 'postgres'; ready = true; lastError = null;
      console.log('[STORAGE] PostgreSQL connected');
      return;
    } catch (e) {
      lastError = e.message;
      console.error('[STORAGE] PostgreSQL unavailable, falling back to local JSONL:', e.message);
      try { if (pool) await pool.end(); } catch (_) {}
      pool = null;
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOCAL_FILE)) fs.writeFileSync(LOCAL_FILE, '', 'utf8');
  mode = 'local'; ready = true;
  console.log(`[STORAGE] Local JSONL ready: ${LOCAL_FILE}`);
}

async function saveEvent(eventType, symbol, payload) {
  if (!ready) return false;
  const type = String(eventType || 'event').slice(0, 40);
  const sym = symbol ? String(symbol).slice(0, 40) : null;
  if (mode === 'postgres' && pool) {
    try {
      await pool.query('INSERT INTO vtrade_events(event_type,symbol,payload) VALUES($1,$2,$3::jsonb)', [type, sym, safeJson(payload)]);
      return true;
    } catch (e) { lastError = e.message; return false; }
  }
  try {
    fs.appendFile(LOCAL_FILE, `${safeJson({event_type:type,symbol:sym,payload,created_at:new Date().toISOString()})}\n`, 'utf8', ()=>{});
    return true;
  } catch (e) { lastError = e.message; return false; }
}

async function saveQuote(payload) {
  const now = Date.now();
  if (now - lastQuoteSavedAt < QUOTE_INTERVAL_MS) return false;
  lastQuoteSavedAt = now;
  return saveEvent('quote', payload?.symbol || 'XAUUSD', {
    bid:Number(payload?.bid), ask:Number(payload?.ask), last:Number(payload?.last),
    spread:Number(payload?.spread), serverTime:Number(payload?.serverTime || now)
  });
}

async function saveAnalysis(analysis) {
  return saveEvent('analysis', 'XAUUSD', {
    timestamp: analysis?.timestamp || Date.now(), signal: analysis?.signal || 'WAIT',
    status: analysis?.status || null, bias: analysis?.bias || analysis?.direction || null,
    confidence: analysis?.confidence ?? null, setupGrade: analysis?.setupGrade || null,
    entryZone: analysis?.entryZone || null, entry: analysis?.entry || null,
    stopLoss: analysis?.stopLoss || null, takeProfit: analysis?.takeProfit || [],
    news: analysis?.news || null
  });
}

async function getStatus() {
  let connected = ready;
  if (mode === 'postgres' && pool) {
    try { await pool.query('SELECT 1'); } catch (e) { connected=false; lastError=e.message; }
  }
  return { ready, connected, mode, databaseConfigured:!!DATABASE_URL, retentionDays:RETENTION_DAYS, lastError: lastError || null };
}

async function getHistory({type='analysis', limit=50}={}) {
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  if (mode === 'postgres' && pool) {
    const r = await pool.query('SELECT id,event_type,symbol,payload,created_at FROM vtrade_events WHERE event_type=$1 ORDER BY created_at DESC LIMIT $2',[type,n]);
    return r.rows;
  }
  try {
    const text = fs.readFileSync(LOCAL_FILE, 'utf8');
    return text.split(/\n+/).filter(Boolean).map(line=>{ try{return JSON.parse(line)}catch(_){return null} }).filter(Boolean).filter(x=>x.event_type===type).slice(-n).reverse();
  } catch (_) { return []; }
}

async function cleanup() {
  if (mode === 'postgres' && pool) {
    try { await pool.query(`DELETE FROM vtrade_events WHERE created_at < NOW() - ($1 || ' days')::interval`, [RETENTION_DAYS]); } catch (e) { lastError=e.message; }
  }
}


async function loadAuthCredentials() {
  if (mode === 'postgres' && pool) {
    try {
      const r = await pool.query('SELECT user_id,password_hash FROM vtrade_auth_credentials');
      return r.rows.map(x => ({userId:String(x.user_id), passwordHash:String(x.password_hash)}));
    } catch (e) { lastError=e.message; return []; }
  }
  try {
    const raw=fs.readFileSync(AUTH_FILE,'utf8');
    const parsed=JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(x=>({userId:String(x.userId||''),passwordHash:String(x.passwordHash||'')})).filter(x=>x.userId&&x.passwordHash) : [];
  } catch (_) { return []; }
}

async function saveAuthCredential(userId, passwordHash) {
  const id=String(userId||'').trim(), hash=String(passwordHash||'').trim();
  if (!id || !hash) throw new Error('Invalid auth credential');
  if (mode === 'postgres' && pool) {
    await pool.query(`INSERT INTO vtrade_auth_credentials(user_id,password_hash,updated_at)
      VALUES($1,$2,NOW())
      ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,updated_at=NOW()`,[id,hash]);
    return {persistent:true,mode:'postgres'};
  }
  fs.mkdirSync(DATA_DIR,{recursive:true});
  let rows=[];
  try { rows=JSON.parse(fs.readFileSync(AUTH_FILE,'utf8')); if(!Array.isArray(rows)) rows=[]; } catch (_) {}
  const i=rows.findIndex(x=>String(x.userId)===id);
  const row={userId:id,passwordHash:hash,updatedAt:new Date().toISOString()};
  if(i>=0) rows[i]=row; else rows.push(row);
  const tmp=AUTH_FILE+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(rows,null,2),'utf8');
  fs.renameSync(tmp,AUTH_FILE);
  return {persistent:true,mode:'local'};
}

module.exports = { initStorage, saveQuote, saveAnalysis, getStatus, getHistory, cleanup, loadAuthCredentials, saveAuthCredential };
