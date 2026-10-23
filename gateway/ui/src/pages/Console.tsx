import {useEffect,useRef,useState} from "react";
import {Activity,ArrowLeft,Building2,ChevronDown,LayoutDashboard,LogOut,Menu,Monitor,Settings2,ShieldCheck,FileText,CreditCard,Users,X} from "lucide-react";
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
 const [section,setSection]=useState("Overview");
 const [userSearch,setUserSearch]=useState("");
 const [userPage,setUserPage]=useState(0);
 const [targetUser,setTargetUser]=useState<{id:string;email:string;disabled:boolean}|null>(null);
 const [confirmPassword,setConfirmPassword]=useState("");
 const [userActionBusy,setUserActionBusy]=useState(false);
 const [userActionError,setUserActionError]=useState("");
 const refreshUsers=async()=>{const result=await api<{items:Array<Record<string,unknown>>}>("/api/console/users?limit=25&offset="+(userPage*25)+"&q="+encodeURIComponent(userSearch));setRecords(result.items)};
 const applyUserAction=async()=>{if(!targetUser)return;setUserActionBusy(true);setUserActionError("");try{await api("/api/console/users/set-disabled",{method:"POST",body:JSON.stringify({userId:targetUser.id,disabled:!targetUser.disabled,currentPassword:confirmPassword})});await refreshUsers();setTargetUser(null);setConfirmPassword("")}catch(e){setUserActionError(String(e))}finally{setUserActionBusy(false)}};

 const [records,setRecords]=useState<Array<Record<string,unknown>>>([]);
 const [recordsError,setRecordsError]=useState("");
 const [recordsBusy,setRecordsBusy]=useState(false);
 const [billing,setBilling]=useState<{plans:Array<Record<string,unknown>>;subscriptions:Array<Record<string,unknown>>}|null>(null);
 const [system,setSystem]=useState<Record<string,unknown>|null>(null);
 useEffect(()=>{if(!admin)return;if(section==="Billing")void api<{plans:Array<Record<string,unknown>>;subscriptions:Array<Record<string,unknown>>}>("/api/console/billing").then(setBilling).catch(e=>setRecordsError(String(e)));if(section==="System")void api<Record<string,unknown>>("/api/console/system").then(setSystem).catch(e=>setRecordsError(String(e)))},[admin,section]);
 const [cmsLocale,setCmsLocale]=useState<"en"|"tr">("en");
 const [cmsTitle,setCmsTitle]=useState("");
 const [cmsSubtitle,setCmsSubtitle]=useState("");
 const [cmsItems,setCmsItems]=useState<Array<{id:number;hero_title:string;hero_subtitle:string;state:string}>>([]);
 const [cmsMessage,setCmsMessage]=useState("");
 const [cmsBusy,setCmsBusy]=useState(false);
 const reloadCms=async()=>{const data=await api<{items:typeof cmsItems}>("/api/console/site-content?locale="+cmsLocale);setCmsItems(data.items)};
 useEffect(()=>{if(section!=="Landing CMS"||!admin)return;void reloadCms().catch(e=>setCmsMessage(String(e)))},[section,cmsLocale,admin]);
 const saveCms=async()=>{setCmsBusy(true);setCmsMessage("");try{await api("/api/console/site-content",{method:"POST",body:JSON.stringify({locale:cmsLocale,heroTitle:cmsTitle,heroSubtitle:cmsSubtitle})});await reloadCms();setCmsMessage("Draft saved.")}catch(e){setCmsMessage(String(e))}finally{setCmsBusy(false)}};
 const publishCms=async(id:number)=>{setCmsBusy(true);setCmsMessage("");try{await api("/api/console/site-content/publish",{method:"POST",body:JSON.stringify({id})});await reloadCms();setCmsMessage("Published. You can now refresh the landing page.")}catch(e){setCmsMessage(String(e))}finally{setCmsBusy(false)}};
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
 useEffect(()=>{const names:Record<string,string>={Users:"users",Organizations:"organizations",Devices:"devices",Operations:"audit"};if(!admin||!names[section])return;let active=true;setRecordsBusy(true);setRecordsError("");api<{items:Array<Record<string,unknown>>}>("/api/console/"+names[section]+(section==="Users"?"?limit=25&offset="+(userPage*25)+"&q="+encodeURIComponent(userSearch):"")).then(data=>{if(active)setRecords(data.items)}).catch(e=>{if(active)setRecordsError(String(e))}).finally(()=>{if(active)setRecordsBusy(false)});return()=>{active=false}},[section,admin,userSearch,userPage]);
 if(loading)return <div className="min-h-screen grid place-items-center text-lg">{translate("Yükleniyor…")}</div>;
 if(error||!admin)return <div className="container-w py-24 max-w-xl">
   <div className="rounded-2xl bg-[var(--surface)] border border-[var(--stroke)] p-8">
    <ShieldCheck size={32} className="text-[var(--accent)] mb-4"/>
    <h1 className="text-2xl font-bold">Platform administration</h1>
    <p className="muted mt-3">{translate("Bu alana yalnızca yetkili platform yöneticileri erişebilir.")}</p>
    <p className="text-sm mt-4">{error}</p>
    <button className="mt-6 px-5 py-3 rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] font-semibold" onClick={()=>nav("/login")}>Sign in</button>
   </div></div>;
 const items=[{label:"Overview",icon:LayoutDashboard},{label:"Users",icon:Users},{label:"Organizations",icon:Building2},{label:"Devices",icon:Monitor},{label:"Operations",icon:Activity},{label:"Landing CMS",icon:FileText},{label:"Billing",icon:CreditCard},{label:"System",icon:Settings2}];
 return <div className="dashboard-layout">
  {menu&&<button className="fixed inset-0 bg-black/60 z-[92] md:hidden" aria-label="Close navigation" onClick={()=>setMenu(false)}/>}
  <aside className={"dashboard-sidebar "+(menu?"open":"")} aria-label="Platform administration">
   <div className="px-3 pt-2"><Brand onClick={()=>nav("/")}/></div>
   <div className="px-4 py-5"><div className="flex items-center gap-2 text-[var(--accent)] text-sm font-bold"><ShieldCheck size={18}/> SUPER ADMIN</div></div>
   <nav className="dash-nav">{items.map(item=><button type="button" key={item.label} onClick={()=>{setSection(item.label);setMenu(false)}} className={"dash-link text-left "+(section===item.label?"active":"")} aria-current={section===item.label?"page":undefined} title={item.label}><item.icon size={19}/><span>{item.label}</span></button>)}</nav>
   <div className="dash-sidebar-bottom"><p className="text-sm muted">Platform administration is separate from workspace ownership.</p><button className="mt-5 text-sm flex items-center gap-2" onClick={()=>nav("/dashboard")}><ArrowLeft size={17}/> User dashboard</button></div>
  </aside>
  <div className="dash-main">
   {targetUser&&<div className="fixed inset-0 z-[220] bg-black/65 flex justify-center items-center p-4" role="dialog" aria-modal="true" aria-label="Confirm account change"><div className="w-full max-w-lg rounded-2xl bg-[var(--surface)] border border-[var(--stroke)] p-7"><h2 className="text-xl font-bold">{targetUser.disabled?"Enable user":"Disable user"}</h2><p className="muted mt-3">{targetUser.email}. This operation is audited and requires your current password.</p><label className="block mt-5 mb-2 text-sm font-semibold">Current password</label><input type="password" autoComplete="current-password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} className="w-full rounded-xl bg-[var(--input)] border border-[var(--stroke)] p-3"/><p role="alert" className="text-[var(--danger)] mt-3 text-sm">{userActionError}</p><div className="flex gap-3 justify-end mt-6"><button onClick={()=>{setTargetUser(null);setConfirmPassword("")}} className="rounded-xl border border-[var(--stroke)] px-5 py-3">Cancel</button><button disabled={confirmPassword.length<12||userActionBusy} onClick={()=>void applyUserAction()} className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-5 py-3 disabled:opacity-50">Confirm</button></div></div></div>}

    <div className="dash-topbar">
      <div className="flex items-center gap-3"><button className="mobile-dash-open size-9 place-items-center rounded-lg border border-[var(--stroke)]" onClick={()=>setMenu(true)} aria-label="Open navigation">{menu?<X/>:<Menu/>}</button><span className="text-sm muted">Administration / <strong className="text-[var(--text)]">{section}</strong></span></div>
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
      <h1 className="dash-title">{section==="Overview"?"Platform Overview":section}</h1>
      <p className="muted mt-3 mb-8">Platform-wide counts from the production database. Signed in as {admin.email}.</p>
      {section==="Billing"?<div className="grid gap-6">{(["plans","subscriptions"] as const).map(kind=><section key={kind} className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6"><h2 className="text-xl font-bold mb-4">{kind==="plans"?"Plans":"Subscriptions"}</h2>{!billing?<p className="muted">Loading…</p>:billing[kind].length===0?<p className="muted">No records.</p>:billing[kind].map((item,index)=><div key={index} className="border-t border-[var(--stroke)] py-3 text-sm flex gap-4 flex-wrap">{Object.entries(item).map(([key,value])=><span key={key}><strong>{key}:</strong> {String(value??"—")}</span>)}</div>)}</section>)}<p className="muted text-sm">Billing is read-only here. Paddle remains the source of truth for paid subscriptions.</p></div>:section==="System"?<div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6"><h2 className="text-xl font-bold mb-4">System status</h2>{!system?<p className="muted">Loading…</p>:Object.entries(system).map(([key,value])=><div className="py-3 border-b border-[var(--stroke)] text-sm" key={key}><strong>{key}:</strong> {typeof value==="object"?JSON.stringify(value):String(value)}</div>)}<p className="muted mt-5 text-sm">Credentials and secrets are not exposed.</p></div>:section==="Landing CMS"?<div className="rounded-2xl bg-[var(--surface)] border border-[var(--stroke)] p-6 max-w-4xl"><h2 className="font-bold text-xl mb-4">Landing hero editor</h2><p className="muted mb-4 text-sm">Edit localized hero copy, save revisions, then publish. Published revisions can be restored by publishing them again.</p><label className="block text-sm font-semibold mb-2">Language</label><select className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3 mb-4" value={cmsLocale} onChange={e=>setCmsLocale(e.target.value as "en"|"tr")}><option value="en">English</option><option value="tr">Türkçe</option></select><label className="block text-sm font-semibold mb-2">Hero title</label><input maxLength={160} className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3 mb-4" value={cmsTitle} onChange={e=>setCmsTitle(e.target.value)}/><label className="block text-sm font-semibold mb-2">Hero description</label><textarea maxLength={500} className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3 mb-4" rows={4} value={cmsSubtitle} onChange={e=>setCmsSubtitle(e.target.value)}/><button disabled={cmsBusy||!cmsTitle.trim()||!cmsSubtitle.trim()} onClick={()=>void saveCms()} className="px-5 py-3 bg-[var(--accent)] text-[var(--accent-ink)] rounded-xl font-bold disabled:opacity-50">Save draft</button><p role="status" className="text-sm mt-3">{cmsMessage}</p><h3 className="text-lg font-bold mt-8 mb-3">Revisions</h3>{cmsItems.map(item=><div key={item.id} className="flex flex-wrap items-center justify-between border-t border-[var(--stroke)] py-4 gap-4"><div className="min-w-0"><strong>{item.hero_title}</strong><div className="muted text-sm">{item.state} · revision {item.id}</div></div><button disabled={cmsBusy||item.state==="published"} className="rounded-xl border border-[var(--stroke)] px-4 py-2 disabled:opacity-50" onClick={()=>void publishCms(item.id)}>{item.state==="published"?"Published":"Publish"}</button></div>)}</div>:section==="Overview"?<><div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
       {([{label:"Total users",value:overview?.users,icon:Users},{label:"Organizations",value:overview?.organizations,icon:Building2},{label:"Registered devices",value:overview?.devices,icon:Monitor},{label:"Recently active devices",value:overview?.activeDevices,icon:Activity}]).map(item=><section key={item.label} className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
        <div className="flex justify-between items-center"><span className="muted text-sm">{item.label}</span><item.icon size={20} className="text-[var(--accent)]"/></div>
        <div className="text-4xl font-bold mt-5">{item.value?.toLocaleString()??"—"}</div>
       </section>)}
      </div>
      <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6 mt-7">
       <h2 className="text-xl font-bold">Administration modules</h2>
       <p className="muted mt-2">User management, billing, landing CMS, brand assets and system settings will be enabled only after their secured APIs and acceptance tests are complete.</p>
      </div></>:<div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-5 overflow-x-auto">
        {section==="Users"&&<div className="flex flex-wrap gap-3 mb-5"><input className="flex-1 min-w-[220px] rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3 text-sm" placeholder="Search user email" aria-label="Search user email" value={userSearch} onChange={e=>{setUserPage(0);setUserSearch(e.target.value)}}/><button type="button" disabled={userPage===0} onClick={()=>setUserPage(x=>Math.max(0,x-1))} className="rounded-xl border border-[var(--stroke)] px-4 disabled:opacity-40">Previous</button><span className="self-center text-sm muted">Page {userPage+1}</span><button type="button" disabled={records.length<25} onClick={()=>setUserPage(x=>x+1)} className="rounded-xl border border-[var(--stroke)] px-4 disabled:opacity-40">Next</button></div>}
        {recordsBusy?<p className="muted py-8">Loading records…</p>:recordsError?<p role="alert" className="text-[var(--danger)]">{recordsError}</p>:records.length===0?<p className="muted py-8">No records.</p>:<table className="w-full text-sm text-left"><thead><tr>{Object.keys(records[0]||{}).map(k=><th key={k} className="px-3 py-3 border-b border-[var(--stroke)] whitespace-nowrap">{k.replaceAll("_"," ")}</th>)}</tr></thead><tbody>{records.map((row,i)=><tr key={String(row.id||i)}>{Object.values(row).map((value,j)=><td key={j} className="px-3 py-3 border-b border-[var(--stroke)] whitespace-nowrap">{value===null?"—":typeof value==="boolean"?(value?"Yes":"No"):String(value)}</td>)}{section==="Users"&&<td className="px-3 py-3 border-b border-[var(--stroke)]"><button onClick={()=>{setUserActionError("");setTargetUser({id:String(row.id),email:String(row.email),disabled:Boolean(row.disabled)})}} className="rounded-lg border border-[var(--stroke)] px-3 py-2 text-sm">{row.disabled?"Enable":"Disable"}</button></td>}</tr>)}</tbody></table>}
        <p className="muted text-xs mt-5">Read-only records. Administrative changes require audited controls.</p>
       </div>}
    </main>
  </div>
 </div>;
}
