'use strict';

const OLLAMA_URL = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = String(process.env.OLLAMA_VISION_MODEL || 'qwen2.5vl:3b').trim();
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

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
    // HARD GATE: Vision never becomes an order.
    signal: 'WAIT',
    entry: null, stopLoss: null, tp1: null, tp2: null, tp3: null
  };
}

async function analyzeChart(imageDataUrl) {
  const checked = validateImage(imageDataUrl);
  if (!checked.ok) throw new Error(checked.error);

  const prompt = `You are V-ZONE screenshot EVIDENCE extraction only.
Analyze ONLY pixels visibly present in the supplied chart screenshot.
Never use live market data or outside knowledge.
Never invent candles, OHLC values, prices, indicators, timeframes, symbols, liquidity, MSS/BOS, FVG, or order blocks.
Never output BUY, SELL, ENTRY, SL, TP, or a trade recommendation.
A screenshot can prove only the timeframe visibly shown; never create M5/H1/H4/D1 data that is not visible.
ICT labels are UNCLEAR unless the evidence is visibly identifiable.
Return ONLY valid JSON with exactly:
{"imageQuality":"GOOD|LIMITED|INVALID","symbol":"string or UNKNOWN","timeframe":"string or UNKNOWN","visiblePrice":number|null,"trend":"BULLISH|BEARISH|RANGE|UNKNOWN","liquiditySweep":"BULLISH|BEARISH|NONE|UNCLEAR","mssBos":"BULLISH|BEARISH|NONE|UNCLEAR","fvg":"BULLISH|BEARISH|NONE|UNCLEAR","orderBlock":"BULLISH|BEARISH|NONE|UNCLEAR","confidence":0,"evidence":[],"blockers":[]}`;

  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      model:OLLAMA_MODEL, prompt, images:[checked.base64], stream:false,
      format:'json', options:{temperature:0}
    })
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `Ollama HTTP ${r.status}`);
  let parsed;
  try { parsed = JSON.parse(body.response); }
  catch (_) { throw new Error('Vision model returned invalid JSON'); }
  return normalize(parsed);
}

function installVisionRoutes(app, requireAuth) {
  app.get('/api/v5/ai/vision/health', requireAuth, (_req,res) => {
    res.json({success:true, provider:'ollama-local', model:OLLAMA_MODEL, mode:'EVIDENCE_ONLY', openai:false});
  });
  app.post('/api/v5/ai/vision/chart', requireAuth, async (req,res) => {
    try {
      const analysis = await analyzeChart(req.body?.imageDataUrl);
      res.set('Cache-Control','no-store');
      res.json({success:true, analysis, ai:{provider:'ollama-local',model:OLLAMA_MODEL,mode:'EVIDENCE_ONLY',openai:false}});
    } catch(e) {
      res.status(502).json({success:false,error:e.message || 'Vision unavailable',signal:'WAIT'});
    }
  });
}

module.exports = { installVisionRoutes, analyzeChart, normalize };
