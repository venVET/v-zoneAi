/* V TRADE AI — Pre-Market + Macro News Engine
 * Server-side only. No Telegram, no broker credentials, no order execution.
 * Truth Social is read-only. Secrets are supplied through Render environment variables.
 */
'use strict';

module.exports = function installPreMarketNewsEngine(app) {
  if (!app || app.__VTRADE_PREMARKET_NEWS__) return;
  app.__VTRADE_PREMARKET_NEWS__ = true;

  const PORT = Number(process.env.PORT || 10000);
  const HOST = String(process.env.INTERNAL_HOST || '127.0.0.1');
  const TRUTH_BASE = String(process.env.TRUTH_SOCIAL_BASE_URL || 'https://truthsocial.com').replace(/\/$/, '');
  const TRUTH_API_URL = String(process.env.TRUTH_API_URL || '').trim().replace(/\/$/, '');
  const TRUTH_API_TOKEN = String(process.env.TRUTH_API_TOKEN || '').trim();
  const NEWS_API_URL = String(process.env.NEWS_API_URL || '').trim();
  const NEWS_API_KEY = String(process.env.NEWS_API_KEY || '').trim();
  const CACHE_MS = Math.max(30_000, Number(process.env.PREMARKET_NEWS_CACHE_MS || 60_000));
  const LOOKBACK_MS = 60 * 60 * 1000;
  let cache = { at: 0, data: null };

  const json = (res, status, body) => res.status(status).json(body);
  const cleanHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
  const strip = (s, max=600) => cleanHtml(s).slice(0, max);
  const impactOf = (text) => {
    const t = String(text || '').toLowerCase();
    const high = /(fed|fomc|rate decision|interest rate|inflation|cpi|ppi|nfp|payroll|jobs report|tariff|sanction|war|missile|iran|israel|ukraine|russia|oil|crude|emergency|executive order|ceasefire|china|treasury|dollar|usd|gold|xauusd)/.test(t);
    const medium = /(economy|employment|trade|budget|election|congress|bitcoin|crypto|stock|market|energy|opec)/.test(t);
    return high ? 'HIGH' : medium ? 'MEDIUM' : 'LOW';
  };
  const signalOf = (text) => {
    const t = String(text || '').toLowerCase();
    if (/(gold|xau|safe haven|war|missile|iran|israel|sanction|inflation|rate cut|dovish)/.test(t)) return 'XAUUSD_RELEVANT';
    if (/(dollar|usd|treasury|yield|fed|fomc|rate hike|hawkish)/.test(t)) return 'USD_RELEVANT';
    if (/(oil|crude|opec)/.test(t)) return 'RISK/OIL';
    return 'MACRO';
  };
  const toTime = (v) => { const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : null; };

  async function getJson(url, options={}) {
    const r = await fetch(url, { ...options, signal: AbortSignal.timeout(7000), headers: { 'accept':'application/json,text/plain,*/*', ...(options.headers||{}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function getTruthStatuses() {
    const headers = {};
    if (TRUTH_API_TOKEN) headers.authorization = `Bearer ${TRUTH_API_TOKEN}`;

    if (TRUTH_API_URL) {
      const raw = await getJson(TRUTH_API_URL, { headers });
      return Array.isArray(raw) ? raw : (Array.isArray(raw.statuses) ? raw.statuses : []);
    }

    // Truth Social is Mastodon-based. Public status endpoints are read-only; if the
    // public endpoint is blocked, Render can use TRUTH_API_URL/TRUTH_API_TOKEN instead.
    const account = await getJson(`${TRUTH_BASE}/api/v1/accounts/lookup?acct=realDonaldTrump`, { headers });
    if (!account?.id) throw new Error('Truth Social account lookup unavailable');
    return await getJson(`${TRUTH_BASE}/api/v1/accounts/${encodeURIComponent(account.id)}/statuses?limit=20&exclude_replies=true&exclude_reblogs=false`, { headers });
  }

  async function getGoogleNews() {
    const q = encodeURIComponent('(gold OR XAUUSD OR Federal Reserve OR USD OR tariffs OR Iran OR oil)');
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    const r = await fetch(url, { signal: AbortSignal.timeout(7000), headers: { 'user-agent':'V-TRADE-AI/1.0' } });
    if (!r.ok) throw new Error(`Google News HTTP ${r.status}`);
    const xml = await r.text();
    const items = [];
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
    for (const b of blocks.slice(0, 20)) {
      const val = (tag) => { const m=b.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i')); return m ? cleanHtml(m[1]) : ''; };
      const title=val('title'), link=val('link'), pub=val('pubDate'), source=val('source');
      const published=toTime(pub);
      if (!title || !published) continue;
      items.push({ id:`gnews-${published}-${title}`, source:source||'News', title:strip(title,180), text:strip(title,400), publishedAt:published, impact:impactOf(title), relevance:signalOf(title), url:link||null, type:'NEWS' });
    }
    return items;
  }

  async function getConfiguredNewsApi() {
    if (!NEWS_API_URL) return [];
    const sep = NEWS_API_URL.includes('?') ? '&' : '?';
    const url = `${NEWS_API_URL}${sep}q=${encodeURIComponent('gold XAUUSD USD Federal Reserve tariffs Iran oil')}`;
    const headers = NEWS_API_KEY ? { authorization:`Bearer ${NEWS_API_KEY}`, 'x-api-key':NEWS_API_KEY } : {};
    const raw = await getJson(url,{headers});
    const arr = raw?.articles || raw?.data || (Array.isArray(raw) ? raw : []);
    return arr.map((x,i)=>({
      id:`newsapi-${x.id||x.url||i}`, source:x.source?.name||x.source||'News API', title:strip(x.title||x.headline||x.name,180),
      text:strip(x.description||x.content||x.title,500), publishedAt:toTime(x.publishedAt||x.pubDate||x.date||Date.now()),
      impact:impactOf(`${x.title||''} ${x.description||''}`), relevance:signalOf(`${x.title||''} ${x.description||''}`), url:x.url||x.link||null, type:'NEWS'
    })).filter(x=>x.title && x.publishedAt);
  }

  async function buildNews() {
    const cutoff=Date.now()-LOOKBACK_MS;
    const all=[];
    try {
      const statuses=await getTruthStatuses();
      for(const s of statuses||[]) {
        const published=toTime(s.created_at||s.createdAt||s.date);
        if(!published || new Date(published).getTime()<cutoff) continue;
        const text=strip(s.content||s.text||s.spoiler_text,900);
        if(!text) continue;
        all.push({id:`truth-${s.id}`,source:'Truth Social',title:strip(text,180),text,publishedAt:published,impact:impactOf(text),relevance:signalOf(text),url:s.url||`${TRUTH_BASE}/@realDonaldTrump`,type:'TRUTH'});
      }
    } catch(e) {
      all.push({id:'truth-status',source:'Truth Social',title:'Truth Social feed unavailable',text:String(e.message||e),publishedAt:new Date().toISOString(),impact:'LOW',relevance:'MACRO',url:'https://truthsocial.com/@realDonaldTrump',type:'STATUS'});
    }

    try { all.push(...await getConfiguredNewsApi()); } catch(e) { /* optional */ }
    if (!all.some(x=>x.type==='NEWS')) {
      try { all.push(...await getGoogleNews()); } catch(e) { /* optional fallback */ }
    }

    const seen=new Set();
    const items=all.filter(x=>{const k=String(x.title).toLowerCase();if(seen.has(k))return false;seen.add(k);return true;})
      .sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt)).slice(0,24);
    const high=items.filter(x=>x.impact==='HIGH').length;
    return { windowMinutes:60, generatedAt:new Date().toISOString(), items, highImpactCount:high, truthConnected:items.some(x=>x.type==='TRUTH' && x.source==='Truth Social'), sourcePolicy:'Truth Social + configured News API + Google News fallback' };
  }

  async function getAnalysis(req) {
    const token=String(req.get('x-vtrade-auth')||'');
    const url=`http://${HOST}:${PORT}/api/analysis/xauusd`;
    const r=await fetch(url,{headers: token ? {'x-vtrade-auth':token} : {},signal:AbortSignal.timeout(7000)});
    if(!r.ok) throw new Error(`analysis HTTP ${r.status}`);
    return r.json();
  }

  const n=v=>Number.isFinite(Number(v))?Number(v):null;
  const score=v=>n(v?.score??v?.value??v?.confidence??v);
  const bias=v=>{const s=String(v?.bias??v?.direction??v??'').toUpperCase();return /BULL|BUY/.test(s)?'BULLISH':/BEAR|SELL/.test(s)?'BEARISH':'NEUTRAL';};
  const pick=(...x)=>x.find(v=>v!==undefined&&v!==null&&v!=='');

  function buildZone(raw, tf) {
    const a=raw?.analysis||raw?.data||raw||{};
    const mtf=a.mtf||a.multiTimeframe||a.timeframes||{};
    const node=mtf[tf]||mtf[tf.toLowerCase()]||a[tf]||a[tf.toLowerCase()]||{};
    const price=n(pick(a.price,a.livePrice,a.mt5?.price,a.quote?.price,a.mt5Quote?.price));
    const b=bias(pick(node.bias,node.direction,a.bias,a.direction));
    const setup=score(pick(node.setupScore,node.score,node.confidence));
    const buy=score(pick(node.buyScore,node.buyProbability,node.buy?.score,node.longScore));
    const sell=score(pick(node.sellScore,node.sellProbability,node.sell?.score,node.shortScore));
    const atr=n(pick(node.atr,a.atr,a.ATR));
    const width=Math.max(0.8,(atr||Math.max(1.5,(price||4400)*0.00055))*0.65);
    const zones=pick(node.zones,node.executionZones,a.zones,a.executionZones)||{};
    const explicitBuy=pick(zones.buy,zones.buyZone,node.buyZone,a.buyZone);
    const explicitSell=pick(zones.sell,zones.sellZone,node.sellZone,a.sellZone);
    const make=(z,center)=>Array.isArray(z)?z:(z&&typeof z==='object'&&n(z.low)!=null&&n(z.high)!=null?[n(z.low),n(z.high)]:center==null?null:[center-width,center+width]);
    // If the backend does not yet expose explicit ICT zones, create a transparent
    // provisional pre-market zone around the live quote. It is never an execution signal.
    const center=price;
    const buyZone=make(explicitBuy,b==='BULLISH'?center-width:center-width*2);
    const sellZone=make(explicitSell,b==='BEARISH'?center+width:center+width*2);
    const gates={
      liquiditySweep:!!pick(node.liquiditySweep,node.sweep,a.liquiditySweep,a.sweep),
      mss:!!pick(node.mss,node.marketStructureShift,a.mss,a.marketStructureShift),
      bos:!!pick(node.bos,node.breakOfStructure,a.bos,a.breakOfStructure),
      fvg:!!pick(node.fvg,node.fairValueGap,a.fvg),
      orderBlock:!!pick(node.orderBlock,node.ob,a.orderBlock,a.ob)
    };
    const base=setup ?? (b==='BULLISH'?buy:b==='BEARISH'?sell:Math.max(buy||0,sell||0));
    const newsRisk=0;
    return {symbol:'XAUUSD',tf,price,bias:b,buyScore:buy,sellScore:sell,setupScore:base,buyZone,sellZone,atr,provisionalZones:!explicitBuy&&!explicitSell,gates,newsRisk,updatedAt:new Date().toISOString()};
  }

  app.get('/api/pre-market/xauusd', async (req,res)=>{
    try {
      const tf=String(req.query.tf||'M15').toUpperCase();
      if(!['M5','M15','H1','H4','D1'].includes(tf)) return json(res,400,{success:false,error:'Invalid timeframe'});
      const raw=await getAnalysis(req);
      return json(res,200,{success:true,...buildZone(raw,tf)});
    } catch(e) { return json(res,502,{success:false,error:String(e.message||e)}); }
  });

  app.get('/api/market-news', async (_req,res)=>{
    try {
      if(cache.data && Date.now()-cache.at<CACHE_MS) return json(res,200,{success:true,...cache.data,cached:true});
      const data=await buildNews(); cache={at:Date.now(),data};
      return json(res,200,{success:true,...data,cached:false});
    } catch(e) { return json(res,502,{success:false,error:String(e.message||e)}); }
  });

  app.get('/api/pre-market/ai', async (req,res)=>{
    const key=String(process.env.OPENAI_API_KEY||'').trim();
    const enabled=String(process.env.OPENAI_ENABLED||'false').toLowerCase()==='true';
    if(!enabled || !key) return json(res,503,{success:false,error:'AI confirmation is not enabled on the server'});
    try {
      const tf=String(req.query.tf||'M15').toUpperCase();
      const [pm,news]=await Promise.all([
        fetch(`http://${HOST}:${PORT}/api/pre-market/xauusd?tf=${encodeURIComponent(tf)}`,{headers:{'x-vtrade-auth':String(req.get('x-vtrade-auth')||'')},signal:AbortSignal.timeout(7000)}).then(r=>r.json()),
        buildNews()
      ]);
      const model=String(process.env.OPENAI_MODEL||'gpt-5.6-luna');
      const prompt={symbol:'XAUUSD',timeframe:tf,preMarket:pm,news:news.items.slice(0,12),instruction:'Analyze only as a pre-market decision-support layer. Return JSON with bias, confidence_0_100, buy_zone, sell_zone, key_risks, key_drivers, invalidation, and verdict. Do not claim certainty, do not place orders, and do not send Telegram.'};
      const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${key}`},body:JSON.stringify({model,input:[{role:'system',content:'You are a disciplined XAUUSD macro/ICT pre-market analyst. Use only supplied data and label uncertainty.'},{role:'user',content:JSON.stringify(prompt)}],text:{format:{type:'json_object'}}}),signal:AbortSignal.timeout(Math.max(5000,Number(process.env.OPENAI_TIMEOUT_MS||9000)))});
      if(!r.ok) throw new Error(`OpenAI HTTP ${r.status}`);
      const out=await r.json();
      const text=out.output_text||out.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('')||'{}';
      let result={}; try{result=JSON.parse(text)}catch{result={verdict:text}};
      return json(res,200,{success:true,model,generatedAt:new Date().toISOString(),...result});
    } catch(e) { return json(res,502,{success:false,error:String(e.message||e)}); }
  });

  console.log('[PRE-MARKET] zone + 60m macro/news engine installed');
};
