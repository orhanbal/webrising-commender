import {useEffect,useRef,useState} from "react";
import {Activity,ArrowLeft,Building2,ChevronDown,LayoutDashboard,LogOut,Menu,Monitor,Settings2,ShieldCheck,Users,X} from "lucide-react";
import {api} from "../api";
import {LanguageSwitcher,t as translate,useLocale} from "../i18n";
import {Brand,ThemeToggle} from "../App";
import type {Nav,Theme} from "../App";

type Overview={users:number;organizations:number;devices:number;activeDevices:number};
type Admin={email:string;userId:string;platformRole:string};
export function ConsolePage({nav,theme,toggle,logout}:{nav:Nav;theme:Theme;toggle:()=>void;logout:()=>void}){
 useLocale();
 const [admin,setAdmin]=useState<Admin|null>(null);
 const [overview,setOverview]=useState<Overview|null>(null);
 const [error,setError]=useState("");
 const [loading,setLoading]=useState(true);
 const [menu,setMenu]=useState(false);
 const [profileOpen,setProfileOpen]=useState(false);
 const profileRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(!profileOpen)return;const outside=(event:PointerEvent)=>{if(profileRef.current&&!profileRef.current.contains(event.target as Node))setProfileOpen(false)};const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")setProfileOpen(false)};document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape)}},[profileOpen]);
 useEffect(()=>{
   let active=true;
   Promise.all([api<Admin>("/api/console/me"),api<Overview>("/api/console/overview")])
    .then(([identity,counts])=>{if(active){setAdmin(identity);setOverview(counts);}})
    .catch(e=>{if(active)setError(e instanceof Error?e.message:"Access denied");})
    .finally(()=>{if(active)setLoading(false);});
   return()=>{active=false};
 },[]);
 if(loading)return <div className="min-h-screen grid place-items-center text-lg">{translate("Yükleniyor…")}</div>;
 if(error||!admin)return <div className="container-w py-24 max-w-xl">
   <div className="rounded-2xl bg-[var(--surface)] border border-[var(--stroke)] p-8">
    <ShieldCheck size={32} className="text-[var(--accent)] mb-4"/>
    <h1 className="text-2xl font-bold">Platform administration</h1>
    <p className="muted mt-3">{translate("Bu alana yalnızca yetkili platform yöneticileri erişebilir.")}</p>
    <p className="text-sm mt-4">{error}</p>
    <button className="mt-6 px-5 py-3 rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] font-semibold" onClick={()=>nav("/login")}>Sign in</button>
   </div></div>;
 const items=[{label:"Overview",icon:LayoutDashboard},{label:"Users",icon:Users},{label:"Organizations",icon:Building2},{label:"Devices",icon:Monitor},{label:"Operations",icon:Activity}];
 return <div className="dashboard-layout">
  {menu&&<button className="fixed inset-0 bg-black/60 z-[92] md:hidden" aria-label="Close navigation" onClick={()=>setMenu(false)}/>}
  <aside className={"dashboard-sidebar "+(menu?"open":"")} aria-label="Platform administration">
   <div className="px-3 pt-2"><Brand onClick={()=>nav("/")}/></div>
   <div className="px-4 py-5"><div className="flex items-center gap-2 text-[var(--accent)] text-sm font-bold"><ShieldCheck size={18}/> SUPER ADMIN</div></div>
   <nav className="dash-nav">{items.map((item,index)=><div key={item.label} className={"dash-link "+(index===0?"active":" opacity-60")} aria-current={index===0?"page":undefined} title={index===0?"Overview":"Coming in the next phase"}><item.icon size={19}/><span>{item.label}</span>{index!==0&&<span className="ml-auto text-[10px]">Soon</span>}</div>)}</nav>
   <div className="dash-sidebar-bottom"><p className="text-sm muted">Platform administration is separate from workspace ownership.</p><button className="mt-5 text-sm flex items-center gap-2" onClick={()=>nav("/dashboard")}><ArrowLeft size={17}/> User dashboard</button></div>
  </aside>
  <div className="dash-main">
    <div className="dash-topbar">
      <div className="flex items-center gap-3"><button className="mobile-dash-open size-9 place-items-center rounded-lg border border-[var(--stroke)]" onClick={()=>setMenu(true)} aria-label="Open navigation">{menu?<X/>:<Menu/>}</button><span className="text-sm muted">Administration / <strong className="text-[var(--text)]">Overview</strong></span></div>
      <div className="dash-toolbar"><ThemeToggle theme={theme} onToggle={toggle}/><LanguageSwitcher compact/><div ref={profileRef} className="relative">
<button type="button" onClick={()=>setProfileOpen(v=>!v)} aria-haspopup="menu" aria-expanded={profileOpen} aria-label={translate("Hesap menüsü")} className="flex items-center gap-2 rounded-xl border border-[var(--stroke)] p-1 pr-3 hover:bg-[var(--hover)]"><span className="size-9 rounded-lg grid place-items-center bg-[var(--subtle-surface)] text-[var(--accent)] font-bold">{admin.email.slice(0,2).toUpperCase()}</span><span className="hidden sm:block text-sm max-w-[135px] truncate">{admin.email.split("@")[0]}</span><ChevronDown size={15} className={profileOpen?"rotate-180":""}/></button>
{profileOpen&&<div role="menu" aria-label={translate("Hesap menüsü")} className="absolute right-0 top-[calc(100%+9px)] z-[120] w-[265px] rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-2 shadow-2xl">
<div className="px-3 py-3 border-b border-[var(--stroke)] mb-1 text-sm font-semibold truncate">{admin.email}</div>
<button type="button" role="menuitem" className="w-full text-left px-3 py-3 flex gap-3 rounded-lg hover:bg-[var(--hover)] text-sm" onClick={()=>{setProfileOpen(false);nav("/account")}}><Settings2 size={17}/>{translate("Hesap Ayarları")}</button>
<button type="button" role="menuitem" className="w-full text-left px-3 py-3 flex gap-3 rounded-lg hover:bg-[var(--hover)] text-sm" onClick={()=>{setProfileOpen(false);nav("/account")}}><Users size={17}/>{translate("Çalışma Alanları")}</button>
<div className="border-t border-[var(--stroke)] my-1"/>
<button type="button" role="menuitem" className="w-full text-left px-3 py-3 flex gap-3 rounded-lg hover:bg-[var(--hover)] text-sm" onClick={()=>{setProfileOpen(false);logout()}}><LogOut size={17}/>{translate("Çıkış Yap")}</button>
</div>}</div></div>
    </div>
    <main className="dash-content">
      <p className="text-sm font-semibold text-[var(--accent)] mb-2">WECOMMANDER CONTROL CENTER</p>
      <h1 className="dash-title">Platform Overview</h1>
      <p className="muted mt-3 mb-8">Platform-wide counts from the production database. Signed in as {admin.email}.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
       {([{label:"Total users",value:overview?.users,icon:Users},{label:"Organizations",value:overview?.organizations,icon:Building2},{label:"Registered devices",value:overview?.devices,icon:Monitor},{label:"Recently active devices",value:overview?.activeDevices,icon:Activity}]).map(item=><section key={item.label} className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
        <div className="flex justify-between items-center"><span className="muted text-sm">{item.label}</span><item.icon size={20} className="text-[var(--accent)]"/></div>
        <div className="text-4xl font-bold mt-5">{item.value?.toLocaleString()??"—"}</div>
       </section>)}
      </div>
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6 mt-7">
       <h2 className="text-xl font-bold">Administration modules</h2>
       <p className="muted mt-2">User management, billing, landing CMS, brand assets and system settings will be enabled only after their secured APIs and acceptance tests are complete.</p>
      </div>
    </main>
  </div>
 </div>;
}
