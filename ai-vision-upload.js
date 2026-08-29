'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const input = $('visionImage');
  const preview = $('visionPreview');
  const result = $('visionResult');
  const button = $('visionAnalyze');
  const status = $('visionStatus');
  if (!input || !preview || !result || !button) return;

  const DEFAULT_MODEL = 'qwen2.5vl:3b';
  const LOCAL_BRIDGE = String(localStorage.getItem('vtrade_ollama_bridge') || 'http://127.0.0.1:11435').replace(/\/$/,'');
  let dataUrl = '';

  function setStatus(text, ok=false) {
    if (!status) return;
    status.textContent = text;
    status.className = 'notice ' + (ok ? 'success' : '');
  }

  function getModel() {
    return String(localStorage.getItem('vtrade_ollama_model') || DEFAULT_MODEL).trim();
  }

  function buildPrompt() {
    return `You are V-TRADE AI screenshot evidence extraction.
Analyze ONLY pixels visibly present in the supplied chart screenshot.
Never use live market data, memory, or outside knowledge.
Never invent candles, OHLC values, prices, indicators, timeframes, symbols, liquidity, MSS/BOS, FVG, or order blocks.
Never output BUY, SELL, ENTRY, SL, TP, or a trade recommendation.
If evidence is not clearly visible, use UNKNOWN/UNCLEAR.
Return ONLY valid JSON:
{"imageQuality":"GOOD|LIMITED|INVALID","symbol":"string or UNKNOWN","timeframe":"string or UNKNOWN","visiblePrice":number|null,"trend":"BULLISH|BEARISH|RANGE|UNKNOWN","liquiditySweep":"BULLISH|BEARISH|NONE|UNCLEAR","mssBos":"BULLISH|BEARISH|NONE|UNCLEAR","fvg":"BULLISH|BEARISH|NONE|UNCLEAR","orderBlock":"BULLISH|BEARISH|NONE|UNCLEAR","confidence":0,"evidence":[],"blockers":[]}`;
  }

  function normalize(a={}) {
    return {
      imageQuality:a.imageQuality || 'INVALID',
      symbol:a.symbol || 'UNKNOWN',
      timeframe:a.timeframe || 'UNKNOWN',
      visiblePrice:Number.isFinite(Number(a.visiblePrice)) ? Number(a.visiblePrice) : null,
      trend:a.trend || 'UNKNOWN',
      liquiditySweep:a.liquiditySweep || 'UNCLEAR',
      mssBos:a.mssBos || 'UNCLEAR',
      fvg:a.fvg || 'UNCLEAR',
      orderBlock:a.orderBlock || 'UNCLEAR',
      confidence:Math.max(0,Math.min(100,Number(a.confidence)||0)),
      evidence:Array.isArray(a.evidence)?a.evidence.slice(0,12):[],
      blockers:Array.isArray(a.blockers)?a.blockers.slice(0,12):[]
    };
  }

  async function localOllama() {
    const bridge = LOCAL_BRIDGE;
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 50000);
    try {
      const r = await fetch(`${bridge}/api/vision/analyze`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({imageDataUrl:dataUrl}),
        signal:controller.signal
      });
      const text = await r.text();
      let d={}; try { d=text?JSON.parse(text):{}; } catch(_){ }
      if (!r.ok || !d.success) throw new Error(d.error || `Local Ollama bridge HTTP ${r.status}`);
      return normalize(d.analysis || {});
    } catch(e) {
      if (e?.name === 'AbortError') throw new Error('Local Ollama bridge timeout');
      if (e instanceof TypeError || /Failed to fetch/i.test(String(e?.message||''))) {
        throw new Error('Local Ollama Bridge is not reachable. Run START-OLLAMA-VISION-BRIDGE.cmd on this PC and keep it open.');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function renderOllama() {
    const api = window.VTRADE_API_BASE || window.VTRADE_API || window.VTRADE_BACKEND || 'https://v-trade-ai.onrender.com';
    const token = localStorage.getItem('vtrade_auth_token') || sessionStorage.getItem('vtrade_auth_token') || '';
    const r = await fetch(`${api.replace(/\/$/,'')}/api/v5/ai/vision/chart`, {
      method:'POST',
      headers:{'Content-Type':'application/json', ...(token ? {'x-vtrade-auth':token} : {})},
      credentials:'omit',
      body:JSON.stringify({imageDataUrl:dataUrl})
    });
    const d = await r.json();
    if (!r.ok || !d.success) throw new Error(d.error || `Render HTTP ${r.status}`);
    return normalize(d.analysis || {});
  }

  function renderAnalysis(a, source) {
    result.textContent =
      `Source: ${source}\n` +
      `Symbol: ${a.symbol}\n` +
      `Timeframe: ${a.timeframe}\n` +
      `Visible price: ${a.visiblePrice ?? 'UNKNOWN'}\n` +
      `Trend: ${a.trend}\n` +
      `Liquidity: ${a.liquiditySweep}\n` +
      `MSS/BOS: ${a.mssBos}\n` +
      `FVG: ${a.fvg}\n` +
      `Order Block: ${a.orderBlock}\n` +
      `Confidence: ${a.confidence}%\n\n` +
      `FINAL SIGNAL: WAIT\n` +
      `Entry / SL / TP: NOT GENERATED`;
  }

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
      dataUrl=''; result.textContent='Only PNG, JPG or WebP is supported.'; return;
    }
    if (file.size > 6 * 1024 * 1024) {
      dataUrl=''; result.textContent='Image must be 6 MB or smaller.'; return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      dataUrl = String(reader.result || '');
      preview.src = dataUrl;
      preview.hidden = false;
      result.textContent = 'Screenshot ready. Click Analyze.';
      setStatus(`Ollama local ready · model ${getModel()}`, true);
    };
    reader.readAsDataURL(file);
  });

  async function tryRender() {
    setStatus('Trying Render Vision…');
    result.textContent='Connecting to Render Vision service…';
    return await renderOllama();
  }

  async function tryLocal() {
    setStatus('Trying Ollama Local Bridge…');
    result.textContent='Connecting to local Ollama Vision…';
    const health = await fetch(`${LOCAL_BRIDGE}/health`, {cache:'no-store'});
    const hd = await health.json().catch(()=>({}));
    if (!health.ok || !hd.success) throw new Error(hd.error || 'Ollama Local Bridge is not running');
    if (hd.modelInstalled === false) throw new Error(`Vision model ${hd.model} is not installed. Run START-OLLAMA-VISION-BRIDGE.cmd.`);
    return await localOllama();
  }

  button.addEventListener('click', async () => {
    if (!dataUrl) { result.textContent='Upload a chart screenshot first.'; return; }
    button.disabled = true;
    let renderError = null;
    let localError = null;
    try {
      // Local-first: GitHub Pages -> localhost:11435 bridge -> Ollama :11434.
      // This is the correct path when Ollama is running on the user's PC.
      try {
        const a = await tryLocal();
        renderAnalysis(a, `Ollama Local Bridge · ${getModel()}`);
        setStatus('Local Ollama Vision analysis complete.', true);
        return;
      } catch (e) {
        localError = e;
      }

      // Optional remote fallback only when explicitly enabled. Never assume Render can reach localhost.
      const remoteEnabled = String(window.VTRADE_REMOTE_VISION_ENABLED || '').toLowerCase() === 'true';
      if (remoteEnabled) {
        try {
          const a = await tryRender();
          renderAnalysis(a, `Render → Ollama · ${getModel()}`);
          setStatus('Render Vision analysis complete.', true);
          return;
        } catch (e) {
          renderError = e;
        }
      }

      const rmsg = renderError?.message || (remoteEnabled ? 'Render Vision unavailable' : 'Remote Render Vision disabled');
      const lmsg = localError?.message || 'Local Ollama Bridge unavailable';
      result.textContent =
        `Vision unavailable.\n\n` +
        `Render: ${rmsg}\n` +
        `Local: ${lmsg}\n\n` +
        `Required flow:\n` +
        `GitHub Pages → Render → reachable Ollama\n` +
        `or\n` +
        `GitHub Pages → localhost:11435 → Ollama :11434`;
      setStatus('Vision service unavailable — check Render Ollama URL or start local bridge.', false);
    } finally {
      button.disabled=false;
    }
  });
})();
