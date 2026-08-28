/* V TRADE AI — Server-authoritative RBAC + phone navigation guard V9.2 — GitHub Pages login route fix */
(() => {
  'use strict';
  if (window.__VTRADE_RBAC_GUARD__) return;
  window.__VTRADE_RBAC_GUARD__ = true;
  const BACKEND='https://v-trade-ai.onrender.com';
  const file=String(location.pathname.split('/').pop()||'').toLowerCase();
  const isAdminPage=file==='admin-dashboard.html', isTerminalPage=file==='premium-dashboard-live.html';
  if(!isAdminPage&&!isTerminalPage)return;
  const token=()=>window.VTRADE_CONNECTION?.token?.()||localStorage.getItem('vtrade_auth_token')||localStorage.getItem('vtrade_auth')||sessionStorage.getItem('vtrade_auth_token')||sessionStorage.getItem('vtrade_auth')||'';
  const isAdminRole=r=>['admin','administrator'].includes(String(r||'').trim().toLowerCase());
  const isMobile=()=>{try{return matchMedia('(max-width:900px)').matches||/iphone|ipad|ipod|android|mobile/i.test(navigator.userAgent)}catch{return/iphone|ipad|ipod|android|mobile/i.test(navigator.userAgent)}};
  const login=r=>location.replace(`login.html?required=login&reason=${encodeURIComponent(r||'login')}`);
  const goAdmin=()=>location.replace('admin-dashboard.html?v=20260820-phone-v91');
  const goTerminal=()=>location.replace('premium-dashboard-live.html?v=20260820-phone-v91');
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function verifySession(){const t=token();if(!t)return{ok:false,reason:'missing-token'};let err=null;for(let i=1;i<=4;i++){try{const r=await fetch(BACKEND+'/api/auth/session',{method:'GET',mode:'cors',credentials:'omit',cache:'no-store',headers:{Accept:'application/json','x-vtrade-auth':t}}),d=await r.json().catch(()=>({}));if(r.ok&&d.user)return{ok:true,user:d.user};err=new Error(r.status===401?'Unauthorized':`Session HTTP ${r.status}`)}catch(e){err=e}if(i<4)await sleep(250*i)}return{ok:false,reason:err?.message||'session-failed'}}
  function persistUser(u){const raw=JSON.stringify(u||{});try{localStorage.setItem('vtrade_user',raw)}catch{}try{sessionStorage.setItem('vtrade_user',raw)}catch{}}
  function installAdminPhoneBar(){
    if(!isMobile()||!isAdminPage||document.getElementById('vtradePhoneBarV91'))return;
    const km=localStorage.getItem('vtrade_lang')==='km';
    const css=document.createElement('style');css.id='vtradePhoneBarV91Style';css.textContent=`
      @media(max-width:900px){
        #vtradePhoneBarV91{position:sticky;top:0;z-index:100;display:grid;grid-template-columns:minmax(0,1fr) 72px 72px 42px;gap:6px;margin:0 0 8px;padding:6px;border:1px solid #233552;border-radius:13px;background:#07101df5;box-shadow:0 10px 30px #0009;backdrop-filter:blur(16px)}
        #vtradePhoneBarV91 a,#vtradePhoneBarV91 select,#vtradePhoneBarV91 button{height:40px;min-width:0;border:1px solid #233552;border-radius:10px;background:#0b1423;color:#e8eef8;text-decoration:none;display:flex;align-items:center;justify-content:center;font:800 10px Arial;padding:0 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;outline:none}
        #vtradePhoneBarV91 a.active{background:#5421cf;border-color:#8050ff;color:#fff}
        #vtradePhoneBarV91 select{width:100%}
        #vtradePhoneMenuV91{display:none;position:fixed;top:61px;right:9px;z-index:5000;width:220px;padding:8px;border:1px solid #233552;border-radius:14px;background:#07101dfd;box-shadow:0 18px 50px #000b}
        #vtradePhoneMenuV91.open{display:grid;gap:6px}
        #vtradePhoneMenuV91 a,#vtradePhoneMenuV91 button{min-height:42px;border:1px solid #233552;border-radius:10px;background:#0b1423;color:#fff;text-decoration:none;display:flex;align-items:center;padding:0 12px;font:800 11px Arial}
        #vtradePhoneMenuV91 .danger{background:#2b0c13;border-color:#7c2532;color:#ff9aa5}
      }
      @media(min-width:901px){#vtradePhoneBarV91,#vtradePhoneMenuV91{display:none!important}}
    `;document.head.appendChild(css);
    const bar=document.createElement('nav');bar.id='vtradePhoneBarV91';bar.innerHTML=`<a class="active" href="admin-dashboard.html?v=20260820-phone-v91">Admin Dashboard</a><select id="v91Tf" aria-label="Timeframe"><option value="M5">M5</option><option value="M15">M15</option><option value="H1">1H</option><option value="H4">4H</option><option value="D1">1D</option></select><select id="v91Lang" aria-label="Language"><option value="en">EN</option><option value="km">ខ្មែរ</option></select><button id="v91Menu" aria-label="Menu">☰</button>`;
    const shell=document.querySelector('.shell');if(shell&&shell.parentNode)shell.parentNode.insertBefore(bar,shell);else document.body.prepend(bar);
    const menu=document.createElement('div');menu.id='vtradePhoneMenuV91';menu.innerHTML=`<a href="premium-dashboard-live.html?from=admin-terminal&v=20260820-phone-v91">▣ &nbsp; Live Terminal</a><a href="premium-dashboard-live.html?from=admin-terminal&v=20260820-phone-v91#signals">◈ &nbsp; Signals</a><a href="premium-dashboard-live.html?from=admin-terminal&v=20260820-phone-v91#ai">✦ &nbsp; AI</a><a href="profile.html">◉ &nbsp; ${km?'គណនី':'Profile'}</a><button id="v91Refresh">↻ &nbsp; ${km?'ផ្ទុកឡើងវិញ':'Refresh'}</button><button class="danger" id="v91Logout">↪ &nbsp; ${km?'ចាកចេញ':'Sign out'}</button>`;document.body.appendChild(menu);
    bar.querySelector('#v91Menu').onclick=()=>menu.classList.toggle('open');
    document.addEventListener('click',e=>{if(!bar.contains(e.target)&&!menu.contains(e.target))menu.classList.remove('open')});
    menu.querySelector('#v91Refresh').onclick=()=>location.reload();
    menu.querySelector('#v91Logout').onclick=async()=>{try{await fetch(BACKEND+'/api/auth/logout',{method:'POST',mode:'cors',credentials:'omit',headers:{Accept:'application/json','x-vtrade-auth':token()}})}catch{}try{localStorage.removeItem('vtrade_auth_token');localStorage.removeItem('vtrade_auth');localStorage.removeItem('vtrade_user');sessionStorage.clear()}catch{}location.replace('login.html?logged_out=1')};
    const lang=bar.querySelector('#v91Lang');lang.value=km?'km':'en';lang.onchange=()=>{localStorage.setItem('vtrade_lang',lang.value);location.reload()};
    bar.querySelector('#v91Tf').onchange=e=>location.href=`premium-dashboard-live.html?from=admin-terminal&tf=${encodeURIComponent(e.target.value)}&v=20260820-phone-v91`;
  }
  async function verify(){const result=await verifySession();if(!result.ok)return login(result.reason);const u=result.user,role=String(u?.role||'user').trim().toLowerCase();persistUser(u);document.documentElement.lang=localStorage.getItem('vtrade_lang')==='km'?'km':'en';document.documentElement.dataset.role=role;
    if(isMobile()){if(isTerminalPage&&isAdminRole(role)){const q=new URLSearchParams(location.search);const fromAdmin=q.get('from')==='admin-terminal'||q.get('from')==='admin'||/admin-dashboard\.html/i.test(document.referrer||'');if(!fromAdmin)return goAdmin()}if(isAdminPage&&!isAdminRole(role))return goTerminal();if(isAdminPage)installAdminPhoneBar()}
    window.dispatchEvent(new CustomEvent('vtrade:rbac-ready',{detail:{user:u,role,mobile:isMobile()}}));
  }
  function loadDashboardUiFix(){if(!isAdminPage&&!isTerminalPage)return;if(document.getElementById('vtradeDashboardUiFixScript'))return;const s=document.createElement('script');s.id='vtradeDashboardUiFixScript';s.src='dashboard-ui-fix.js?v=20260821-ui';s.async=false;(document.head||document.documentElement).appendChild(s)}
  loadDashboardUiFix();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',verify,{once:true});else verify();
})();
