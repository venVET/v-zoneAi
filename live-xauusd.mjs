const API=(process.env.VTRADE_API||'https://v-trade-ai.onrender.com').replace(/\/$/,'');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const n=v=>Number.isFinite(Number(v))?Number(v):null;
async function get(path){
  const r=await fetch(API+path,{cache:'no-store',headers:{Accept:'application/json','x-vtrade-request':'live-cli-20260829'}});
  const t=await r.text(); let d={}; try{d=t?JSON.parse(t):{};}catch{throw new Error('Backend returned non-JSON: '+t.slice(0,120));}
  if(!r.ok) throw new Error(d.error||`HTTP ${r.status}`); return d;
}
(async()=>{
  console.clear(); console.log('V TRADE AI — LIVE XAUUSD TERMINAL'); console.log('Backend:',API); console.log('Source: Render → VT Markets MT5 (server authoritative)\n');
  let d;
  for(let i=1;i<=4;i++){try{d=await get('/api/analysis/xauusd?live='+Date.now());break}catch(e){console.log(`Waiting for live backend (${i}/4): ${e.message}`);if(i<4)await sleep(1500);}}
  if(!d){console.error('\nNO LIVE DATA. Do not use old/local signal output.');process.exit(2);}
  const p=n(d.livePrice), bid=n(d.bid), ask=n(d.ask), age=n(d.priceAgeSec), q=d.brokerConnected;
  console.log('=== BROKER QUOTE ===');
  console.log('XAUUSD:',p??'—',' BID:',bid??'—',' ASK:',ask??'—');
  console.log('Feed:',d.source||'—',' Connected:',q?'YES':'NO',' Quote age:',age==null?'—':age+'s');
  console.log('\n=== ICT SIGNAL ===');
  console.log('Signal:',d.signal||'WAIT'); console.log('Score:',d.score?.confidence??d.confidence??'—');
  console.log('Status:',d.status||'—'); console.log('Entry:',d.entry??'—'); console.log('SL:',d.stopLoss??'—');
  console.log('TP1:',d.takeProfit?.[0]??'—',' TP2:',d.takeProfit?.[1]??'—',' TP3:',d.takeProfit?.[2]??'—');
  console.log('\n=== MTF ===');
  for(const tf of ['M1','M5','M15','H1','H4','D1']){const x=d.timeframes?.[tf]||{}; console.log(`${tf}:`,x.structure?.bias||'UNAVAILABLE', 'score', x.directionScore??'—');}
  if(p==null||age==null||age>15) {console.log('\nBLOCK: quote is missing/stale.');process.exitCode=3;}
  console.log('\nIMPORTANT: This CLI contains NO fallback/hardcoded XAUUSD price. If you see old values such as 2356/2373, you are running an old script outside this package.');
})().catch(e=>{console.error('\nLIVE TERMINAL ERROR:',e.message);process.exit(1);});
