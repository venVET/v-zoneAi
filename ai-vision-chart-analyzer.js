'use strict';

const OLLAMA_URL = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = String(process.env.OLLAMA_VISION_MODEL || 'qwen2.5vl:3b').trim();
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const OLLAMA_TIMEOUT_MS = Math.max(5000, Number(process.env.OLLAMA_TIMEOUT_MS || 45000));

function validateImage(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return { ok:false, error:'Invalid PNG/JPEG/WebP image' };
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) return { ok:false, error:'Image exceeds 6 MB' };
  return { ok:true, base64:m[2] };
}

function normalize(x = {}) {
  const side = ['BULLISH','BEARISH','NONE','UNCLEAR'];
  const trend = ['BULLISH','BEARISH','RANGE','UNKNOWN'];
  return {
    imageQuality: ['GOOD','LIMITED','INVALID'].includes(x.imageQuality) ? x.imageQuality : 'INVALID',
    symbol: typeof x.symbol === 'string' ? x.symbol.slice(0,30) : 'UNKNOWN',
    timeframe: typeof x.timeframe === 'string' ? x.timeframe.slice(0,20) : 'UNKNOWN',
    visiblePrice: Number.isFinite(Number(x.visiblePrice)) ? Number(x.visiblePrice) : null,
    trend: trend.includes(x.trend) ? x.trend : 'UNKNOWN',
    liquiditySweep: side.includes(x.liquiditySweep) ? x.liquiditySweep : 'UNCLEAR',
    mssBos: side.includes(x.mssBos) ? x.mssBos : 'UNCLEAR',
    fvg: side.includes(x.fvg) ? x.fvg : 'UNCLEAR',
    orderBlock: side.includes(x.orderBlock) ? x.orderBlock : 'UNCLEAR',
    confidence: Math.max(0, Math.min(100, Number(x.confidence) || 0)),
    evidence: Array.isArray(x.evidence) ? x.evidence.map(String).slice(0,12) : [],
    blockers: Array.isArray(x.blockers) ? x.blockers.map(String).slice(0,12) : [],
    // Vision is evidence extraction only. It never becomes an order.
    signal: 'WAIT',
    entry: null, stopLoss: null, tp1: null, tp2: null, tp3: null
  };
}

function promptText() {
  return `You are V-TRADE AI screenshot evidence extraction.
Analyze ONLY pixels visibly present in the supplied chart screenshot.
Never use live market data, memory, or outside knowledge.
Never invent candles, OHLC values, prices, indicators, timeframes, symbols, liquidity, MSS/BOS, FVG, or order blocks.
Never output BUY, SELL, ENTRY, SL, TP, or a trade recommendation.
A screenshot can prove only what is visibly readable in that screenshot.
If evidence is not clearly visible, use UNKNOWN/UNCLEAR.
Return ONLY valid JSON:
{"imageQuality":"GOOD|LIMITED|INVALID","symbol":"string or UNKNOWN","timeframe":"string or UNKNOWN","visiblePrice":number|null,"trend":"BULLISH|BEARISH|RANGE|UNKNOWN","liquiditySweep":"BULLISH|BEARISH|NONE|UNCLEAR","mssBos":"BULLISH|BEARISH|NONE|UNCLEAR","fvg":"BULLISH|BEARISH|NONE|UNCLEAR","orderBlock":"BULLISH|BEARISH|NONE|UNCLEAR","confidence":0,"evidence":[],"blockers":[]}`;
}

async function ollamaFetch(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const r = await fetch(`${OLLAMA_URL}${path}`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body),
      signal:controller.signal
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!r.ok) throw new Error(data.error || `Ollama HTTP ${r.status}`);
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`Ollama timeout after ${OLLAMA_TIMEOUT_MS} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function analyzeChart(imageDataUrl) {
  const checked = validateImage(imageDataUrl);
  if (!checked.ok) throw new Error(checked.error);

  const body = await ollamaFetch('/api/generate', {
    model: OLLAMA_MODEL,
    prompt: promptText(),
    images:[checked.base64],
    stream:false,
    format:'json',
    options:{temperature:0}
  });

  let parsed;
  try { parsed = JSON.parse(body.response || '{}'); }
  catch (_) { throw new Error('Ollama Vision returned invalid JSON'); }
  return normalize(parsed);
}

async function ollamaHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, {method:'GET', signal:controller.signal});
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!r.ok) return {ok:false,error:data.error || `Ollama HTTP ${r.status}`};
    const models = Array.isArray(data.models) ? data.models.map(x => x.name).filter(Boolean) : [];
    return {ok:true,url:OLLAMA_URL,model:OLLAMA_MODEL,models,modelInstalled:models.includes(OLLAMA_MODEL)};
  } catch (e) {
    return {ok:false,url:OLLAMA_URL,model:OLLAMA_MODEL,error:e?.name === 'AbortError' ? 'Ollama health timeout' : (e.message || 'Ollama unavailable')};
  } finally {
    clearTimeout(timer);
  }
}

function installVisionRoutes(app, requireAuth) {
  app.get('/api/v5/ai/vision/health', requireAuth, async (_req,res) => {
    const h = await ollamaHealth();
    res.status(h.ok ? 200 : 503).json({
      success:h.ok,
      provider:'ollama-local',
      url:OLLAMA_URL,
      model:OLLAMA_MODEL,
      modelInstalled:!!h.modelInstalled,
      models:h.models || [],
      mode:'EVIDENCE_ONLY',
      openai:false,
      error:h.error || null
    });
  });

  app.post('/api/v5/ai/vision/chart', requireAuth, async (req,res) => {
    try {
      const analysis = await analyzeChart(req.body?.imageDataUrl);
      res.set('Cache-Control','no-store');
      res.json({success:true,analysis,ai:{provider:'ollama-local',url:OLLAMA_URL,model:OLLAMA_MODEL,mode:'EVIDENCE_ONLY',openai:false}});
    } catch(e) {
      res.status(502).json({success:false,error:e.message || 'Vision unavailable',signal:'WAIT'});
    }
  });
}

module.exports = { installVisionRoutes, analyzeChart, normalize, ollamaHealth };
