import {useEffect,useRef,useState} from "react";
import {Activity,ArrowLeft,Building2,ChevronDown,LayoutDashboard,LogOut,Menu,Monitor,Settings2,ShieldCheck,FileText,CreditCard,Image as ImageIcon,Users,X} from "lucide-react";
import {api} from "../api";
import {landingCopySections} from "../landing-copy-sections";
import {LanguageSwitcher,t as translate,useLocale} from "../i18n";
import {Brand,ThemeToggle} from "../App";
import type {Nav,Theme} from "../App";

type Overview={users:number;organizations:number;devices:number;activeDevices:number};
type Admin={email:string;userId:string;platformRole:string};
const routes:Record<string,string>={Overview:"/console",Users:"/console/users",Organizations:"/console/organizations",Devices:"/console/devices",Operations:"/console/operations","Landing CMS":"/console/landing",Billing:"/console/billing",System:"/console/system",Brand:"/console/brand"};
export function ConsolePage({nav,path,theme,toggle,logout}:{nav:Nav;path:string;theme:Theme;toggle:()=>void;logout:()=>void}){
 useLocale();
 const [admin,setAdmin]=useState<Admin|null>(null);
 const [overview,setOverview]=useState<Overview|null>(null);
 const [error,setError]=useState("");
 const [loading,setLoading]=useState(true);
 const [menu,setMenu]=useState(false);
 const [section,setSection]=useState(()=>Object.keys(routes).find(label=>routes[label]===path)||"Overview");
 useEffect(()=>setSection(Object.keys(routes).find(label=>routes[label]===path)||"Overview"),[path]);
 const [userSearch,setUserSearch]=useState("");
 const [userPage,setUserPage]=useState(0);
 const [targetUser,setTargetUser]=useState<{id:string;email:string;disabled:boolean}|null>(null);
 const [confirmPassword,setConfirmPassword]=useState("");
 const [userActionBusy,setUserActionBusy]=useState(false);
 const [userActionError,setUserActionError]=useState("");
 const [sessionUser,setSessionUser]=useState<{id:string;email:string}|null>(null);
 const [sessionRows,setSessionRows]=useState<Array<{id:string;organization_name:string;created_at:string;expires_at:string;revoked_at:string|null}>>([]);
 const [sessionPassword,setSessionPassword]=useState("");
 const [sessionError,setSessionError]=useState("");
 const [sessionBusy,setSessionBusy]=useState(false);
 const openSessions=async(user:{id:string;email:string})=>{
   setSessionUser(user);setSessionRows([]);setSessionError("");setSessionBusy(true);
   try{const data=await api<{items:typeof sessionRows}>("/api/console/users/sessions?userId="+encodeURIComponent(user.id));setSessionRows(data.items)}
   catch(e){setSessionError(String(e))}finally{setSessionBusy(false)}
 };
 const revokeUserSession=async(sessionId:string)=>{
   if(!sessionUser)return;setSessionBusy(true);setSessionError("");
   try{
     await api("/api/console/users/sessions/revoke",{method:"POST",body:JSON.stringify({sessionId,currentPassword:sessionPassword})});
     const data=await api<{items:typeof sessionRows}>("/api/console/users/sessions?userId="+encodeURIComponent(sessionUser.id));
     setSessionRows(data.items);setSessionPassword("");
   }catch(e){setSessionError(String(e))}finally{setSessionBusy(false)}
 };

 const [memberWorkspace,setMemberWorkspace]=useState<{id:string;name:string}|null>(null);
 const [memberRows,setMemberRows]=useState<Array<{user_id:string;email:string;role:string;disabled:boolean}>>([]);
 const [memberError,setMemberError]=useState("");
 const [memberBusy,setMemberBusy]=useState(false);
 const [memberTarget,setMemberTarget]=useState<{user_id:string;email:string;role:string}|null>(null);
 const [memberRole,setMemberRole]=useState<"viewer"|"operator"|"admin">("viewer");
 const [memberPassword,setMemberPassword]=useState("");
 const [roleBusy,setRoleBusy]=useState(false);
 const refreshMembers=async(organizationId:string)=>{
   const result=await api<{items:typeof memberRows}>("/api/console/organizations/members?organizationId="+encodeURIComponent(organizationId));
   setMemberRows(result.items);
 };
 const openMembers=async(workspace:{id:string;name:string})=>{
   setMemberWorkspace(workspace);setMemberBusy(true);setMemberError("");setMemberRows([]);
   try{await refreshMembers(workspace.id)}catch(e){setMemberError(String(e))}finally{setMemberBusy(false)}
 };
 const applyMembershipRole=async()=>{
   if(!memberTarget||!memberWorkspace)return;
   setRoleBusy(true);setMemberError("");
   try{
     await api("/api/console/organizations/members/role",{method:"POST",body:JSON.stringify({
       organizationId:memberWorkspace.id,userId:memberTarget.user_id,role:memberRole,currentPassword:memberPassword,
     })});
     await refreshMembers(memberWorkspace.id);
     setMemberTarget(null);setMemberPassword("");
   }catch(e){setMemberError(String(e))}finally{setRoleBusy(false)}
 };
 const [orgEdit,setOrgEdit]=useState<{id:string;name:string;maxDevices:string;maxMembers:string;maxApiTokens:string}|null>(null);
 const [orgPassword,setOrgPassword]=useState("");
 const [orgError,setOrgError]=useState("");
 const [orgBusy,setOrgBusy]=useState(false);
 const saveOrgLimits=async()=>{if(!orgEdit)return;setOrgBusy(true);setOrgError("");try{
  const parse=(v:string)=>v.trim()?Number(v):undefined;
  const values=[orgEdit.maxDevices,orgEdit.maxMembers,orgEdit.maxApiTokens];
  if(values.some(v=>v.trim()&&(!Number.isInteger(Number(v))||Number(v)<0||Number(v)>1000000)))throw Error("Enter limits from 0 to 1000000, or blank to inherit.");
  await api("/api/console/organizations/quotas",{method:"POST",body:JSON.stringify({organizationId:orgEdit.id,maxDevices:parse(orgEdit.maxDevices),maxMembers:parse(orgEdit.maxMembers),maxApiTokens:parse(orgEdit.maxApiTokens),currentPassword:orgPassword})});
  const data=await api<{items:Array<Record<string,unknown>>}>("/api/console/organizations");setRecords(data.items);setOrgEdit(null);setOrgPassword("");
 }catch(e){setOrgError(String(e))}finally{setOrgBusy(false)}};

 const refreshUsers=async()=>{const result=await api<{items:Array<Record<string,unknown>>}>("/api/console/users?limit=25&offset="+(userPage*25)+"&q="+encodeURIComponent(userSearch));setRecords(result.items)};
 const applyUserAction=async()=>{if(!targetUser)return;setUserActionBusy(true);setUserActionError("");try{await api("/api/console/users/set-disabled",{method:"POST",body:JSON.stringify({userId:targetUser.id,disabled:!targetUser.disabled,currentPassword:confirmPassword})});await refreshUsers();setTargetUser(null);setConfirmPassword("")}catch(e){setUserActionError(String(e))}finally{setUserActionBusy(false)}};

 const [records,setRecords]=useState<Array<Record<string,unknown>>>([]);
 const [recordsError,setRecordsError]=useState("");
 const [recordsBusy,setRecordsBusy]=useState(false);
 const [billing,setBilling]=useState<{plans:Array<Record<string,unknown>>;subscriptions:Array<Record<string,unknown>>}|null>(null);
 const [system,setSystem]=useState<Record<string,unknown>|null>(null);
 const [planEdit,setPlanEdit]=useState<{key:string;maxDevices:string;maxMembers:string;maxApiTokens:string}|null>(null);
 const [planPassword,setPlanPassword]=useState("");
 const [planError,setPlanError]=useState("");
 const [planBusy,setPlanBusy]=useState(false);
 const saveLimits=async()=>{if(!planEdit)return;setPlanBusy(true);setPlanError("");try{
   const numberOrNull=(value:string)=>value.trim()===""?null:Number(value);
   if([planEdit.maxDevices,planEdit.maxMembers,planEdit.maxApiTokens].some(v=>v.trim()!==""&&(!Number.isInteger(Number(v))||Number(v)<0)))throw Error("Limits must be nonnegative integers, or empty for unlimited.");
   await api("/api/console/plans/limits",{method:"POST",body:JSON.stringify({key:planEdit.key,maxDevices:numberOrNull(planEdit.maxDevices),maxMembers:numberOrNull(planEdit.maxMembers),maxApiTokens:numberOrNull(planEdit.maxApiTokens),currentPassword:planPassword})});
   setBilling(await api("/api/console/billing"));setPlanEdit(null);setPlanPassword("");
 }catch(e){setPlanError(String(e))}finally{setPlanBusy(false)}};

 useEffect(()=>{if(!admin)return;if(section==="Billing")void api<{plans:Array<Record<string,unknown>>;subscriptions:Array<Record<string,unknown>>}>("/api/console/billing").then(setBilling).catch(e=>setRecordsError(String(e)));if(section==="System")void api<Record<string,unknown>>("/api/console/system").then(setSystem).catch(e=>setRecordsError(String(e)))},[admin,section]);
 const [brandKind,setBrandKind]=useState<"logo_light"|"logo_dark"|"favicon">("logo_light");
 const [brandImage,setBrandImage]=useState("");
 const [brandMime,setBrandMime]=useState<"image/png"|"image/webp">("image/png");
 const [brandPassword,setBrandPassword]=useState("");
 const [brandError,setBrandError]=useState("");
 const [brandBusy,setBrandBusy]=useState(false);
 const uploadBrand=async()=>{if(!brandImage)return;setBrandBusy(true);setBrandError("");try{
   await api("/api/console/brand/upload",{method:"POST",body:JSON.stringify({kind:brandKind,mime:brandMime,base64:brandImage.split(",")[1],currentPassword:brandPassword})});
   setBrandError("Saved. Reload the page to see the new logo or favicon.");setBrandPassword("");
 }catch(e){setBrandError(String(e))}finally{setBrandBusy(false)}};
 const readBrand=(file?:File)=>{if(!file)return;if(!["image/png","image/webp"].includes(file.type)||file.size>500000){setBrandError("Choose PNG or WebP under 500 KB");return}const reader=new FileReader();reader.onload=()=>{setBrandMime(file.type as "image/png"|"image/webp");setBrandImage(String(reader.result));setBrandError("")};reader.readAsDataURL(file)};
 const [cmsLocale,setCmsLocale]=useState<"en"|"tr">("en");
 const [cmsSection,setCmsSection]=useState<string>("Hero & navigation");
 const [cmsFilter,setCmsFilter]=useState("");
 const [cmsTitle,setCmsTitle]=useState("");
 const [cmsSubtitle,setCmsSubtitle]=useState("");
 const [cmsSeoTitle,setCmsSeoTitle]=useState("");
 const [cmsSeoDescription,setCmsSeoDescription]=useState("");
 const [cmsOverrides,setCmsOverrides]=useState<Record<string,string>>({});
 const [cmsItems,setCmsItems]=useState<Array<{id:string;hero_title:string;hero_subtitle:string;overrides:Record<string,string>;seo_title:string;seo_description:string;state:string}>>([]);
 const [cmsMessage,setCmsMessage]=useState("");
 const [cmsBusy,setCmsBusy]=useState(false);
 const [cmsPublishPassword,setCmsPublishPassword]=useState("");
 const reloadCms=async()=>{const data=await api<{items:typeof cmsItems}>("/api/console/site-content?locale="+cmsLocale);setCmsItems(data.items)};
 useEffect(()=>{if(section!=="Landing CMS"||!admin)return;void reloadCms().catch(e=>setCmsMessage(String(e)))},[section,cmsLocale,admin]);
 const saveCms=async()=>{setCmsBusy(true);setCmsMessage("");try{await api("/api/console/site-content",{method:"POST",body:JSON.stringify({locale:cmsLocale,heroTitle:cmsTitle,heroSubtitle:cmsSubtitle,overrides:cmsOverrides,seoTitle:cmsSeoTitle,seoDescription:cmsSeoDescription})});await reloadCms();setCmsMessage("Draft saved.")}catch(e){setCmsMessage(String(e))}finally{setCmsBusy(false)}};
 const publishCms=async(id:string)=>{setCmsBusy(true);setCmsMessage("");try{await api("/api/console/site-content/publish",{method:"POST",body:JSON.stringify({id,currentPassword:cmsPublishPassword})});await reloadCms();setCmsPublishPassword("");setCmsMessage("Published. You can now refresh the landing page.")}catch(e){setCmsMessage(String(e))}finally{setCmsBusy(false)}};
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
 const items=[{label:"Overview",icon:LayoutDashboard},{label:"Users",icon:Users},{label:"Organizations",icon:Building2},{label:"Devices",icon:Monitor},{label:"Operations",icon:Activity},{label:"Landing CMS",icon:FileText},{label:"Billing",icon:CreditCard},{label:"System",icon:Settings2},{label:"Brand",icon:ImageIcon}];
 return <div className="dashboard-layout">
  {menu&&<button className="fixed inset-0 bg-black/60 z-[92] md:hidden" aria-label="Close navigation" onClick={()=>setMenu(false)}/>}
  <aside className={"dashboard-sidebar "+(menu?"open":"")} aria-label="Platform administration">
   <div className="px-3 pt-2"><Brand onClick={()=>nav("/")}/></div>
   <div className="px-4 py-5"><div className="flex items-center gap-2 text-[var(--accent)] text-sm font-bold"><ShieldCheck size={18}/> SUPER ADMIN</div></div>
   <nav className="dash-nav">{items.map(item=><button type="button" key={item.label} onClick={()=>{setSection(item.label);setMenu(false);nav(routes[item.label])}} className={"dash-link text-left "+(section===item.label?"active":"")} aria-current={section===item.label?"page":undefined} title={item.label}><item.icon size={19}/><span>{item.label}</span></button>)}</nav>
   <div className="dash-sidebar-bottom"><p className="text-sm muted">Platform administration is separate from workspace ownership.</p><button className="mt-5 text-sm flex items-center gap-2" onClick={()=>nav("/dashboard")}><ArrowLeft size={17}/> User dashboard</button></div>
  </aside>
  <div className="dash-main">
   {sessionUser&&<div className="fixed inset-0 z-[225] bg-black/65 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="User sessions">
    <div className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
      <div className="flex items-center justify-between gap-4 mb-5"><div><h2 className="text-xl font-bold">Sessions — {sessionUser.email}</h2><p className="muted text-sm mt-1">Revoking a session immediately signs that browser out.</p></div><button className="rounded-xl border border-[var(--stroke)] px-4 py-2" onClick={()=>{setSessionUser(null);setSessionPassword("")}}>Close</button></div>
      {sessionError&&<p role="alert" className="text-[var(--danger)] mb-4">{sessionError}</p>}
      {sessionBusy&&<p className="muted text-sm mb-3">Updating sessions…</p>}
      <label className="block font-semibold text-sm mb-4">Current administrator password<input type="password" autoComplete="current-password" className="block mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={sessionPassword} onChange={e=>setSessionPassword(e.target.value)}/></label>
      <div className="grid gap-3">{sessionRows.length===0?<p className="muted">No sessions found.</p>:sessionRows.map(item=><div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--stroke)] p-4" key={item.id}>
        <div className="text-sm"><strong>{item.organization_name}</strong><p className="muted mt-1">Started {new Date(item.created_at).toLocaleString()}</p><p className="muted mt-1">{item.revoked_at?"Revoked":new Date(item.expires_at).getTime()<Date.now()?"Expired":"Active"}</p></div>
        <button className="rounded-lg border border-[var(--stroke)] px-4 py-2 disabled:opacity-40" disabled={sessionBusy||sessionPassword.length<12||!!item.revoked_at||new Date(item.expires_at).getTime()<Date.now()||sessionUser.id===admin.userId} onClick={()=>void revokeUserSession(item.id)}>Revoke</button>
      </div>)}</div>
    </div>
   </div>}
   {memberWorkspace&&<div className="fixed inset-0 z-[225] bg-black/65 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Organization members">
     <div className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
       <div className="flex items-center justify-between gap-4 mb-4">
         <div><h2 className="text-xl font-bold">{memberWorkspace.name} — Members</h2><p className="muted text-sm mt-1">Workspace owner roles and platform administrators cannot be changed here.</p></div>
         <button type="button" onClick={()=>{setMemberWorkspace(null);setMemberTarget(null);setMemberPassword("")}} className="rounded-xl border border-[var(--stroke)] px-4 py-2">Close</button>
       </div>
       {memberBusy?<p className="muted">Loading members…</p>:null}
       {memberError&&<p role="alert" className="text-[var(--danger)] mb-4">{memberError}</p>}
       <div className="grid gap-2">{memberRows.map(person=><div key={person.user_id} className="rounded-xl border border-[var(--stroke)] p-4 flex items-center gap-4 justify-between flex-wrap">
         <div className="min-w-0"><div className="font-medium text-sm break-all">{person.email}</div><div className="muted text-xs mt-1">Role: {person.role}{person.disabled?" · Disabled":""}</div></div>
         <button type="button" disabled={person.role==="owner"||person.user_id===admin.userId} className="rounded-xl border border-[var(--stroke)] px-4 py-2 disabled:opacity-40" onClick={()=>{setMemberTarget(person);setMemberRole(person.role==="viewer"||person.role==="operator"||person.role==="admin"?person.role:"viewer");setMemberPassword("");setMemberError("")}}>Edit role</button>
       </div>)}</div>
       {memberTarget&&<div className="border-t border-[var(--stroke)] mt-6 pt-5">
         <h3 className="font-semibold">Change role: {memberTarget.email}</h3>
         <label className="block mt-4 text-sm">New role<select className="block w-full mt-2 rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={memberRole} onChange={e=>setMemberRole(e.target.value as "viewer"|"operator"|"admin")}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin (workspace only)</option></select></label>
         <label className="block mt-4 text-sm">Your current password<input type="password" autoComplete="current-password" className="block w-full mt-2 rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={memberPassword} onChange={e=>setMemberPassword(e.target.value)}/></label>
         <div className="flex gap-3 justify-end mt-5"><button className="rounded-xl border border-[var(--stroke)] px-4 py-2" onClick={()=>{setMemberTarget(null);setMemberPassword("")}}>Cancel</button><button disabled={roleBusy||memberPassword.length<12||memberRole===memberTarget.role} className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-5 py-2 disabled:opacity-40" onClick={()=>void applyMembershipRole()}>Save role</button></div>
       </div>}
     </div>
   </div>}
   {orgEdit&&<div className="fixed inset-0 z-[230] bg-black/65 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Organization quotas"><div className="w-full max-w-lg rounded-2xl bg-[var(--surface)] border border-[var(--stroke)] p-7"><h2 className="text-xl font-bold mb-2">Workspace limits: {orgEdit.name}</h2><p className="muted text-sm mb-5">Blank means inherit plan defaults; limits cannot activate an unpaid subscription.</p>{(["maxDevices","maxMembers","maxApiTokens"] as const).map(field=><label className="block mb-4" key={field}><span className="text-sm font-semibold">{field}</span><input inputMode="numeric" className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3 mt-1" value={orgEdit[field]} onChange={e=>setOrgEdit({...orgEdit,[field]:e.target.value})}/></label>)}<label className="block text-sm font-semibold mb-2">Current password</label><input type="password" autoComplete="current-password" className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3" value={orgPassword} onChange={e=>setOrgPassword(e.target.value)}/><p role="alert" className="text-[var(--danger)] text-sm mt-2">{orgError}</p><div className="flex justify-end gap-3 mt-6"><button className="rounded-xl border border-[var(--stroke)] px-4 py-3" onClick={()=>{setOrgEdit(null);setOrgPassword("")}}>Cancel</button><button className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-4 py-3 disabled:opacity-50" disabled={orgBusy||orgPassword.length<12} onClick={()=>void saveOrgLimits()}>Save limits</button></div></div></div>}
   {planEdit&&<div className="fixed inset-0 z-[220] bg-black/65 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Edit plan limits"><div className="w-full max-w-lg rounded-2xl bg-[var(--surface)] border border-[var(--stroke)] p-7"><h2 className="text-xl font-bold mb-3">Edit plan limits: {planEdit.key}</h2><p className="muted text-sm mb-5">Leave an input empty for unlimited. This never changes prices or Paddle payments.</p>{(["maxDevices","maxMembers","maxApiTokens"] as const).map(key=><label className="block mb-4" key={key}><span className="text-sm font-semibold">{key}</span><input inputMode="numeric" className="mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3" value={planEdit[key]} onChange={e=>setPlanEdit({...planEdit,[key]:e.target.value})}/></label>)}<label className="block text-sm font-semibold mb-2">Current password</label><input autoComplete="current-password" type="password" className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3" value={planPassword} onChange={e=>setPlanPassword(e.target.value)}/><p role="alert" className="text-[var(--danger)] mt-3 text-sm">{planError}</p><div className="flex justify-end gap-3 mt-5"><button className="rounded-xl border border-[var(--stroke)] px-5 py-3" onClick={()=>{setPlanEdit(null);setPlanPassword("")}}>Cancel</button><button disabled={planBusy||planPassword.length<12} className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-5 py-3 disabled:opacity-50" onClick={()=>void saveLimits()}>Save limits</button></div></div></div>}
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
      {section==="Brand"?<div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6 max-w-3xl"><h2 className="text-xl font-bold mb-3">Brand assets</h2><p className="muted text-sm mb-5">Upload PNG or WebP images up to 500 KB for dark-mode logo, light-mode logo and favicon. Original assets are kept until replaced.</p><label className="block text-sm font-semibold mb-2">Asset</label><select className="w-full bg-[var(--input)] border border-[var(--stroke)] rounded-xl p-3 mb-5" value={brandKind} onChange={e=>{setBrandKind(e.target.value as "logo_light"|"logo_dark"|"favicon");setBrandImage("")}}><option value="logo_light">Logo displayed on dark background</option><option value="logo_dark">Logo displayed on light background</option><option value="favicon">Favicon</option></select><img src={"/api/public/brand/"+brandKind} alt="Current brand asset" className="w-auto max-w-[230px] max-h-[90px] object-contain p-3 rounded-xl bg-neutral-500/20 mb-5"/><label className="block text-sm font-semibold mb-2">Replacement image</label><input type="file" accept="image/png,image/webp" onChange={e=>readBrand(e.target.files?.[0])} className="block w-full text-sm mb-4"/>{brandImage&&<img src={brandImage} alt="Selected asset preview" className="max-h-[120px] max-w-[270px] object-contain p-3 bg-neutral-500/20 rounded-xl mb-5"/>}<label className="block text-sm font-semibold mb-2">Current administrator password</label><input type="password" autoComplete="current-password" value={brandPassword} onChange={e=>setBrandPassword(e.target.value)} className="w-full bg-[var(--input)] border border-[var(--stroke)] rounded-xl p-3 mb-4"/><button className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-6 py-3 font-bold disabled:opacity-50" disabled={brandBusy||brandPassword.length<12||!brandImage} onClick={()=>void uploadBrand()}>Upload asset</button><p className="mt-3 text-sm" role="status">{brandError}</p></div>:section==="Billing"?<div className="grid gap-6">{(["plans","subscriptions"] as const).map(kind=><section key={kind} className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6"><h2 className="text-xl font-bold mb-4">{kind==="plans"?"Plans":"Subscriptions"}</h2>{!billing?<p className="muted">Loading…</p>:billing[kind].length===0?<p className="muted">No records.</p>:billing[kind].map((item,index)=><div key={index} className="border-t border-[var(--stroke)] py-3 text-sm flex gap-4 flex-wrap items-center">{Object.entries(item).map(([key,value])=><span key={key}><strong>{key}:</strong> {String(value??"—")}</span>)}{kind==="plans"&&<button className="ml-auto rounded-lg border border-[var(--stroke)] px-3 py-2" onClick={()=>{setPlanError("");setPlanEdit({key:String(item.key),maxDevices:item.max_devices==null?"":String(item.max_devices),maxMembers:item.max_members==null?"":String(item.max_members),maxApiTokens:item.max_api_tokens==null?"":String(item.max_api_tokens)})}}>Edit quotas</button>}</div>)}</section>)}<p className="muted text-sm">Billing is read-only here. Paddle remains the source of truth for paid subscriptions.</p></div>:section==="System"?<div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6"><h2 className="text-xl font-bold mb-4">System status</h2>{!system?<p className="muted">Loading…</p>:Object.entries(system).map(([key,value])=><div className="py-3 border-b border-[var(--stroke)] text-sm" key={key}><strong>{key}:</strong> {typeof value==="object"?JSON.stringify(value):String(value)}</div>)}<p className="muted mt-5 text-sm">Credentials and secrets are not exposed.</p></div>:section==="Landing CMS"?<div className="rounded-2xl bg-[var(--surface)] border border-[var(--stroke)] p-6 max-w-4xl"><h2 className="font-bold text-xl mb-4">Landing content editor</h2><p className="muted mb-4 text-sm">Edit localized hero copy, save revisions, then publish. Published revisions can be restored by publishing them again.</p><label className="block text-sm font-semibold mb-2">Language</label><select className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3 mb-4" value={cmsLocale} onChange={e=>{setCmsLocale(e.target.value as "en"|"tr");setCmsTitle("");setCmsSubtitle("");setCmsSeoTitle("");setCmsSeoDescription("");setCmsOverrides({});setCmsMessage("")}}><option value="en">English</option><option value="tr">Türkçe</option></select><label className="block text-sm font-semibold mb-2">Hero title</label><input maxLength={160} className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3 mb-4" value={cmsTitle} onChange={e=>setCmsTitle(e.target.value)}/><label className="block text-sm font-semibold mb-2">Hero description</label><textarea maxLength={500} className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3 mb-4" rows={4} value={cmsSubtitle} onChange={e=>setCmsSubtitle(e.target.value)}/><h3 className="text-lg font-bold mt-7 mb-3">Search and sharing metadata</h3>
<p className="muted mb-4 text-sm">Optional localized title and description, shown in search results and social previews. Leave blank to keep the defaults.</p>
<label className="block text-sm font-semibold mb-3">SEO title (up to 70 characters)
 <input maxLength={70} value={cmsSeoTitle} onChange={e=>setCmsSeoTitle(e.target.value)} className="block mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3"/>
</label>
<label className="block text-sm font-semibold mb-5">Meta description (up to 170 characters)
 <textarea rows={3} maxLength={170} value={cmsSeoDescription} onChange={e=>setCmsSeoDescription(e.target.value)} className="block mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3"/>
</label>
<h3 className="text-lg font-bold mt-7 mb-3">All landing sections</h3>
<p className="muted text-sm mb-4">106 editable strings across hero, cards, security, pricing, FAQ and footer. Empty fields use the built-in translation.</p>
<div className="grid sm:grid-cols-2 gap-3 mb-5">
 <label className="block text-sm font-semibold">Content section
  <select className="block mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={cmsSection} onChange={e=>setCmsSection(e.target.value)}>
   {landingCopySections.map(group=><option key={group.name} value={group.name}>{group.name} ({group.keys.length})</option>)}
  </select>
 </label>
 <label className="block text-sm font-semibold">Filter text
  <input className="block mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={cmsFilter} onChange={e=>setCmsFilter(e.target.value)} placeholder="Search editable copy"/>
 </label>
</div>
<div className="grid gap-4">{landingCopySections.find(group=>group.name===cmsSection)?.keys.filter(key=>!cmsFilter||key.toLocaleLowerCase("tr").includes(cmsFilter.toLocaleLowerCase("tr"))).map(key=><label key={key} className="block">
 <span className="font-semibold text-sm">{translate(key)}</span>
 <span className="block muted text-xs my-1">{key}</span>
 <textarea rows={2} maxLength={800} className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={cmsOverrides[key]||""} placeholder={translate(key)} onChange={e=>setCmsOverrides(old=>({...old,[key]:e.target.value}))}/>
</label>)}</div>
<div className="mt-6 mb-5 rounded-2xl border border-[var(--stroke)] bg-[var(--surface-2)] p-5">
 <div className="text-xs uppercase tracking-widest font-semibold text-[var(--accent)] mb-3">Draft hero preview</div>
 <h3 className="text-3xl font-bold break-words">{cmsTitle||translate("Tüm cihazların.")}</h3>
 <p className="muted mt-3 break-words">{cmsSubtitle||translate("Windows, macOS ve Linux cihazlarını güvenle bağla. Terminal, dosya ve görevlerini modern bir panelden veya MCP destekli yapay zekâ araçlarınla yönet.")}</p>
</div>
<button disabled={cmsBusy||!cmsTitle.trim()||!cmsSubtitle.trim()} onClick={()=>void saveCms()} className="px-5 py-3 bg-[var(--accent)] text-[var(--accent-ink)] rounded-xl font-bold disabled:opacity-50">Save draft</button><p role="status" className="text-sm mt-3">{cmsMessage}</p><h3 className="text-lg font-bold mt-8 mb-3">Revisions</h3>
<label className="block mb-4 text-sm font-semibold">Current password to publish or restore a revision
 <input type="password" autoComplete="current-password" value={cmsPublishPassword} onChange={e=>setCmsPublishPassword(e.target.value)} className="block w-full mt-2 rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3"/>
</label>{cmsItems.map(item=><div key={item.id} className="flex flex-wrap items-center justify-between border-t border-[var(--stroke)] py-4 gap-4"><div className="min-w-0"><button className="font-semibold text-left hover:underline" title="Load this revision into editor" onClick={()=>{setCmsTitle(item.hero_title);setCmsSubtitle(item.hero_subtitle);setCmsSeoTitle(item.seo_title||"");setCmsSeoDescription(item.seo_description||"");setCmsOverrides(item.overrides||{});setCmsMessage("Revision loaded into editor.")}}>{item.hero_title}</button><div className="muted text-sm">{item.state} · revision {item.id}</div></div><button disabled={cmsBusy||cmsPublishPassword.length<12||item.state==="published"} className="rounded-xl border border-[var(--stroke)] px-4 py-2 disabled:opacity-50" onClick={()=>void publishCms(item.id)}>{item.state==="published"?"Published":"Publish"}</button></div>)}</div>:section==="Overview"?<><div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
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
        {recordsBusy?<p className="muted py-8">Loading records…</p>:recordsError?<p role="alert" className="text-[var(--danger)]">{recordsError}</p>:records.length===0?<p className="muted py-8">No records.</p>:<table className="w-full text-sm text-left"><thead><tr>{Object.keys(records[0]||{}).map(k=><th key={k} className="px-3 py-3 border-b border-[var(--stroke)] whitespace-nowrap">{k.replaceAll("_"," ")}</th>)}</tr></thead><tbody>{records.map((row,i)=><tr key={String(row.id||i)}>{Object.values(row).map((value,j)=><td key={j} className="px-3 py-3 border-b border-[var(--stroke)] whitespace-nowrap">{value===null?"—":typeof value==="boolean"?(value?"Yes":"No"):String(value)}</td>)}{section==="Organizations"&&<td className="px-3 py-3 border-b border-[var(--stroke)]"><button className="rounded-lg border border-[var(--stroke)] px-3 py-2 text-sm" onClick={()=>{const q=(row.quota_overrides||{}) as Record<string,number|null>;setOrgError("");setOrgEdit({id:String(row.id),name:String(row.name),maxDevices:q.maxDevices==null?"":String(q.maxDevices),maxMembers:q.maxMembers==null?"":String(q.maxMembers),maxApiTokens:q.maxApiTokens==null?"":String(q.maxApiTokens)})}}>Edit quotas</button><button className="ml-2 rounded-lg border border-[var(--stroke)] px-3 py-2 text-sm" onClick={()=>void openMembers({id:String(row.id),name:String(row.name)})}>Members</button></td>}{section==="Users"&&<td className="px-3 py-3 border-b border-[var(--stroke)]"><button onClick={()=>{setUserActionError("");setTargetUser({id:String(row.id),email:String(row.email),disabled:Boolean(row.disabled)})}} className="rounded-lg border border-[var(--stroke)] px-3 py-2 text-sm">{row.disabled?"Enable":"Disable"}</button><button type="button" className="ml-2 rounded-lg border border-[var(--stroke)] px-3 py-2 text-sm" onClick={()=>void openSessions({id:String(row.id),email:String(row.email)})}>Sessions</button></td>}</tr>)}</tbody></table>}
        <p className="muted text-xs mt-5">Read-only records. Administrative changes require audited controls.</p>
       </div>}
    </main>
  </div>
 </div>;
}
