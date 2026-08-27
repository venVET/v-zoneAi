
/* V TRADE AI — Mobile App shell / navigation */
(() => {
  'use strict';
  if (window.__VTRADE_RESPONSIVE_V1__) return;
  window.__VTRADE_RESPONSIVE_V1__ = true;
  const isMobile=()=>window.matchMedia('(max-width:900px)').matches;
  const path=location.pathname.split('/').pop().toLowerCase();
  function injectStyle(){
    if(document.getElementById('vtradeResponsiveRuntimeStyle')) return;
    const s=document.createElement('style');s.id='vtradeResponsiveRuntimeStyle';
    s.textContent=`
      @media(max-width:900px){
        body.vtrade-mobile{padding-bottom:calc(66px + env(safe-area-inset-bottom))}
        #vtradeMobileBar{position:fixed;left:0;right:0;bottom:0;z-index:1000;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:7px max(8px,env(safe-area-inset-left)) max(7px,env(safe-area-inset-bottom));background:#050912f5;border-top:1px solid #20314a;backdrop-filter:blur(18px)}
        #vtradeMobileBar a{min-width:0;height:48px;border:1px solid #20314a;border-radius:12px;background:#09111e;color:#aebbd0;text-decoration:none;display:grid;place-items:center;font:800 10px/1 Segoe UI,Arial}
        #vtradeMobileBar a.active{background:#5421cf;border-color:#8050ff;color:#fff}
        #vtradeMobileBar .mi{font-size:17px;line-height:18px}
        #vtradeAdminMobileBar{position:fixed;top:0;left:0;right:0;z-index:1001;display:flex;align-items:center;gap:8px;padding:max(8px,env(safe-area-inset-top)) 10px 8px;background:#050912f5;border-bottom:1px solid #20314a;backdrop-filter:blur(18px)}
        #vtradeAdminMobileBar button,#vtradeAdminMobileBar a{height:42px;min-width:42px;border:1px solid #20314a;border-radius:11px;background:#09111e;color:#fff;text-decoration:none;display:grid;place-items:center;font-weight:900}
        #vtradeAdminMobileBar .title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        #vtradeAdminMobileBar .title b{display:block;font-size:13px}
        #vtradeAdminMobileBar .title small{color:#8d9bb0}
        body.vtrade-admin-mobile{padding-top:60px}
        body.vtrade-admin-mobile .side{position:fixed!important;left:0!important;top:0!important;bottom:0!important;width:min(300px,86vw)!important;height:100dvh!important;z-index:1002!important;transform:translateX(-110%)!important;transition:transform .2s ease!important;overflow:auto!important;border-right:1px solid #20314a!important;border-bottom:0!important}
        body.vtrade-admin-mobile .side.vtrade-open{transform:translateX(0)!important}
        #vtradeAdminScrim{position:fixed;inset:0;z-index:1001;background:#0009;opacity:0;pointer-events:none;transition:opacity .2s}
        #vtradeAdminScrim.show{opacity:1;pointer-events:auto}
        body.vtrade-admin-mobile .nav{grid-template-columns:1fr!important}
      }
      @media(min-width:901px){#vtradeMobileBar,#vtradeAdminMobileBar,#vtradeAdminScrim{display:none!important}}
    `;document.head.appendChild(s);
  }
  function addMobileNav(){
    if(!isMobile()||document.getElementById('vtradeMobileBar'))return;
    const bar=document.createElement('nav');bar.id='vtradeMobileBar';bar.setAttribute('aria-label','Mobile navigation');
    const items=[['dashboard.html','⌂','Home'],['premium-dashboard-live.html#signals','◈','Signals'],['premium-dashboard-live.html#ai','✦','AI'],['profile.html','♙','Profile']];
    bar.innerHTML=items.map(([href,icon,label])=>{
      const active=(path==='dashboard.html'&&label==='Home')||(path==='premium-dashboard-live.html'&&label!=='Home')||(path==='profile.html'&&label==='Profile');
      return `<a class="${active?'active':''}" href="${href}"><span class="mi">${icon}</span>${label}</a>`;
    }).join('');document.body.appendChild(bar);document.body.classList.add('vtrade-mobile');
  }
  function addAdminShell(){
    if(path!=='admin-dashboard.html'||!isMobile()||document.getElementById('vtradeAdminMobileBar'))return;
    const scrim=document.createElement('div');scrim.id='vtradeAdminScrim';document.body.appendChild(scrim);
    const bar=document.createElement('div');bar.id='vtradeAdminMobileBar';
    bar.innerHTML=`<button id="vtradeAdminMenu" aria-label="Open menu">☰</button><div class="title"><b>V TRADE AI</b><small>Admin Dashboard</small></div><a href="profile.html" aria-label="Profile">♙</a><button id="vtradeAdminLogout" aria-label="Logout">↪</button>`;
    document.body.appendChild(bar);document.body.classList.add('vtrade-admin-mobile');
    const side=document.querySelector('.side');
    const openMenu=()=>{side?.classList.add('vtrade-open');scrim.classList.add('show')};
    const closeMenu=()=>{side?.classList.remove('vtrade-open');scrim.classList.remove('show')};
    document.getElementById('vtradeAdminMenu').onclick=openMenu;scrim.onclick=closeMenu;
    side?.querySelectorAll('a,button').forEach(el=>el.addEventListener('click',closeMenu));
    document.getElementById('vtradeAdminLogout').onclick=()=>document.getElementById('sideLogout')?.click();
  }
  function fixLegacyLinks(){
    document.querySelectorAll('a[href*="premium-dashboard-live.html"]').forEach(a=>a.setAttribute('href',a.getAttribute('href').replaceAll('premium-dashboard-live.html','premium-dashboard-live.html')));
  }
  function init(){injectStyle();fixLegacyLinks();if(path==='admin-dashboard.html')addAdminShell();else if(['premium-dashboard-live.html','dashboard.html','profile.html','pricing.html'].includes(path))addMobileNav();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
