(function(){
  const $ = id => document.getElementById(id);
  const file = $('visionFile'), preview = $('visionPreview'), status = $('visionStatus');
  const analyze = $('visionAnalyze'), output = $('visionOutput');

  if(!file) return;

  let dataUrl = '';
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if(!f) return;
    if(!/^image\/(png|jpeg|webp)$/.test(f.type)) { status.textContent='PNG/JPEG/WebP only'; return; }
    if(f.size > 6*1024*1024) { status.textContent='Maximum 6 MB'; return; }
    dataUrl = await new Promise((resolve,reject)=>{
      const r=new FileReader(); r.onload=()=>resolve(r.result); r.onerror=reject; r.readAsDataURL(f);
    });
    preview.src=dataUrl; preview.hidden=false; analyze.disabled=false;
    status.textContent='Screenshot ready — press Analyze';
    output.textContent='';
  });

  analyze.addEventListener('click', async()=>{
    if(!dataUrl) return;
    analyze.disabled=true; status.textContent='Analyzing locally with Qwen…';
    output.textContent='';
    try{
      const r=await fetch('/api/v5/ai/vision/chart',{
        method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
        body:JSON.stringify({imageDataUrl:dataUrl})
      });
      const j=await r.json();
      if(!r.ok || !j.success) throw new Error(j.error || 'Vision analysis failed');
      const a=j.analysis || {};
      output.textContent =
        `Symbol: ${a.symbol || 'UNKNOWN'}\n`+
        `Timeframe: ${a.timeframe || 'UNKNOWN'}\n`+
        `Visible Price: ${a.visiblePrice ?? 'UNKNOWN'}\n`+
        `Trend: ${a.trend || 'UNKNOWN'}\n`+
        `Liquidity Sweep: ${a.liquiditySweep || 'UNCLEAR'}\n`+
        `MSS/BOS: ${a.mssBos || 'UNCLEAR'}\n`+
        `FVG: ${a.fvg || 'UNCLEAR'}\n`+
        `Order Block: ${a.orderBlock || 'UNCLEAR'}\n`+
        `Confidence: ${a.confidence ?? 0}%\n\n`+
        `Evidence:\n• ${(a.evidence||[]).join('\n• ') || 'None'}\n\n`+
        `Blockers:\n• ${(a.blockers||[]).join('\n• ') || 'None'}\n\n`+
        `Signal Gate: ${a.signal || 'WAIT'}\n`+
        `Entry / SL / TP: controlled by V-ZONE ICT Engine`;
      status.textContent='Done — evidence extracted locally';
    }catch(e){
      status.textContent='Vision error';
      output.textContent=String(e.message||e);
    }finally{ analyze.disabled=false; }
  });
})();