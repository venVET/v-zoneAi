/* V TRADE AI — Single Backend Connection Layer */
(() => {
  if (window.VTRADE_CONNECTION) return;

  const BACKEND = 'https://v-trade-ai.onrender.com';
  const AUTH_KEY = 'vtrade_auth_token';
  const LEGACY_AUTH_KEY = 'vtrade_auth';
  const USER_DASHBOARD = 'premium-dashboard-live.html?v=20260829-final-v10';
  const ADMIN_DASHBOARD = 'admin-dashboard.html?v=20260819-admin-dashboard';

  const authToken = () => sessionStorage.getItem(AUTH_KEY) || sessionStorage.getItem(LEGACY_AUTH_KEY) || localStorage.getItem(AUTH_KEY) || localStorage.getItem(LEGACY_AUTH_KEY) || '';
  const backendRequest = input => { try { const url = typeof input === 'string' ? input : input?.url || ''; if (url.startsWith('/api/')) return true; return new URL(url, location.href).origin === BACKEND; } catch { return false; } };
  const headers = (input, isBackend = true) => { const h = new Headers(input || {}); if (isBackend) { const token = authToken(); if (token) h.set('x-vtrade-auth', token); } return h; };
  const originalFetch = window.fetch.bind(window);
  const vfetch = async (input, init = {}) => {
    let target = input, url = '';
    try { url = typeof input === 'string' ? input : input?.url || ''; } catch {}
    const relativeApi = url.startsWith('/api/');
    const isBackend = relativeApi || backendRequest(input);
    if (relativeApi) target = BACKEND + url;
    const requestHeaders = headers(init.headers, isBackend);
    // Authentication is carried explicitly by x-vtrade-auth. Do not rely on
    // cross-site cookies from GitHub Pages to Render; this avoids browser
    // third-party-cookie/CORS credential failures after login.
    const options = { ...init, credentials: isBackend ? 'omit' : init.credentials, cache: isBackend ? 'no-store' : init.cache, headers: requestHeaders, mode: isBackend ? 'cors' : (init.mode || undefined) };
    if (target instanceof Request) { target = new Request(target, { headers: requestHeaders }); delete options.headers; }
    try {
      const response = await originalFetch(target, options);
      if (isBackend && response.status === 401) window.dispatchEvent(new CustomEvent('vtrade:session-expired'));
      return response;
    } catch (error) {
      if (isBackend) { const e = new Error(`Backend connection failed: ${String(error?.message || error)}`); e.cause = error; e.backend = BACKEND; throw e; }
      throw error;
    }
  };

  window.fetch = vfetch;
  window.VTRADE_CONNECTION = Object.freeze({
    backend: BACKEND,
    api: path => `${BACKEND}${String(path || '').startsWith('/') ? path : `/${path || ''}`}`,
    token: authToken,
    headers: input => headers(input, true),
    fetch: vfetch,
    clearSession: () => { sessionStorage.removeItem(AUTH_KEY); sessionStorage.removeItem(LEGACY_AUTH_KEY); sessionStorage.removeItem('vtrade_user'); localStorage.removeItem(AUTH_KEY); localStorage.removeItem(LEGACY_AUTH_KEY); },
    status: async () => { try { const r = await vfetch(BACKEND + '/api/health', { credentials: 'omit' }); return r.ok ? {ok:true,status:r.status,backend:BACKEND} : {ok:false,status:r.status,backend:BACKEND}; } catch (error) { return {ok:false,status:0,backend:BACKEND,error:String(error?.message || error)}; } }
  });
  window.VTRADE_API = BACKEND;
  window.VTRADE_BACKEND = BACKEND;

  const currentFile = () => String(location.pathname.split('/').pop() || '').toLowerCase();
  if ((currentFile() === 'dashboard.html' || currentFile() === 'premium-dashboard-live.html') && !authToken()) { location.replace('connection.html?required=login'); return; }
  window.addEventListener('vtrade:session-expired', () => { if (currentFile() === 'dashboard.html' || currentFile() === 'premium-dashboard-live.html') { window.VTRADE_CONNECTION.clearSession(); location.replace('connection.html?expired=1'); } });

  function installAccountLayer() {
    if (currentFile() !== 'dashboard.html' && currentFile() !== 'premium-dashboard-live.html') return;
    const top = document.querySelector('.top');
    if (!top || document.getElementById('vtradeAccountLayer')) return;
    const css = document.createElement('style'); css.id = 'vtradeAccountLayerCss'; css.textContent = `
.vtrade-account{position:relative;display:flex;align-items:center;margin-left:8px;z-index:90}.vtrade-account-btn{display:flex;align-items:center;gap:8px;min-height:44px;padding:5px 10px 5px 6px;border:1px solid #263650;border-radius:12px;background:#09111e;color:#fff;cursor:pointer}.vtrade-avatar{width:31px;height:31px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#5120ff,#aa72ff);font-weight:900;font-size:12px}.vtrade-account-name{max-width:105px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;font-size:11px;font-weight:800}.vtrade-account-role{display:block;color:#8493ab;font-size:9px;font-weight:500;margin-top:2px}.vtrade-chevron{color:#8493ab;font-size:10px}.vtrade-menu{position:absolute;right:0;top:52px;width:245px;padding:8px;border:1px solid #263650;border-radius:15px;background:#07101cf7;box-shadow:0 22px 70px #000b;backdrop-filter:blur(18px);display:none}.vtrade-menu.show{display:block;animation:vtradeMenuIn .16s ease}@keyframes vtradeMenuIn{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}.vtrade-menu-head{padding:9px 10px 11px;border-bottom:1px solid #1b2a41;margin-bottom:5px}.vtrade-menu-head b{font-size:12px}.vtrade-menu-head small{display:block;color:#8493ab;margin-top:3px;font-size:10px}.vtrade-menu a,.vtrade-menu button{width:100%;display:flex;align-items:center;gap:9px;border:0;border-radius:9px;background:transparent;color:#cbd5e5;text-decoration:none;text-align:left;padding:11px 10px;cursor:pointer;font:inherit;font-size:11px}.vtrade-menu a:hover,.vtrade-menu button:hover{background:#111d30;color:#fff}.vtrade-menu .admin-link{color:#c6b4ff}.vtrade-menu .logout{color:#ff7c89}.vtrade-menu .logout:hover{background:#2b0c13}
@media(max-width:900px){.vtrade-account{grid-area:account;width:100%;margin:4px 0 0}.vtrade-account-btn{width:100%;justify-content:flex-start}.vtrade-account-name{max-width:none}.vtrade-menu{position:absolute;left:0;right:auto;top:52px;width:min(245px,calc(100vw - 24px))}}
`;
    document.head.appendChild(css);
    const layer = document.createElement('div'); layer.id = 'vtradeAccountLayer'; layer.className = 'vtrade-account';
    layer.innerHTML = `<button class="vtrade-account-btn" type="button" aria-expanded="false" aria-label="Account menu"><span class="vtrade-avatar" id="vtradeAvatar">V</span><span class="vtrade-account-name"><span id="vtradeAccountName">Account</span><span class="vtrade-account-role" id="vtradeAccountRole">Session</span></span><span class="vtrade-chevron">⌄</span></button><div class="vtrade-menu" id="vtradeAccountMenu"><div class="vtrade-menu-head"><b id="vtradeMenuName">Account</b><small id="vtradeMenuEmail">Authenticated session</small></div><a id="vtradeUserLink" href="${USER_DASHBOARD}">▣ <span>User Dashboard</span></a><a id="vtradeAdminLink" class="admin-link" href="${ADMIN_DASHBOARD}">♛ <span>Admin Dashboard</span></a><button class="logout" id="vtradeLogout" type="button">↪ <span>Sign out</span></button></div>`;
    top.appendChild(layer);
    const btn = layer.querySelector('.vtrade-account-btn'), menu = layer.querySelector('#vtradeAccountMenu');
    btn.addEventListener('click', e => { e.stopPropagation(); const open = menu.classList.toggle('show'); btn.setAttribute('aria-expanded', open ? 'true' : 'false'); });
    document.addEventListener('click', () => { menu.classList.remove('show'); btn.setAttribute('aria-expanded','false'); });
    const applyMenuLang = () => {
      const km = localStorage.getItem('vtrade_lang') === 'km';
      layer.querySelector('#vtradeUserLink span').textContent = km ? 'ផ្ទាំងអ្នកប្រើប្រាស់' : 'User Dashboard';
      layer.querySelector('#vtradeAdminLink span').textContent = km ? 'ផ្ទាំង Admin' : 'Admin Dashboard';
      layer.querySelector('#vtradeLogout span').textContent = km ? 'ចាកចេញ' : 'Sign out';
    };
    const applyUser = user => {
      const name = String(user?.name || user?.email || 'Account'), role = String(user?.role || 'user').toLowerCase(), email = String(user?.email || 'Authenticated session');
      const initials = name.trim().split(/\s+/).slice(0,2).map(x => x[0] || '').join('').toUpperCase() || 'V';
      layer.querySelector('#vtradeAvatar').textContent = initials; layer.querySelector('#vtradeAccountName').textContent = name; layer.querySelector('#vtradeAccountRole').textContent = role === 'admin' ? 'Administrator' : 'Member'; layer.querySelector('#vtradeMenuName').textContent = name; layer.querySelector('#vtradeMenuEmail').textContent = email;
      applyMenuLang();
    };
    try { applyUser(JSON.parse(sessionStorage.getItem('vtrade_user') || '{}')); } catch { applyMenuLang(); }
    window.addEventListener('storage', applyMenuLang);
    document.addEventListener('vtrade:language-changed', applyMenuLang);
    (async () => { const token = authToken(); if (!token) { applyUser({name:'Guest',role:'guest'}); return; } try { const r = await vfetch(BACKEND + '/api/auth/session', {credentials:'omit'}); const d = await r.json().catch(() => ({})); if (r.ok && d.user) { sessionStorage.setItem('vtrade_user', JSON.stringify(d.user)); applyUser(d.user); } } catch {} })();
    layer.querySelector('#vtradeLogout').addEventListener('click', async () => { const logout = layer.querySelector('#vtradeLogout'); logout.disabled = true; try { await vfetch(BACKEND + '/api/auth/logout', {method:'POST',credentials:'omit'}); } catch {} window.VTRADE_CONNECTION.clearSession(); location.href = 'index.html?logged_out=1'; });
  }

  function installResponsiveLayer() {
    if (document.getElementById('vtradeResponsiveCss')) return;
    const style = document.createElement('style'); style.id = 'vtradeResponsiveCss'; style.textContent = `
:root{--safe-top:env(safe-area-inset-top,0px);--safe-right:env(safe-area-inset-right,0px);--safe-bottom:env(safe-area-inset-bottom,0px);--safe-left:env(safe-area-inset-left,0px)}html{width:100%;min-width:0;overflow-x:hidden;-webkit-text-size-adjust:100%;text-size-adjust:100%}body{width:100%;min-width:0;min-height:100dvh;overflow-x:hidden;padding-left:var(--safe-left);padding-right:var(--safe-right);padding-bottom:var(--safe-bottom);-webkit-tap-highlight-color:transparent}.app,.main{width:100%;min-width:0;max-width:100%}.main{overflow:clip}.wrap{width:100%;max-width:1750px;min-width:0}.card,.section,.grid,.toolbar,.section-title,.signal,.align,.news-state,.news-item,.level,.kv{min-width:0;max-width:100%}.card,.notice,.setup,.gate,.news-item{overflow-wrap:anywhere}button,.btn,.tfs button,.lang-btn{touch-action:manipulation;-webkit-user-select:none;user-select:none}input,button{font-size:max(14px,1em)}
@media(max-width:1250px) and (min-width:901px){.app{grid-template-columns:220px minmax(0,1fr)}.wrap{padding-left:16px;padding-right:16px}.top{padding-left:16px;padding-right:16px}.cards{grid-template-columns:repeat(3,minmax(0,1fr))}.radar{grid-template-columns:repeat(3,minmax(0,1fr))}.gategrid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:900px){
.app{display:block;min-height:100dvh}.side{height:100dvh;max-height:100dvh;padding-top:max(18px,var(--safe-top));padding-bottom:max(18px,var(--safe-bottom));overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.top{display:grid!important;width:100%;min-height:0;padding:calc(9px + var(--safe-top)) 8px 10px;grid-template-columns:44px minmax(0,1fr) auto auto auto;grid-template-areas:"menu pair price live backend" "menu tfs tfs tfs tfs" "menu lang lang lang lang" "menu account account account account";column-gap:5px;row-gap:5px;align-items:center;overflow:visible}
.mobile{grid-area:menu;width:44px;height:44px;min-width:44px;min-height:44px}.pair{grid-area:pair;min-width:0;max-width:100%;gap:5px}.pair>div{min-width:0}.pair b{font-size:14px}.pair .sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:9px}.star{font-size:17px}.price{grid-area:price;font-size:clamp(21px,6.5vw,28px);line-height:1;white-space:nowrap}.live{grid-area:live;white-space:nowrap;font-size:8px;min-width:0}.backend{grid-area:backend;max-width:82px;overflow:hidden;text-overflow:ellipsis;font-size:7px;padding:5px 6px}.tfs{grid-area:tfs;margin:0;width:100%;min-width:0;display:flex;gap:5px;overflow-x:auto;overflow-y:hidden;padding:1px 0 2px;scrollbar-width:none;-webkit-overflow-scrolling:touch}.tfs::-webkit-scrollbar{display:none}.tfs button{flex:1 1 0;min-width:48px;min-height:42px;padding:8px 9px}.lang-row{grid-area:lang;width:100%;display:flex;gap:5px;margin:0}.lang-btn{flex:0 0 58px;min-width:58px;min-height:40px}.wrap{padding:10px 10px 28px;width:100%}.toolbar{grid-template-columns:minmax(0,1fr) auto;display:grid;gap:8px}.api{width:100%;min-width:0;min-height:46px}.btn{min-height:46px}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.radar{grid-template-columns:repeat(2,minmax(0,1fr))}.gategrid{grid-template-columns:repeat(2,minmax(0,1fr))}.mainrow{grid-template-columns:1fr}.news-top,.news-grid{grid-template-columns:1fr}.card{padding:14px;border-radius:14px}.section{margin-top:10px}.section-title{align-items:flex-start;gap:8px;flex-wrap:wrap}.section-title h2{font-size:16px;line-height:1.3}.section-title>span{margin-left:auto;text-align:right}.huge{font-size:30px}.big{font-size:22px}.signal-state{font-size:26px}.chart{height:min(48vw,230px);min-height:180px}.news-item{grid-template-columns:auto minmax(0,1fr);gap:9px}.news-actions{grid-column:2}.news-actions a{min-height:40px;display:inline-flex;align-items:center}.news-state{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px}.news-badge{grid-column:1 / -1;width:max-content;max-width:100%}}
@media(max-width:600px){.cards,.radar,.gategrid{grid-template-columns:1fr}.toolbar{grid-template-columns:1fr}.toolbar .btn{width:100%}.kv{font-size:11px}.level{font-size:12px;gap:10px}.level b{font-size:12px;text-align:right;overflow-wrap:anywhere}.footerline,.news-foot{flex-wrap:wrap}.news-foot>*{min-width:0}.news-filter{width:100%}.news-filter button{min-height:40px}.chart{height:200px}.signal{display:block}.signal .huge{margin-top:8px}.top{grid-template-columns:40px minmax(0,1fr) auto auto!important;grid-template-areas:"menu pair price backend" "menu live live live" "menu tfs tfs tfs" "menu lang lang lang" "menu account account account"}.mobile{width:40px;height:40px}.pair b{font-size:13px}.pair .sub{font-size:8px}.price{font-size:23px}.live{font-size:9px}.backend{max-width:78px;font-size:7px}}
@media(max-width:390px){.top{padding-left:6px;padding-right:6px;column-gap:4px}.pair b{font-size:12px}.pair .sub{font-size:8px}.price{font-size:21px}.backend{max-width:72px;font-size:6.5px}.tfs button{min-width:46px;padding-left:8px;padding-right:8px}.lang-btn{flex-basis:56px;min-width:56px}.section-title h2{font-size:15px}.label{font-size:9px}.huge{font-size:27px}.big{font-size:20px}.signal-state{font-size:24px}}
@media(orientation:landscape) and (max-width:900px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.radar{grid-template-columns:repeat(3,minmax(0,1fr))}.gategrid{grid-template-columns:repeat(3,minmax(0,1fr))}.mainrow{grid-template-columns:1fr 1fr}.chart{height:240px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;transition-duration:.01ms!important}}
`;
    document.head.appendChild(style);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { installResponsiveLayer(); installAccountLayer(); }); else { installResponsiveLayer(); installAccountLayer(); }
})();