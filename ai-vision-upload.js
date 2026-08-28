'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const input = $('visionImage');
  const preview = $('visionPreview');
  const result = $('visionResult');
  const button = $('visionAnalyze');
  if (!input || !preview || !result || !button) return;

  let dataUrl = '';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
      result.textContent = 'Only PNG, JPG or WebP is supported.';
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      result.textContent = 'Image must be 6 MB or smaller.';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      dataUrl = String(reader.result || '');
      preview.src = dataUrl;
      preview.hidden = false;
      result.textContent = 'Screenshot ready. Click Analyze.';
    };
    reader.readAsDataURL(file);
  });

  button.addEventListener('click', async () => {
    if (!dataUrl) { result.textContent = 'Upload a chart screenshot first.'; return; }
    button.disabled = true;
    result.textContent = 'Analyzing visible evidence…';
    try {
      const api = window.VTRADE_API_BASE || window.VTRADE_API || window.VTRADE_BACKEND || 'https://v-trade-ai.onrender.com';
      const token = localStorage.getItem('vtrade_auth_token') || sessionStorage.getItem('vtrade_auth_token') || '';
      const r = await fetch(`${api.replace(/\/$/,'')}/api/v5/ai/vision/chart`, {
        method:'POST',
        headers:{'Content-Type':'application/json', ...(token ? {'x-vtrade-auth':token} : {})},
        credentials:'omit',
        body:JSON.stringify({imageDataUrl:dataUrl})
      });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.error || `HTTP ${r.status}`);
      const a = d.analysis || {};
      result.textContent =
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
    } catch(e) {
      result.textContent = `Vision unavailable: ${e.message}`;
    } finally {
      button.disabled = false;
    }
  });
})();
