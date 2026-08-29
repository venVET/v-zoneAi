'use strict';

import http from 'node:http';

const HOST = process.env.OLLAMA_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.OLLAMA_BRIDGE_PORT || 11435);
const OLLAMA_URL = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const MODEL = String(process.env.OLLAMA_VISION_MODEL || 'qwen2.5vl:3b').trim();
const MAX_BYTES = 6 * 1024 * 1024;
const FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.OLLAMA_FETCH_TIMEOUT_MS || 10000));

function send(res, status, body) {
  const out = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type,Authorization',
    'Access-Control-Allow-Private-Network':'true',
    'Access-Control-Max-Age':'600',
    'Vary':'Origin, Access-Control-Request-Private-Network'
  });
  res.end(out);
}

function readJson(req) {
  return new Promise((resolve,reject)=>{
    let raw='';
    req.on('data', c => {
      raw += c;
      if (Buffer.byteLength(raw) > MAX_BYTES + 10000) {
        req.destroy();
        reject(new Error('Request too large'));
      }
    });
    req.on('end', ()=> {
      try { resolve(JSON.parse(raw || '{}')); }
      catch (_) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function imageBase64(dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) throw new Error('Invalid PNG/JPEG/WebP image');
  const bytes = Math.floor((m[1].length * 3) / 4);
  if (bytes > MAX_BYTES) throw new Error('Image exceeds 6 MB');
  return m[1];
}

const prompt = `You are V-TRADE AI screenshot evidence extraction.
Analyze ONLY pixels visibly present in the supplied chart screenshot.
Never use live market data, memory, or outside knowledge.
Never invent candles, OHLC values, prices, indicators, timeframes, symbols, liquidity, MSS/BOS, FVG, or order blocks.
Never output BUY, SELL, ENTRY, SL, TP, or a trade recommendation.
If evidence is not clearly visible, use UNKNOWN/UNCLEAR.
Return ONLY valid JSON:
{"imageQuality":"GOOD|LIMITED|INVALID","symbol":"string or UNKNOWN","timeframe":"string or UNKNOWN","visiblePrice":number|null,"trend":"BULLISH|BEARISH|RANGE|UNKNOWN","liquiditySweep":"BULLISH|BEARISH|NONE|UNCLEAR","mssBos":"BULLISH|BEARISH|NONE|UNCLEAR","fvg":"BULLISH|BEARISH|NONE|UNCLEAR","orderBlock":"BULLISH|BEARISH|NONE|UNCLEAR","confidence":0,"evidence":[],"blockers":[]}`;

async function fetchWithTimeout(url, options={}, timeoutMs=FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, {...options, signal:controller.signal}); }
  finally { clearTimeout(timer); }
}

async function ollama(path, body) {
  const r = await fetchWithTimeout(OLLAMA_URL + path, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  const text = await r.text();
  let d={}; try { d=text?JSON.parse(text):{}; } catch(_){}
  if (!r.ok) throw new Error(d.error || `Ollama HTTP ${r.status}`);
  return d;
}

const server = http.createServer(async (req,res)=>{
  if (req.method === 'OPTIONS') return send(res,204,{success:true});
  if (req.url === '/health' && req.method === 'GET') {
    try {
      const r = await fetchWithTimeout(OLLAMA_URL + '/api/tags', {method:'GET'}, 5000);
      const d = await r.json().catch(()=>({}));
      const models = Array.isArray(d.models) ? d.models.map(x=>x.name).filter(Boolean) : [];
      return send(res, r.ok ? 200 : 503, {
        success:r.ok, bridge:true, ollama:OLLAMA_URL, model:MODEL,
        modelInstalled:models.includes(MODEL), models,
        error:r.ok?null:(d.error || `Ollama HTTP ${r.status}`)
      });
    } catch(e) {
      return send(res,503,{success:false,bridge:true,ollama:OLLAMA_URL,model:MODEL,error:e?.name === 'AbortError' ? 'Ollama health timeout' : (e.message||'Ollama unavailable')});
    }
  }

  if (req.url === '/api/vision/analyze' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const image = imageBase64(body.imageDataUrl);
      const d = await ollama('/api/generate', {
        model: MODEL,
        prompt,
        images:[image],
        stream:false,
        format:'json',
        options:{temperature:0}
      });
      let analysis;
      try { analysis = JSON.parse(d.response || '{}'); }
      catch(_) { throw new Error('Ollama returned invalid JSON'); }
      return send(res,200,{success:true,provider:'ollama-local-bridge',model:MODEL,analysis});
    } catch(e) {
      return send(res,502,{success:false,error:e.message||'Vision failed'});
    }
  }

  send(res,404,{success:false,error:'Not found'});
});

server.listen(PORT,HOST,()=> {
  console.log(`[OLLAMA BRIDGE] http://${HOST}:${PORT}`);
  console.log(`[OLLAMA BRIDGE] Ollama=${OLLAMA_URL} model=${MODEL}`);
});
