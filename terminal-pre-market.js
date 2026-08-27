/* V TRADE AI — Pre-Market MTF v7 — LIVE FEED BINDING
 * Source of truth: broker-native /api/analysis/xauusd via /api/pre-market/xauusd.
 * Never invents 0/50-50 when live data is available or when an API call fails.
 */
(() => {
  if (window.__VTRADE_PREMARKET_V7__) return;
  window.__VTRADE_PREMARKET_V7__ = true;

  const TFS = ['M5','M15','H1','H4','D1'];
  const WEIGHTS = {M5:1,M15:2,H1:3,H4:4,D1:5};
  const state = {tf:'M15', rows:{}, raw:null, news:null, busy:false, error:null};
  const $ = id => document.getElementById(id);
  const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
  const pct = v => num(v)==null ? null : Math.max(0,Math.min(100,Math.round(Number(v))));
  const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = v => num(v)==null ? '—' : Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  const val = (o,keys) => { for(const k of keys){ if(o && o[k]!==undefined && o[k]!==null && o[k]!=='') return o[k]; } return null; };
  const biasOf = v => { const s=String(v??'').toUpperCase(); return /BULL|BUY/.test(s)?'BULLISH':/BEAR|SELL/.test(s)?'BEARISH':'NEUTRAL'; };
  const bool = v => v===true || v===1 || String(v).toLowerCase()==='true' || String(v).toUpperCase()==='PASS';
  const lang = () => localStorage.getItem('vtrade_lang') === 'km' ? 'km' : 'en';
  const tr = (en,km) => lang()==='km' ? km : en;

  function api(path){
    const c=window.VTRADE_CONNECTION;
    if(!c?.fetch || !c?.api) throw new Error('Backend connection layer unavailable');
    return c.fetch(c.api(path),{credentials:'omit',cache:'no-store'}).then(async r=>{
      const d=await r.json().catch(()=>({}));
      if(!r.ok || d?.success===false) throw new Error(d?.error || `HTTP ${r.status}`);
      return d;
    });
  }

  function css(){
    if($('vtradePreMarketV7Css')) return;
    const s=document.createElement('style'); s.id='vtradePreMarketV7Css'; s.textContent=`
#vtradePreMarket{margin-top:12px}.v7-card{background:linear-gradient(145deg,#0b1423f5,#070c15f5);border:1px solid #1d2c44;border-radius:16px;padding:16px;box-shadow:0 20px 60px #0008}.v7-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.v7-title{font-size:20px;font-weight:950}.v7-sub{color:#8493ab;font-size:11px;line-height:1.5;margin-top:4px}.v7-actions{display:flex;gap:7px;overflow:auto}.v7-btn{border:1px solid #1d2c44;background:#09111e;border-radius:10px;padding:9px 12px;min-height:42px;color:#cbd5e5;font-weight:800;white-space:nowrap}.v7-btn.active,.v7-btn.primary{background:#5827d2;border-color:#8050ff;color:#fff}.v7-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.v7-box{border:1px solid #1d2c44;border-radius:13px;background:#080f1b;padding:13px;min-width:0}.v7-label{font-size:9px;color:#8493ab;text-transform:uppercase;letter-spacing:.1em}.v7-score{font-size:31px;font-weight:950;margin-top:6px}.v7-row{display:flex;justify-content:space-between;gap:10px;margin-top:9px;font-size:11px}.v7-row b{text-align:right}.v7-buy{color:#22e58a}.v7-sell{color:#ff5968}.v7-neutral,.v7-wait{color:#f2c94c}.v7-pass{color:#22e58a}.v7-error{color:#ff5968}.v7-bar{height:7px;background:#18253b;border-radius:99px;overflow:hidden;margin-top:7px}.v7-bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#6570ff,#35d8ff,#22e58a)}.v7-mtf{display:grid;gap:7px;margin-top:10px}.v7-mtf-row{display:grid;grid-template-columns:46px minmax(0,1fr) 82px 100px;gap:8px;align-items:center;border:1px solid #1d2c44;border-radius:10px;padding:9px;background:#080f1b;font-size:10px}.v7-mini{font-size:9px;color:#8493ab;margin-top:4px}.v7-dir{font-weight:900}.v7-gates{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}.v7-gate{border:1px solid #1d2c44;border-radius:10px;padding:10px;background:#080f1b;font-size:10px}.v7-gate b{display:block;margin-top:5px}.v7-candle{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}.v7-metric{border:1px solid #1d2c44;border-radius:10px;background:#080f1b;padding:10px}.v7-metric span{display:block;color:#8493ab;font-size:9px;text-transform:uppercase}.v7-metric b{display:block;font-size:13px;margin-top:6px}.v7-note{margin-top:10px;color:#8493ab;font-size:10px;line-height:1.55}.v7-status{margin-top:10px;padding:10px;border:1px solid #1d2c44;border-radius:10px;background:#080f1b;color:#a9b6c9;font-size:10px;line-height:1.5}.v7-errorbox{border-color:#7c2532;background:#2b0c13;color:#ff9aa5}.v7-news{margin-top:12px}.v7-news-list{display:grid;gap:8px;margin-top:9px}.v7-news-item{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:10px;padding:10px;border:1px solid #1d2c44;border-radius:10px;background:#080f1b}.v7-impact{width:8px;height:8px;border-radius:50%;margin-top:5px;background:#69788f}.v7-impact.high{background:#ff5968}.v7-impact.medium{background:#f2c94c}.v7-chip{padding:4px 7px;border:1px solid #1d2c44;border-radius:8px;font-size:9px;color:#9fb0c7;height:max-content}@media(max-width:900px){.v7-head{align-items:flex-start;flex-direction:column}.v7-actions{width:100%}.v7-grid{grid-template-columns:1fr}.v7-gates{grid-template-columns:repeat(2,1fr)}.v7-candle{grid-template-columns:repeat(2,1fr)}.v7-mtf-row{grid-template-columns:42px minmax(0,1fr) 62px 72px}}@media(max-width:520px){.v7-mtf-row{grid-template-columns:38px minmax(0,1fr);gap:6px}.v7-mtf-row .v7-dir,.v7-mtf-row .v7-weight{grid-column:2}.v7-gates,.v7-candle{grid-template-columns:1fr 1fr}}
`;
    document.head.appendChild(s);
  }

  function shell(){
    css(); let host=$('vtradePreMarket'); if(host) return host;
    host=document.createElement('section'); host.id='vtradePreMarket';
    host.innerHTML=`<div class="v7-card"><div class="v7-head"><div><div class="v7-title">Pre-Market Zone Analysis</div><div class="v7-sub">${tr('LIVE MTF mapping · broker-native data · M5 → M15 → H1 → H4 → D1','LIVE MTF mapping · broker-native data · M5 → M15 → H1 → H4 → D1')}</div></div><div class="v7-actions">${TFS.map(tf=>`<button class="v7-btn ${tf===state.tf?'active':''}" data-v7-tf="${tf}">${tf}</button>`).join('')}<button class="v7-btn primary" id="v7Analyze">Analyze AI</button></div></div><div id="v7Body"></div><div class="v7-news" id="v7News"></div></div>`;
    const wrap=document.querySelector('.wrap')||document.querySelector('.main'); if(wrap) wrap.prepend(host); else document.body.prepend(host);
    host.querySelectorAll('[data-v7-tf]').forEach(b=>b.onclick=async()=>{state.tf=b.dataset.v7Tf;host.querySelectorAll('[data-v7-tf]').forEach(x=>x.classList.toggle('active',x===b));await load();});
    host.querySelector('#v7Analyze').onclick=load;
    return host;
  }

  function nodeFrom(raw,tf){
    const root=raw?.analysis||raw?.data||raw||{};
    const mtf=root.mtf||root.multiTimeframe||root.timeframes||{};
    return mtf[tf]||mtf[tf.toLowerCase()]||root[tf]||root[tf.toLowerCase()]||{};
  }

  function normalize(tf,d,raw){
    const x=raw&&Object.keys(raw).length?raw:{};
    const buy=pct(val(x,['buyScore','buyPct','buyStrengthPct','buyerPower','longScore','buyProbability']));
    const sell=pct(val(x,['sellScore','sellPct','sellStrengthPct','sellerPower','shortScore','sellProbability']));
    const score=pct(val(x,['directionScore','setupScore','score','confidence']));
    const bias=biasOf(val(x,['bias','direction','trend']));
    const q=d?.quote||d?.mt5Quote||d?.mt5||{};
    const c=x.lastCandle||x.candle||x.latestCandle||(Array.isArray(x.candles)?x.candles[x.candles.length-1]:null)||(Array.isArray(x.bars)?x.bars[x.bars.length-1]:null)||{};
    const price=num(val(d,['price','currentPrice','livePrice'])) ?? num(val(q,['price','bid','ask'])) ?? num(val(x,['price','currentPrice','close'])) ?? num(c.close??c.c);
    const open=num(c.open??c.o??x.open), high=num(c.high??c.h??x.high), low=num(c.low??c.l??x.low), close=num(c.close??c.c??x.close??price);
    const gates=x.gates||x.confirmations||d?.gates||{};
    return {...d,tf,price,currentPrice:price,buyScore:buy,sellScore:sell,directionScore:score,bias,open,high,low,close,gates};
  }

  async function load(){
    if(state.busy)return; state.busy=true; state.error=null; render();
    try{
      // Use the authoritative MT5-backed pre-market snapshot as the single source
      // for all five timeframes. The legacy per-TF route could return an incomplete
      // analysis object (often producing 0%/NEUTRAL even while MT5 was READY).
      // Keep the legacy analysis as a safe fallback only.
      let raw;
      try {
        raw = await api('/api/pre-market/mt5-authoritative');
      } catch (authoritativeError) {
        raw = await api('/api/analysis/xauusd');
      }
      state.raw=raw;
      const rows={};
      for(const tf of TFS) rows[tf]=normalize(tf, raw, nodeFrom(raw,tf));
      // The quote from /api/analysis/xauusd is authoritative if a TF route omits price.
      const root=raw?.analysis||raw?.data||raw||{};
      const rootPrice=num(val(raw,['price','currentPrice','livePrice'])) ?? num(val(root,['price','currentPrice','livePrice'])) ?? num(val(raw?.quote||raw?.mt5||{},['price','bid','ask']));
      if(rootPrice!=null) for(const tf of TFS) if(rows[tf].price==null) rows[tf].price=rootPrice;
      state.rows=rows;
      const wb=TFS.reduce((a,tf)=>{const r=rows[tf],w=WEIGHTS[tf];if(r.buyScore!=null){a.b+=r.buyScore*w;a.bw+=w}if(r.sellScore!=null){a.s+=r.sellScore*w;a.sw+=w}return a},{b:0,s:0,bw:0,sw:0});
      state.buy=wb.bw?Math.round(wb.b/wb.bw):null; state.sell=wb.sw?Math.round(wb.s/wb.sw):null;
      state.bias=state.buy==null&&state.sell==null?'NEUTRAL':state.buy>state.sell?'BULLISH':state.sell>state.buy?'BEARISH':'NEUTRAL';
      render(); loadNews();
    }catch(e){state.error=String(e?.message||e);state.rows={};render();}
    finally{state.busy=false;}
  }

  function stats(r){if(r.open==null||r.high==null||r.low==null||r.close==null)return null;const range=Math.max(0,r.high-r.low),body=Math.abs(r.close-r.open),up=Math.max(0,r.high-Math.max(r.open,r.close)),lo=Math.max(0,Math.min(r.open,r.close)-r.low);const bp=range?body/range*100:0,upP=range?up/range*100:0,loP=range?lo/range*100:0;let pattern='NORMAL';if(bp<=30&&loP>=55&&upP<=25)pattern='HAMMER / REJECTION';else if(bp<=30&&upP>=55&&loP<=25)pattern='SHOOTING STAR / REJECTION';else if(bp<=12&&upP>=35&&loP>=35)pattern='DOJI / INDECISION';else if(bp>=65)pattern=r.close>=r.open?'STRONG BULLISH BODY':'STRONG BEARISH BODY';return{bp,upP,loP,pattern};}
  function zone(z){if(Array.isArray(z)&&z.length>=2&&z.every(v=>num(v)!=null))return `${fmt(Math.min(...z))} – ${fmt(Math.max(...z))}`;if(z&&num(z.low)!=null&&num(z.high)!=null)return `${fmt(Math.min(z.low,z.high))} – ${fmt(Math.max(z.low,z.high))}`;return '—';}
  function gate(label,v){const ok=bool(v);return `<div class="v7-gate"><span>${label}</span><b class="${ok?'v7-pass':'v7-wait'}">${ok?'PASS':'WAIT'}</b></div>`;}

  function render(){
    const body=$('v7Body');if(!body)return; const rows=state.rows||{}, r=rows[state.tf]||{}; const s=stats(r); const gates=r.gates||{};
    const ready=Object.values(rows).some(x=>x?.price!=null); const buy=state.buy,sell=state.sell,bias=state.bias||'NEUTRAL';
    const status=state.error?`<div class="v7-status v7-errorbox"><b>LIVE DATA ERROR</b><br>${esc(state.error)}</div>`:ready?`<div class="v7-status"><b class="v7-pass">MT5 LIVE DATA CONNECTED</b> · ${TFS.filter(tf=>rows[tf]?.price!=null).length}/5 timeframes mapped. Source: broker-native backend.</div>`:`<div class="v7-status"><b class="v7-wait">WAIT — MT5 DATA NOT READY</b><br>UI will not fabricate 0% or 50/50 values.</div>`;
    const mtf=TFS.map(tf=>{const x=rows[tf]||{},bp=x.buyScore,sp=x.sellScore,d=x.bias||'NEUTRAL';return `<div class="v7-mtf-row"><b>${tf}</b><div><div class="v7-bar"><i style="width:${bp==null?0:bp}%"></i></div><div class="v7-mini">${x.price!=null?`Price ${fmt(x.price)} · Score ${x.directionScore==null?'—':x.directionScore}`:'DATA NOT READY'}</div></div><span class="v7-dir ${d==='BULLISH'?'v7-buy':d==='BEARISH'?'v7-sell':'v7-neutral'}">${d}</span><span class="v7-weight">BUY ${bp==null?'—':bp}%<br>SELL ${sp==null?'—':sp}%</span></div>`}).join('');
    const cs=s?`<div class="v7-candle"><div class="v7-metric"><span>Open</span><b>${fmt(r.open)}</b></div><div class="v7-metric"><span>High</span><b>${fmt(r.high)}</b></div><div class="v7-metric"><span>Low</span><b>${fmt(r.low)}</b></div><div class="v7-metric"><span>Close</span><b>${fmt(r.close)}</b></div><div class="v7-metric"><span>Body</span><b>${csafe(s.bp)}%</b></div><div class="v7-metric"><span>Upper Wick</span><b>${csafe(s.upP)}%</b></div><div class="v7-metric"><span>Lower Wick</span><b>${csafe(s.loP)}%</b></div><div class="v7-metric"><span>Pattern</span><b>${esc(s.pattern)}</b></div></div>`:`<div class="v7-note">${tr('Candle OHLC is not available for the selected timeframe yet.','Candle OHLC មិនទាន់មានសម្រាប់ timeframe នេះទេ។')}</div>`;
    const bzone=val(r,['buyZone'])||r.zones?.buyZone,szone=val(r,['sellZone'])||r.zones?.sellZone;
    body.innerHTML=`<div class="v7-grid"><div class="v7-box"><div class="v7-label">Pre-Market MTF Direction Strength</div><div class="v7-score v7-buy">${buy==null?'—':buy}%</div><div class="v7-bar"><i style="width:${buy??0}%"></i></div><div class="v7-row"><span>BUY Strength</span><b class="v7-buy">${buy==null?'—':buy}%</b></div><div class="v7-row"><span>SELL Strength</span><b class="v7-sell">${sell==null?'—':sell}%</b></div><div class="v7-row"><span>MTF Bias</span><b class="${bias==='BULLISH'?'v7-buy':bias==='BEARISH'?'v7-sell':'v7-neutral'}">${bias}</b></div>${status}</div><div class="v7-box"><div class="v7-label">BUY ZONE / SELL ZONE · ${state.tf}</div><div class="v7-row"><span>BUY ZONE</span><b class="v7-buy">${zone(bzone)}</b></div><div class="v7-row"><span>SELL ZONE</span><b class="v7-sell">${zone(szone)}</b></div><div class="v7-row"><span>Current Price</span><b>${fmt(r.price)}</b></div><div class="v7-row"><span>Entry area</span><b>${r.price==null?'—':bias==='BULLISH'?'BELOW PRICE':bias==='BEARISH'?'ABOVE PRICE':'BALANCED'}</b></div></div></div><div class="v7-box" style="margin-top:10px"><div class="v7-label">CANDLE-OPEN MTF PROCESSING · LIVE</div><div class="v7-mtf">${mtf}</div></div><div class="v7-grid" style="margin-top:10px"><div class="v7-box"><div class="v7-label">CANDLE / WICK / PATTERN · ${state.tf}</div>${cs}</div><div class="v7-box"><div class="v7-label">ICT EXECUTION GATES</div><div class="v7-gates">${gate('Liquidity Sweep',gates.liquiditySweep)}${gate('MSS',gates.mss)}${gate('BOS',gates.bos)}${gate('Displacement',gates.displacement)}${gate('FVG',gates.fvg)}${gate('Order Block',gates.orderBlock)}${gate('Premium / Discount',gates.premiumDiscount)}${gate('Execution Zone',gates.executionZone)}${gate('Momentum',gates.momentum)}${gate('Spread',gates.spread)}</div></div></div>`;
  }
  function csafe(v){return num(v)==null?'—':Math.round(v)}

  async function loadNews(){
    try{const d=await api('/api/market-news');state.news=d;const host=$('v7News');if(!host)return;const items=(d.items||[]).slice(0,8);host.innerHTML=`<div class="v7-box"><div class="v7-label">MACRO & BREAKING NEWS · 60 MIN</div><div class="v7-news-list">${items.length?items.map(x=>`<div class="v7-news-item"><i class="v7-impact ${String(x.impact||'').toLowerCase()}"></i><div><b>${esc(x.title)}</b><div class="v7-mini">${esc(x.source||'News')} · ${esc(x.relevance||'MACRO')}</div></div><span class="v7-chip">${esc(x.impact||'LOW')}</span></div>`).join(''):`<div class="v7-note">No news items available.</div>`}</div></div>`;}catch(e){const host=$('v7News');if(host)host.innerHTML=`<div class="v7-box"><div class="v7-note">News unavailable: ${esc(e.message||e)}</div></div>`;}
  }

  function boot(){shell();load();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
