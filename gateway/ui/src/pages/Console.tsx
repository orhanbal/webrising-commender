import {useEffect,useRef,useState} from "react";
import {Activity,ArrowLeft,Building2,ChevronDown,LayoutDashboard,LogOut,Menu,Monitor,Settings2,ShieldCheck,FileText,CreditCard,Image as ImageIcon,Users,X,Mail,ClipboardCheck,UserPlus,Scale} from "lucide-react";
import {AdminTable,Panel,Pill,ShortId,Stat,Toolbar,When,fieldClass,smallButton,type Column,type Tone} from "./ConsoleParts";
import {PageHeader} from "../components/ui";
import {api} from "../api";
import {landingCopySections} from "../landing-copy-sections";
import {LegalEditor} from "./LegalEditor";
import {SystemStatus} from "./SystemStatus";
import {MediaLibrary} from "./MediaLibrary";
import {ConsoleUserDetail} from "./ConsoleUserDetail";
import {consoleText} from "../console-text";
import {LanguageSwitcher,t as translate,useLocale} from "../i18n";
import {Brand,ThemeToggle} from "../App";
import type {Nav,Theme} from "../App";

type Overview={users:number;organizations:number;devices:number;activeDevices:number};
type Row=Record<string,unknown>;
type ReactNodeLike=string|number;
type Admin={email:string;userId:string;platformRole:string};
const faqCopy=landingCopySections.find(group=>group.name==="FAQ")?.keys??[];
const faqPairs:Array<{question:string;answer:string}>=Array.from({length:Math.floor((faqCopy.length-2)/2)},(_,i)=>({
 question:String(faqCopy[2+i*2]??""),answer:String(faqCopy[3+i*2]??""),
})).filter(item=>item.question.length>0&&item.answer.length>0);

const routes:Record<string,string>={Overview:"/console",Users:"/console/users",Organizations:"/console/organizations",Devices:"/console/devices",Operations:"/console/operations","Landing CMS":"/console/landing",Billing:"/console/billing",System:"/console/system",Brand:"/console/brand","Legal CMS":"/console/legal"};
const sectionDescriptions:Record<string,string>={
 Overview:"Platform-wide counts from the production database.",
 Users:"Search accounts, open details and sessions, and disable or enable access. Changes need your password and are audited.",
 Organizations:"Search workspaces, review members and set quota overrides. Changes need your password and are audited.",
 Devices:"Every enrolled device across workspaces, with status and last contact.",
 Operations:"Audit trail of workspace and platform activity, filterable by source and risk.",
 "Landing CMS":"Edit the public landing copy, media and search metadata per language.",
 Billing:"Plans, prices and customer subscription requests.",
 System:"Live operational counters and incident triage.",
 Brand:"Logos and favicon served on every page.",
 "Legal CMS":"Privacy policy and terms of use, per language.",
};
export function ConsolePage({nav,path,theme,toggle,logout}:{nav:Nav;path:string;theme:Theme;toggle:()=>void;logout:()=>void}){
 const currentLocale=useLocale();
 const ui=(source:string)=>consoleText(source,currentLocale);
 const [admin,setAdmin]=useState<Admin|null>(null);
 const [overview,setOverview]=useState<Overview|null>(null);
 const [error,setError]=useState("");
 const [loading,setLoading]=useState(true);
 const [menu,setMenu]=useState(false);
 const [section,setSection]=useState(()=>Object.keys(routes).find(label=>routes[label]===path)||"Overview");
 useEffect(()=>setSection(Object.keys(routes).find(label=>routes[label]===path)||"Overview"),[path]);
 const [userSearch,setUserSearch]=useState("");
 const [userPage,setUserPage]=useState(0);
 const [userTotal,setUserTotal]=useState(0);
 const [organizationSearch,setOrganizationSearch]=useState("");
 const [organizationPage,setOrganizationPage]=useState(0);
 const [organizationTotal,setOrganizationTotal]=useState(0);
 const [auditSearch,setAuditSearch]=useState("");
 const [auditSource,setAuditSource]=useState<"all"|"tenant"|"platform">("all");
 const [auditRisk,setAuditRisk]=useState<"all"|"low"|"medium"|"high"|"critical">("all");
 const [auditPage,setAuditPage]=useState(0);
 const [auditTotal,setAuditTotal]=useState(0);
 const [deviceSearch,setDeviceSearch]=useState("");
 const [deviceStatus,setDeviceStatus]=useState<"all"|"active"|"revoked">("all");
 const [devicePage,setDevicePage]=useState(0);
 const [deviceTotal,setDeviceTotal]=useState(0);
 const [targetUser,setTargetUser]=useState<{id:string;email:string;disabled:boolean}|null>(null);
 const [confirmPassword,setConfirmPassword]=useState("");
 const [userActionBusy,setUserActionBusy]=useState(false);
 const [userActionError,setUserActionError]=useState("");
 const [detailUserId,setDetailUserId]=useState<string|null>(null);
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
 const [recoveryTarget,setRecoveryTarget]=useState<{user_id:string;email:string;role:string}|null>(null);
 const [recoveryReason,setRecoveryReason]=useState("");
 const [recoveryPassword,setRecoveryPassword]=useState("");
 const [recoveryBusy,setRecoveryBusy]=useState(false);
 const applyOwnerRecovery=async()=>{
   if(!recoveryTarget||!memberWorkspace)return;
   setRecoveryBusy(true);setMemberError("");
   try{
     await api("/api/console/organizations/owner-recovery",{method:"POST",body:JSON.stringify({
       organizationId:memberWorkspace.id,userId:recoveryTarget.user_id,reason:recoveryReason.trim(),currentPassword:recoveryPassword,
     })});
     await refreshMembers(memberWorkspace.id);
     setRecoveryTarget(null);setRecoveryReason("");setRecoveryPassword("");
   }catch(e){setMemberError(String(e))}finally{setRecoveryBusy(false)}
 };
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
  const data=await api<{items:Array<Record<string,unknown>>;total:number}>("/api/console/organizations?limit=25&offset="+(organizationPage*25)+"&q="+encodeURIComponent(organizationSearch));setRecords(data.items);setOrganizationTotal(data.total);setOrgEdit(null);setOrgPassword("");
 }catch(e){setOrgError(String(e))}finally{setOrgBusy(false)}};

 const refreshUsers=async()=>{const result=await api<{items:Array<Record<string,unknown>>;total:number}>("/api/console/users?limit=25&offset="+(userPage*25)+"&q="+encodeURIComponent(userSearch));setRecords(result.items);setUserTotal(result.total)};
 const applyUserAction=async()=>{if(!targetUser)return;setUserActionBusy(true);setUserActionError("");try{await api("/api/console/users/set-disabled",{method:"POST",body:JSON.stringify({userId:targetUser.id,disabled:!targetUser.disabled,currentPassword:confirmPassword})});await refreshUsers();setTargetUser(null);setConfirmPassword("")}catch(e){setUserActionError(String(e))}finally{setUserActionBusy(false)}};

 const [records,setRecords]=useState<Array<Record<string,unknown>>>([]);
 const [recordsError,setRecordsError]=useState("");
 const [recordsBusy,setRecordsBusy]=useState(false);
 const [billing,setBilling]=useState<{plans:Array<Record<string,unknown>>;subscriptions:Array<Record<string,unknown>>}|null>(null);
 const [billingRequests,setBillingRequests]=useState<Array<{id:string;organization:string;requested_by_email:string;type:string;message:string;status:string;resolution_note:string;created_at:string}>>([]);
 const [reviewTarget,setReviewTarget]=useState<string|null>(null);
 const [reviewStatus,setReviewStatus]=useState<"in_review"|"closed">("in_review");
 const [reviewNote,setReviewNote]=useState("");
 const [reviewPassword,setReviewPassword]=useState("");
 const [reviewBusy,setReviewBusy]=useState(false);
 const [reviewMessage,setReviewMessage]=useState("");
 const loadBillingRequests=async()=>{
  const data=await api<{items:typeof billingRequests}>("/api/console/billing/requests");
  setBillingRequests(data.items);
 };
 const submitBillingReview=async()=>{
  if(!reviewTarget)return;setReviewBusy(true);setReviewMessage("");
  try{
   await api("/api/console/billing/requests/review",{method:"POST",body:JSON.stringify({
     id:reviewTarget,status:reviewStatus,note:reviewNote.trim(),currentPassword:reviewPassword,
   })});
   await loadBillingRequests();setReviewTarget(null);setReviewPassword("");setReviewNote("");
  }catch(e){setReviewMessage(e instanceof Error?e.message:String(e))}
  finally{setReviewBusy(false)}
 };

 const [system,setSystem]=useState<Record<string,unknown>|null>(null);
 const [planEdit,setPlanEdit]=useState<{key:string;maxDevices:string;maxMembers:string;maxApiTokens:string;monthlyToolCalls:string;hasToolCallLimit:boolean}|null>(null);
 const [planPassword,setPlanPassword]=useState("");
 const [planError,setPlanError]=useState("");
 const [planBusy,setPlanBusy]=useState(false);
 const saveLimits=async()=>{if(!planEdit)return;setPlanBusy(true);setPlanError("");try{
   const numberOrNull=(value:string)=>value.trim()===""?null:Number(value);
   if([planEdit.maxDevices,planEdit.maxMembers,planEdit.maxApiTokens,planEdit.monthlyToolCalls].some(v=>v.trim()!==""&&(!Number.isInteger(Number(v))||Number(v)<0)))throw Error("Limits must be nonnegative integers, or empty for unlimited.");
   await api("/api/console/plans/limits",{method:"POST",body:JSON.stringify({key:planEdit.key,maxDevices:numberOrNull(planEdit.maxDevices),maxMembers:numberOrNull(planEdit.maxMembers),maxApiTokens:numberOrNull(planEdit.maxApiTokens),...(planEdit.hasToolCallLimit||planEdit.monthlyToolCalls.trim()!==""?{monthlyToolCalls:numberOrNull(planEdit.monthlyToolCalls)}:{}),currentPassword:planPassword})});
   setBilling(await api("/api/console/billing"));setPlanEdit(null);setPlanPassword("");
 }catch(e){setPlanError(String(e))}finally{setPlanBusy(false)}};

 useEffect(()=>{if(!admin)return;if(section==="Billing")void api<{plans:Array<Record<string,unknown>>;subscriptions:Array<Record<string,unknown>>}>("/api/console/billing").then(setBilling).catch(e=>setRecordsError(String(e)));if(section==="Billing")void loadBillingRequests().catch(e=>setReviewMessage(String(e)));if(section==="System")void api<Record<string,unknown>>("/api/console/system").then(setSystem).catch(e=>setRecordsError(String(e)))},[admin,section]);
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
 const readBrand=async(file?:File)=>{
  if(!file)return;
  setBrandError("");
  const isSvg=file.type==="image/svg+xml"||file.name.toLowerCase().endsWith(".svg");
  if(isSvg){
    if(file.size>250000){setBrandError("SVG files must be under 250 KB");return}
    const url=URL.createObjectURL(file);
    const image=new Image();
    image.onload=()=>{
      try{
        const ratio=Math.min(1,1024/Math.max(1,image.naturalWidth),1024/Math.max(1,image.naturalHeight));
        const canvas=document.createElement("canvas");
        canvas.width=Math.max(1,Math.round((image.naturalWidth||512)*ratio));
        canvas.height=Math.max(1,Math.round((image.naturalHeight||512)*ratio));
        const ctx=canvas.getContext("2d");
        if(!ctx)throw new Error("Canvas unavailable");
        ctx.drawImage(image,0,0,canvas.width,canvas.height);
        const png=canvas.toDataURL("image/png");
        if(Math.ceil((png.length-png.indexOf(",")-1)*3/4)>500000)throw new Error("Rasterized SVG exceeds 500 KB");
        setBrandMime("image/png");setBrandImage(png);setBrandError("");
      }catch(e){setBrandError("SVG conversion failed: "+String(e))}
      finally{URL.revokeObjectURL(url)}
    };
    image.onerror=()=>{URL.revokeObjectURL(url);setBrandError("Unable to load SVG. Check the source file.")};
    image.src=url;
    return;
  }
  if(!["image/png","image/webp"].includes(file.type)||file.size>500000){setBrandError("Choose SVG, PNG or WebP (500 KB maximum for raster files)");return}
  const reader=new FileReader();
  reader.onload=()=>{setBrandMime(file.type as "image/png"|"image/webp");setBrandImage(String(reader.result));setBrandError("")};
  reader.onerror=()=>setBrandError("Could not read the selected image");
  reader.readAsDataURL(file);
 };
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
 const [recentUsers,setRecentUsers]=useState<Array<Row>>([]);
 const [overviewSystem,setOverviewSystem]=useState<Record<string,unknown>|null>(null);
 const [openRequests,setOpenRequests]=useState<number|null>(null);
 useEffect(()=>{
  if(!admin||section!=="Overview")return;
  let active=true;
  void api<{items:Array<Row>}>("/api/console/users?limit=6&offset=0&q=").then(d=>{if(active)setRecentUsers(d.items)}).catch(()=>{});
  void api<Record<string,unknown>>("/api/console/system").then(d=>{if(active)setOverviewSystem(d)}).catch(()=>{});
  void api<{items:Array<{status:string}>}>("/api/console/billing/requests").then(d=>{if(active)setOpenRequests(d.items.filter(x=>x.status!=="closed").length)}).catch(()=>{});
  return()=>{active=false};
 },[admin,section]);
 const [profileOpen,setProfileOpen]=useState(false);
 const profileRef=useRef<HTMLDivElement>(null);
 // Native keyboard semantics for the existing accessible admin modal surfaces.
 useEffect(()=>{
   if(![sessionUser,memberWorkspace,orgEdit,reviewTarget,planEdit,targetUser].some(Boolean))return;
   const dialog=document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
   if(!dialog)return;
   const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
   const oldOverflow=document.body.style.overflow;
   document.body.style.overflow="hidden";
   const elements=()=>Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')).filter(x=>x.getClientRects().length>0);
   elements()[0]?.focus();
   const onKey=(event:KeyboardEvent)=>{
     if(event.key==="Escape"){
       event.preventDefault();
       if(reviewTarget){setReviewTarget(null);setReviewPassword("");setReviewMessage("")}
       else if(planEdit){setPlanEdit(null);setPlanPassword("")}
       else if(orgEdit){setOrgEdit(null);setOrgPassword("")}
       else if(targetUser){setTargetUser(null);setConfirmPassword("")}
       else if(memberWorkspace){setMemberTarget(null);setMemberWorkspace(null);setMemberPassword("")}
       else if(sessionUser){setSessionUser(null);setSessionPassword("")}
       return;
     }
     if(event.key!=="Tab")return;
     const list=elements();
     if(!list.length){event.preventDefault();return}
     const first=list[0],last=list[list.length-1];
     if(!dialog.contains(document.activeElement)){event.preventDefault();first.focus()}
     else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
     else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
   };
   document.addEventListener("keydown",onKey);
   return()=>{document.removeEventListener("keydown",onKey);document.body.style.overflow=oldOverflow;previous?.focus()};
 },[sessionUser,memberWorkspace,orgEdit,reviewTarget,planEdit,targetUser]);

 useEffect(()=>{if(!profileOpen)return;const outside=(event:PointerEvent)=>{if(profileRef.current&&!profileRef.current.contains(event.target as Node))setProfileOpen(false)};const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")setProfileOpen(false)};document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape)}},[profileOpen]);
 useEffect(()=>{
   let active=true;
   Promise.all([api<Admin>("/api/console/me"),api<Overview>("/api/console/overview")])
    .then(([identity,counts])=>{if(active){setAdmin(identity);setOverview(counts);}})
    .catch(e=>{if(active)setError(e instanceof Error?e.message:"Access denied");})
    .finally(()=>{if(active)setLoading(false);});
   return()=>{active=false};
 },[]);
 useEffect(()=>{
  const names:Record<string,string>={Users:"users",Organizations:"organizations",Devices:"devices",Operations:"audit"};
  if(!admin||!names[section])return;
  let active=true;setRecordsBusy(true);setRecordsError("");
  const suffix=section==="Users"?"?limit=25&offset="+(userPage*25)+"&q="+encodeURIComponent(userSearch):
               section==="Organizations"?"?limit=25&offset="+(organizationPage*25)+"&q="+encodeURIComponent(organizationSearch):
               section==="Operations"?"?limit=25&offset="+(auditPage*25)+"&q="+encodeURIComponent(auditSearch)+"&source="+auditSource+"&risk="+auditRisk:
               section==="Devices"?"?limit=25&offset="+(devicePage*25)+"&q="+encodeURIComponent(deviceSearch)+"&status="+deviceStatus:"";
  api<{items:Array<Record<string,unknown>>;total?:number}>("/api/console/"+names[section]+suffix)
    .then(data=>{if(active){setRecords(data.items);if(section==="Organizations")setOrganizationTotal(data.total??0);if(section==="Users")setUserTotal(data.total??0);if(section==="Operations")setAuditTotal(data.total??0);if(section==="Devices")setDeviceTotal(data.total??0)}})
    .catch(e=>{if(active)setRecordsError(String(e))})
    .finally(()=>{if(active)setRecordsBusy(false)});
  return()=>{active=false}
 },[section,admin,userSearch,userPage,organizationSearch,organizationPage,auditSearch,auditSource,auditRisk,auditPage,deviceSearch,deviceStatus,devicePage]);
 if(loading)return <div className="min-h-screen grid place-items-center text-lg">{translate("Yükleniyor…")}</div>;
 if(error||!admin)return <div className="container-w py-24 max-w-xl">
   <div className="rounded-2xl bg-[var(--surface)] border border-[var(--stroke)] p-8">
    <ShieldCheck size={32} className="text-[var(--accent)] mb-4"/>
    <h1 className="text-2xl font-bold">{ui("Platform administration")}</h1>
    <p className="muted mt-3">{translate("Bu alana yalnızca yetkili platform yöneticileri erişebilir.")}</p>
    <p className="text-sm mt-4">{error}</p>
    <button className="mt-6 px-5 py-3 rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] font-semibold" onClick={()=>nav("/login")}>{ui("Sign in")}</button>
   </div></div>;
 const groups:Array<{title:string;items:Array<{label:string;icon:typeof Users}>}>=[
  {title:"",items:[{label:"Overview",icon:LayoutDashboard}]},
  {title:"Customers",items:[{label:"Users",icon:Users},{label:"Organizations",icon:Building2},{label:"Devices",icon:Monitor},{label:"Billing",icon:CreditCard}]},
  {title:"Monitoring",items:[{label:"Operations",icon:Activity},{label:"System",icon:Settings2}]},
  {title:"Website",items:[{label:"Landing CMS",icon:FileText},{label:"Legal CMS",icon:Scale},{label:"Brand",icon:ImageIcon}]},
 ];
 const limitLabel=(k:string)=>ui(({maxDevices:"Maximum devices",maxMembers:"Maximum members",maxApiTokens:"Maximum API tokens",monthlyToolCalls:"Monthly tool calls"} as Record<string,string>)[k]??k);
 const go=(label:string)=>{setSection(label);setMenu(false);nav(routes[label])};
 const tr=currentLocale;
 const never=ui("Never");
 const riskTone=(r:unknown):Tone=>r==="critical"||r==="high"?"danger":r==="medium"?"warning":"neutral";
 const outcomeTone=(o:unknown):Tone=>o==="success"?"success":typeof o==="string"&&/fail|error|denied|reject/.test(o)?"danger":o==="approval_pending"?"warning":"neutral";
 const platformLabel=(p:unknown)=>({windows:"Windows",macos:"macOS",darwin:"macOS",linux:"Linux"} as Record<string,string>)[String(p).toLowerCase()]??(String(p||"—"));
 const isOnline=(v:unknown)=>typeof v==="string"&&Date.now()-new Date(v).getTime()<5*60_000;
 const quotaChips=(q:unknown)=>{const entries=Object.entries((q||{}) as Record<string,number|null>);const names:Record<string,string>={maxDevices:ui("Devices"),maxMembers:ui("Members"),maxApiTokens:ui("API tokens")};return entries.length?<div className="flex flex-wrap gap-1">{entries.map(([k,v])=><Pill key={k} tone="accent">{names[k]??k}: {v===null?"∞":v}</Pill>)}</div>:<span className="text-[var(--faint)]">{ui("Plan default")}</span>};
 const tableColumns:Record<string,Column<Row>[]>={
  Users:[
   {key:"user",label:ui("User"),render:r=><div className="min-w-0"><div className="font-medium break-all">{String(r.email)}</div><ShortId value={r.id}/></div>},
   {key:"status",label:ui("Status"),render:r=><div className="flex flex-wrap gap-1">{r.disabled?<Pill tone="danger" dot>{ui("Disabled")}</Pill>:<Pill tone="success" dot>{ui("Active")}</Pill>}{!r.verified&&<Pill tone="warning">{ui("Unverified")}</Pill>}</div>},
   {key:"ws",label:ui("Workspaces"),className:"text-right tabular-nums",render:r=>String(r.workspace_count??0)},
   {key:"created",label:ui("Joined"),render:r=><When value={r.created_at} locale={tr} empty={never}/>},
   {key:"login",label:ui("Last login"),render:r=><When value={r.last_login_at} locale={tr} empty={never}/>},
   {key:"actions",label:ui("Actions"),className:"console-actions",render:r=><>
    <button type="button" className={smallButton} onClick={()=>setDetailUserId(String(r.id))}>{ui("Details")}</button>
    <button type="button" className={smallButton} onClick={()=>void openSessions({id:String(r.id),email:String(r.email)})}>{ui("Sessions")}</button>
    <button type="button" className={smallButton+(r.disabled?"":" text-[var(--danger)]")} onClick={()=>{setUserActionError("");setTargetUser({id:String(r.id),email:String(r.email),disabled:Boolean(r.disabled)})}}>{ui(r.disabled?"Enable":"Disable")}</button>
   </>},
  ],
  Organizations:[
   {key:"name",label:ui("Workspace"),render:r=><div className="min-w-0"><div className="font-medium">{String(r.name)}</div><ShortId value={r.id}/></div>},
   {key:"members",label:ui("Members"),className:"text-right tabular-nums",render:r=>String(r.members??0)},
   {key:"devices",label:ui("Devices"),className:"text-right tabular-nums",render:r=>String(r.devices??0)},
   {key:"quota",label:ui("Quota limits"),render:r=>quotaChips(r.quota_overrides)},
   {key:"created",label:ui("Created"),render:r=><When value={r.created_at} locale={tr} empty="—"/>},
   {key:"actions",label:ui("Actions"),className:"console-actions",render:r=><>
    <button type="button" className={smallButton} onClick={()=>void openMembers({id:String(r.id),name:String(r.name)})}>{ui("Members")}</button>
    <button type="button" className={smallButton} onClick={()=>{const q=(r.quota_overrides||{}) as Record<string,number|null>;setOrgError("");setOrgEdit({id:String(r.id),name:String(r.name),maxDevices:q.maxDevices==null?"":String(q.maxDevices),maxMembers:q.maxMembers==null?"":String(q.maxMembers),maxApiTokens:q.maxApiTokens==null?"":String(q.maxApiTokens)})}}>{ui("Edit quotas")}</button>
   </>},
  ],
  Devices:[
   {key:"name",label:ui("Device"),render:r=><div className="min-w-0"><div className="font-medium">{String(r.name)}</div><ShortId value={r.id}/></div>},
   {key:"ws",label:ui("Workspace"),render:r=>String(r.organization_name??"—")},
   {key:"platform",label:ui("Platform"),render:r=><Pill>{platformLabel(r.platform)}</Pill>},
   {key:"agent",label:ui("Agent version"),render:r=>r.agent_version?<code className="font-mono text-xs">{String(r.agent_version)}</code>:<span className="text-[var(--faint)]">—</span>},
   {key:"status",label:ui("Status"),render:r=>r.revoked_at?<Pill tone="danger">{ui("Revoked")}</Pill>:isOnline(r.last_seen_at)?<Pill tone="success" dot>{ui("Online")}</Pill>:<Pill dot>{ui("Offline")}</Pill>},
   {key:"seen",label:ui("Last seen"),render:r=><When value={r.last_seen_at} locale={tr} empty={never}/>},
  ],
  Operations:[
   {key:"when",label:ui("Time"),render:r=><When value={r.created_at} locale={tr} empty="—"/>},
   {key:"action",label:ui("Action"),render:r=><code className="font-mono text-xs break-all">{String(r.tool)}</code>},
   {key:"ws",label:ui("Workspace"),render:r=>String(r.organization_name??"—")},
   {key:"source",label:ui("Source"),render:r=><Pill tone={r.source==="platform"?"accent":"neutral"}>{ui(r.source==="platform"?"Platform":"Workspace")}</Pill>},
   {key:"risk",label:ui("Risk"),render:r=><Pill tone={riskTone(r.risk)}>{ui(String(r.risk).charAt(0).toUpperCase()+String(r.risk).slice(1))}</Pill>},
   {key:"outcome",label:ui("Outcome"),render:r=><Pill tone={outcomeTone(r.outcome)}>{String(r.outcome).replaceAll("_"," ")}</Pill>},
  ],
 };
 return <div className="dashboard-layout">
  {menu&&<button className="fixed inset-0 bg-black/60 z-[92] md:hidden" aria-label={ui("Close navigation")} onClick={()=>setMenu(false)}/>}
  <aside className={"dashboard-sidebar "+(menu?"open":"")} aria-label={ui("Platform administration")}>
   <div className="px-3 pt-2"><Brand onClick={()=>nav("/")}/></div>
   <div className="px-3 pt-4"><span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] font-bold tracking-wider text-[var(--accent)]"><ShieldCheck size={14}/> {ui("SUPER ADMIN")}</span></div>
   <nav className="dash-nav console-nav">{groups.map((group,gi)=><div key={gi} className="grid gap-0.5">{group.title&&<div className="console-nav-heading">{ui(group.title)}</div>}{group.items.map(item=><button type="button" key={item.label} onClick={()=>go(item.label)} className={"dash-link text-left "+(section===item.label?"active":"")} aria-current={section===item.label?"page":undefined}><item.icon size={18}/><span>{ui(item.label)}</span></button>)}</div>)}</nav>
   <div className="mt-auto pt-4 border-t border-[var(--stroke)]"><button className="dash-link w-full" onClick={()=>nav("/dashboard")}><ArrowLeft size={18}/><span>{ui("User dashboard")}</span></button><p className="px-3 pt-2 text-xs text-[var(--faint)]">{ui("Platform administration is separate from workspace ownership.")}</p></div>
  </aside>
  <div className="dash-main">
   {detailUserId&&<ConsoleUserDetail userId={detailUserId} onClose={()=>setDetailUserId(null)} onSessions={user=>void openSessions(user)}/>}
   {sessionUser&&<div className="fixed inset-0 z-[225] bg-black/65 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={ui("User sessions")}>
    <div className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
      <div className="flex items-center justify-between gap-4 mb-5"><div><h2 className="text-xl font-bold">{ui("Sessions")} — {sessionUser.email}</h2><p className="muted text-sm mt-1">{ui("Revoking a session immediately signs that browser out.")}</p></div><button className="rounded-xl border border-[var(--stroke)] px-4 py-2" onClick={()=>{setSessionUser(null);setSessionPassword("")}}>{ui("Close")}</button></div>
      {sessionError&&<p role="alert" className="text-[var(--danger)] mb-4">{sessionError}</p>}
      {sessionBusy&&<p className="muted text-sm mb-3">{ui("Updating sessions…")}</p>}
      <label className="block font-semibold text-sm mb-4">{ui("Current administrator password")}<input type="password" autoComplete="current-password" className="block mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={sessionPassword} onChange={e=>setSessionPassword(e.target.value)}/></label>
      <div className="grid gap-3">{sessionRows.length===0?<p className="muted">{ui("No sessions found.")}</p>:sessionRows.map(item=><div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--stroke)] p-4" key={item.id}>
        <div className="text-sm"><strong>{item.organization_name}</strong><p className="muted mt-1">{ui("Started")} {new Date(item.created_at).toLocaleString()}</p><p className="muted mt-1">{item.revoked_at?"Revoked":new Date(item.expires_at).getTime()<Date.now()?"Expired":"Active"}</p></div>
        <button className="rounded-lg border border-[var(--stroke)] px-4 py-2 disabled:opacity-40" disabled={sessionBusy||sessionPassword.length<12||!!item.revoked_at||new Date(item.expires_at).getTime()<Date.now()||sessionUser.id===admin.userId} onClick={()=>void revokeUserSession(item.id)}>{ui("Revoke")}</button>
      </div>)}</div>
    </div>
   </div>}
   {memberWorkspace&&<div className="fixed inset-0 z-[225] bg-black/65 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={ui("Organization members")}>
     <div className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
       <div className="flex items-center justify-between gap-4 mb-4">
         <div><h2 className="text-xl font-bold">{memberWorkspace.name} — {ui("Members")}</h2><p className="muted text-sm mt-1">{ui("Workspace owner roles and platform administrators cannot be changed here.")}</p></div>
         <button type="button" onClick={()=>{setMemberWorkspace(null);setMemberTarget(null);setMemberPassword("");setRecoveryTarget(null);setRecoveryPassword("")}} className="rounded-xl border border-[var(--stroke)] px-4 py-2">{ui("Close")}</button>
       </div>
       {memberBusy?<p className="muted">{ui("Loading members…")}</p>:null}
       {memberError&&<p role="alert" className="text-[var(--danger)] mb-4">{memberError}</p>}
       <div className="grid gap-2">{memberRows.map(person=><div key={person.user_id} className="rounded-xl border border-[var(--stroke)] p-4 flex items-center gap-4 justify-between flex-wrap">
         <div className="min-w-0"><div className="font-medium text-sm break-all">{person.email}</div><div className="muted text-xs mt-1">{ui("Role")}: {person.role}{person.disabled?" · "+ui("Disabled"):""}</div></div>
         <button type="button" disabled={person.role==="owner"||person.user_id===admin.userId} className="rounded-xl border border-[var(--stroke)] px-4 py-2 disabled:opacity-40" onClick={()=>{setMemberTarget(person);setMemberRole(person.role==="viewer"||person.role==="operator"||person.role==="admin"?person.role:"viewer");setMemberPassword("");setMemberError("")}}>{ui("Edit role")}</button>
         <button type="button" disabled={person.role==="owner"||person.disabled||person.user_id===admin.userId} className="rounded-xl border border-[var(--stroke)] px-4 py-2 disabled:opacity-40" onClick={()=>{setRecoveryTarget(person);setMemberTarget(null);setRecoveryReason("");setRecoveryPassword("");setMemberError("")}}>{ui("Recover as owner")}</button>
       </div>)}</div>
       {recoveryTarget&&<div className="border-t border-[var(--stroke)] mt-6 pt-5" aria-label={ui("Owner recovery")}>
         <h3 className="font-semibold">{ui("Owner recovery")}: {recoveryTarget.email}</h3>
         <p className="muted text-sm mt-1">{ui("Adds the owner role to this verified member. Existing owners keep their role. You cannot recover yourself or another platform administrator.")}</p>
         <label className="block mt-4 text-sm">{ui("Reason (ticket or support reference, at least 10 characters)")}<input type="text" maxLength={500} className="block w-full mt-2 rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={recoveryReason} onChange={e=>setRecoveryReason(e.target.value)}/></label>
         <label className="block mt-4 text-sm">{ui("Your current password")}<input type="password" autoComplete="current-password" className="block w-full mt-2 rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={recoveryPassword} onChange={e=>setRecoveryPassword(e.target.value)}/></label>
         <div className="flex gap-3 justify-end mt-5"><button className="rounded-xl border border-[var(--stroke)] px-4 py-2" onClick={()=>{setRecoveryTarget(null);setRecoveryPassword("")}}>{ui("Cancel")}</button><button disabled={recoveryBusy||recoveryPassword.length<12||recoveryReason.trim().length<10} className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-5 py-2 disabled:opacity-40" onClick={()=>void applyOwnerRecovery()}>{ui("Grant owner role")}</button></div>
       </div>}
       {memberTarget&&<div className="border-t border-[var(--stroke)] mt-6 pt-5">
         <h3 className="font-semibold">{ui("Change role")}: {memberTarget.email}</h3>
         <label className="block mt-4 text-sm">{ui("New role")}<select className="block w-full mt-2 rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={memberRole} onChange={e=>setMemberRole(e.target.value as "viewer"|"operator"|"admin")}><option value="viewer">{ui("Viewer")}</option><option value="operator">{ui("Operator")}</option><option value="admin">{ui("Admin (workspace only)")}</option></select></label>
         <label className="block mt-4 text-sm">{ui("Your current password")}<input type="password" autoComplete="current-password" className="block w-full mt-2 rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={memberPassword} onChange={e=>setMemberPassword(e.target.value)}/></label>
         <div className="flex gap-3 justify-end mt-5"><button className="rounded-xl border border-[var(--stroke)] px-4 py-2" onClick={()=>{setMemberTarget(null);setMemberPassword("")}}>{ui("Cancel")}</button><button disabled={roleBusy||memberPassword.length<12||memberRole===memberTarget.role} className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-5 py-2 disabled:opacity-40" onClick={()=>void applyMembershipRole()}>{ui("Save role")}</button></div>
       </div>}
     </div>
   </div>}
   {orgEdit&&<div className="fixed inset-0 z-[230] bg-black/65 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={ui("Organization quotas")}><div className="w-full max-w-lg rounded-2xl bg-[var(--surface)] border border-[var(--stroke)] p-7"><h2 className="text-xl font-bold mb-2">{ui("Workspace limits")}: {orgEdit.name}</h2><p className="muted text-sm mb-5">{ui("Blank means inherit plan defaults; limits cannot activate an unpaid subscription.")}</p>{(["maxDevices","maxMembers","maxApiTokens"] as const).map(field=><label className="block mb-4" key={field}><span className="text-sm font-semibold">{limitLabel(field)}</span><input inputMode="numeric" className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3 mt-1" value={orgEdit[field]} onChange={e=>setOrgEdit({...orgEdit,[field]:e.target.value})}/></label>)}<label className="block text-sm font-semibold mb-2">{ui("Current password")}</label><input type="password" autoComplete="current-password" className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3" value={orgPassword} onChange={e=>setOrgPassword(e.target.value)}/><p role="alert" className="text-[var(--danger)] text-sm mt-2">{orgError}</p><div className="flex justify-end gap-3 mt-6"><button className="rounded-xl border border-[var(--stroke)] px-4 py-3" onClick={()=>{setOrgEdit(null);setOrgPassword("")}}>{ui("Cancel")}</button><button className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-4 py-3 disabled:opacity-50" disabled={orgBusy||orgPassword.length<12} onClick={()=>void saveOrgLimits()}>{ui("Save limits")}</button></div></div></div>}
   {reviewTarget&&<div className="fixed inset-0 z-[250] bg-black/65 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={ui("Review billing request")}><div className="w-full max-w-lg rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-7">
    <h2 className="text-xl font-bold">{ui("Review billing support request")}</h2>
    <p className="muted text-sm mt-2">{ui("This operation records a support decision only. It does not cancel a Paddle subscription or issue a refund.")}</p>
    <label className="block mt-5 text-sm font-semibold">{ui("Review status")}<select className="mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={reviewStatus} onChange={e=>setReviewStatus(e.target.value as "in_review"|"closed")}><option value="in_review">{ui("In review")}</option><option value="closed">{ui("Closed (support case only)")}</option></select></label>
    <label className="block mt-4 text-sm font-semibold">{ui("Reason / resolution note")}<textarea rows={3} maxLength={2000} className="mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={reviewNote} onChange={e=>setReviewNote(e.target.value)}/></label>
    <label className="block mt-4 text-sm font-semibold">{ui("Current admin password")}<input type="password" autoComplete="current-password" className="mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={reviewPassword} onChange={e=>setReviewPassword(e.target.value)}/></label>
    {reviewMessage&&<p role="alert" className="text-sm text-[var(--danger)] mt-3">{reviewMessage}</p>}
    <div className="flex justify-end gap-3 mt-6"><button className="rounded-xl border border-[var(--stroke)] px-4 py-3" onClick={()=>{setReviewTarget(null);setReviewPassword("");setReviewMessage("")}}>{ui("Cancel")}</button><button disabled={reviewBusy||reviewNote.trim().length<10||reviewPassword.length<12} className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-4 py-3 disabled:opacity-40" onClick={()=>void submitBillingReview()}>{ui("Save review")}</button></div>
   </div></div>}
   {planEdit&&<div className="fixed inset-0 z-[220] bg-black/65 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={ui("Edit plan limits")}><div className="w-full max-w-lg rounded-2xl bg-[var(--surface)] border border-[var(--stroke)] p-7"><h2 className="text-xl font-bold mb-3">{ui("Edit plan limits")}: {billing?.plans.find(p=>p.key===planEdit.key)?.name as string??planEdit.key}</h2><p className="muted text-sm mb-5">{ui("Leave an input empty for unlimited. This never changes prices or Paddle payments.")}</p>{(["maxDevices","maxMembers","maxApiTokens","monthlyToolCalls"] as const).map(key=><label className="block mb-4" key={key}><span className="text-sm font-semibold">{limitLabel(key)}</span><input inputMode="numeric" className="mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3" value={planEdit[key]} onChange={e=>setPlanEdit({...planEdit,[key]:e.target.value})}/></label>)}<label className="block text-sm font-semibold mb-2">{ui("Current password")}</label><input autoComplete="current-password" type="password" className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3" value={planPassword} onChange={e=>setPlanPassword(e.target.value)}/><p role="alert" className="text-[var(--danger)] mt-3 text-sm">{planError}</p><div className="flex justify-end gap-3 mt-5"><button className="rounded-xl border border-[var(--stroke)] px-5 py-3" onClick={()=>{setPlanEdit(null);setPlanPassword("")}}>{ui("Cancel")}</button><button disabled={planBusy||planPassword.length<12} className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-5 py-3 disabled:opacity-50" onClick={()=>void saveLimits()}>{ui("Save limits")}</button></div></div></div>}
   {targetUser&&<div className="fixed inset-0 z-[220] bg-black/65 flex justify-center items-center p-4" role="dialog" aria-modal="true" aria-label={ui("Confirm account change")}><div className="w-full max-w-lg rounded-2xl bg-[var(--surface)] border border-[var(--stroke)] p-7"><h2 className="text-xl font-bold">{ui(targetUser.disabled?"Enable user":"Disable user")}</h2><p className="muted mt-3"><strong className="text-[var(--text)]">{targetUser.email}</strong> — {ui("This operation is audited and requires your current password.")}</p><label className="block mt-5 mb-2 text-sm font-semibold">{ui("Current password")}</label><input type="password" autoComplete="current-password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} className="w-full rounded-xl bg-[var(--input)] border border-[var(--stroke)] p-3"/><p role="alert" className="text-[var(--danger)] mt-3 text-sm">{userActionError}</p><div className="flex gap-3 justify-end mt-6"><button onClick={()=>{setTargetUser(null);setConfirmPassword("")}} className="rounded-xl border border-[var(--stroke)] px-5 py-3">{ui("Cancel")}</button><button disabled={confirmPassword.length<12||userActionBusy} onClick={()=>void applyUserAction()} className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-5 py-3 disabled:opacity-50">{ui("Confirm")}</button></div></div></div>}

    <div className="dash-topbar">
      <div className="flex items-center gap-3"><button className="mobile-dash-open size-9 place-items-center rounded-lg border border-[var(--stroke)]" onClick={()=>setMenu(true)} aria-label={ui("Open navigation")}>{menu?<X/>:<Menu/>}</button><span className="text-sm muted">{ui("Administration")} / <strong className="text-[var(--text)]">{ui(section)}</strong></span></div>
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
      <PageHeader className="mb-6" title={ui(section==="Overview"?"Platform Overview":section)} description={ui(sectionDescriptions[section]??"Platform-wide counts from the production database.")}/>
      {section==="Legal CMS"?<LegalEditor/>:section==="Brand"?<div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6 max-w-3xl"><h2 className="text-xl font-bold mb-3">{ui("Brand assets")}</h2><p className="muted text-sm mb-5">{ui("Upload PNG or WebP images up to 500 KB, or SVG up to 250 KB (converted to PNG), for dark/light logos and favicon. Original assets remain until replaced.")}</p><label className="block text-sm font-semibold mb-2">{ui("Asset")}</label><select className="w-full bg-[var(--input)] border border-[var(--stroke)] rounded-xl p-3 mb-5" value={brandKind} onChange={e=>{setBrandKind(e.target.value as "logo_light"|"logo_dark"|"favicon");setBrandImage("")}}><option value="logo_light">{ui("Logo displayed on dark background")}</option><option value="logo_dark">{ui("Logo displayed on light background")}</option><option value="favicon">{ui("Favicon")}</option></select><img src={"/api/public/brand/"+brandKind} alt="Current brand asset" className="w-auto max-w-[230px] max-h-[90px] object-contain p-3 rounded-xl bg-neutral-500/20 mb-5"/><label className="block text-sm font-semibold mb-2">{ui("Replacement image")}</label><input type="file" accept="image/png,image/webp,image/svg+xml,.svg" onChange={e=>readBrand(e.target.files?.[0])} className="block w-full text-sm mb-4"/>{brandImage&&<img src={brandImage} alt="Selected asset preview" className="max-h-[120px] max-w-[270px] object-contain p-3 bg-neutral-500/20 rounded-xl mb-5"/>}<label className="block text-sm font-semibold mb-2">{ui("Current administrator password")}</label><input type="password" autoComplete="current-password" value={brandPassword} onChange={e=>setBrandPassword(e.target.value)} className="w-full bg-[var(--input)] border border-[var(--stroke)] rounded-xl p-3 mb-4"/><button className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-6 py-3 font-bold disabled:opacity-50" disabled={brandBusy||brandPassword.length<12||!brandImage} onClick={()=>void uploadBrand()}>{ui("Upload asset")}</button><p className="mt-3 text-sm" role="status">{brandError}</p></div>:section==="Billing"?<div className="grid gap-5">
 <Panel flush title={ui("Plans")} description={ui("Limits per plan. Prices live in Paddle.")}>
  {!billing?<p className="muted px-5 pb-5 text-sm">{ui("Loading…")}</p>:<AdminTable rowKey={r=>String(r.key)} rows={billing.plans} columns={[
   {key:"plan",label:ui("Plan"),render:r=><div><div className="font-medium">{String(r.name)}</div><code className="font-mono text-[11px] text-[var(--faint)]">{String(r.key)}</code></div>},
   {key:"devices",label:ui("Devices"),className:"text-right tabular-nums",render:r=>r.max_devices==null?"∞":String(r.max_devices)},
   {key:"members",label:ui("Members"),className:"text-right tabular-nums",render:r=>r.max_members==null?"∞":String(r.max_members)},
   {key:"tokens",label:ui("API tokens"),className:"text-right tabular-nums",render:r=>r.max_api_tokens==null?"∞":String(r.max_api_tokens)},
   {key:"calls",label:ui("Monthly tool calls"),className:"text-right tabular-nums",render:r=>r.monthly_tool_calls==null?"∞":Number(r.monthly_tool_calls).toLocaleString(tr==="tr"?"tr-TR":"en-US")},
   {key:"active",label:ui("Status"),render:r=>r.active?<Pill tone="success" dot>{ui("Active")}</Pill>:<Pill>{ui("Inactive")}</Pill>},
   {key:"actions",label:ui("Actions"),className:"console-actions",render:r=><button type="button" className={smallButton} onClick={()=>{setPlanError("");setPlanEdit({key:String(r.key),maxDevices:r.max_devices==null?"":String(r.max_devices),maxMembers:r.max_members==null?"":String(r.max_members),maxApiTokens:r.max_api_tokens==null?"":String(r.max_api_tokens),monthlyToolCalls:r.monthly_tool_calls==null?"":String(r.monthly_tool_calls),hasToolCallLimit:Boolean(r.has_tool_call_limit)})}}>{ui("Edit quotas")}</button>},
  ]}/>}
 </Panel>
 <Panel flush title={ui("Subscriptions")} description={ui("Paddle remains the only source of truth for paid subscription status.")}>
  {!billing?<p className="muted px-5 pb-5 text-sm">{ui("Loading…")}</p>:billing.subscriptions.length===0?<p className="muted px-5 py-8 text-center text-sm border-t border-[var(--stroke)]">{ui("No records.")}</p>:<AdminTable rowKey={(r,i)=>String(r.organization)+i} rows={billing.subscriptions} columns={[
   {key:"org",label:ui("Workspace"),render:r=><span className="font-medium">{String(r.organization)}</span>},
   {key:"plan",label:ui("Plan"),render:r=><Pill tone="accent">{String(r.plan_key)}</Pill>},
   {key:"status",label:ui("Status"),render:r=><Pill tone={r.status==="active"||r.status==="trialing"?"success":r.status==="past_due"?"warning":r.status==="canceled"?"danger":"neutral"} dot>{String(r.status).replaceAll("_"," ")}{r.cancel_at_period_end?" · "+ui("ends at period end"):""}</Pill>},
   {key:"provider",label:ui("Provider"),render:r=>String(r.provider??"—")},
   {key:"renews",label:ui("Period ends"),render:r=><When value={r.current_period_end} locale={tr} empty="—"/>},
  ]}/>}
 </Panel>
 <Panel title={ui("Cancellation & refund requests")} description={ui("Requests are tracked internally. No provider refund or cancellation is executed by this review queue.")}>
 {billingRequests.length===0?<p className="muted text-sm">{ui("No requests.")}</p>:<div className="grid gap-3">{billingRequests.map(item=><div key={item.id} className="rounded-xl border border-[var(--stroke)] p-4">
   <div className="flex flex-wrap items-center justify-between gap-3"><div><strong className="text-sm">{item.organization}</strong> <Pill tone={item.type==="refund"?"warning":"neutral"}>{item.type}</Pill><p className="muted text-xs mt-1">{item.requested_by_email} · <When value={item.created_at} locale={tr} empty="—"/></p></div><Pill tone={item.status==="closed"?"neutral":item.status==="in_review"?"info":"warning"} dot>{item.status.replace("_"," ")}</Pill></div>
   <p className="text-sm mt-3 break-words">{item.message}</p>
   {item.resolution_note&&<p className="text-sm muted mt-2">{ui("Note")}: {item.resolution_note}</p>}
   {item.status!=="closed"&&<button type="button" className={smallButton+" mt-3"} onClick={()=>{setReviewTarget(item.id);setReviewStatus("in_review");setReviewNote(item.resolution_note||"");setReviewPassword("");setReviewMessage("")}}>{ui("Review")}</button>}
 </div>)}</div>}
 </Panel>
</div>:section==="System"?<SystemStatus data={system}/>:section==="Landing CMS"?<div className="rounded-2xl bg-[var(--surface)] border border-[var(--stroke)] p-6 max-w-4xl"><h2 className="font-bold text-xl mb-4">{ui("Landing content editor")}</h2><p className="muted mb-4 text-sm">{ui("Edit localized hero copy, save revisions, then publish. Published revisions can be restored by publishing them again.")}</p><label className="block text-sm font-semibold mb-2">{ui("Language")}</label><select className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3 mb-4" value={cmsLocale} onChange={e=>{setCmsLocale(e.target.value as "en"|"tr");setCmsTitle("");setCmsSubtitle("");setCmsSeoTitle("");setCmsSeoDescription("");setCmsOverrides({});setCmsMessage("")}}><option value="en">{ui("English")}</option><option value="tr">{ui("Türkçe")}</option></select><label className="block text-sm font-semibold mb-2">{ui("Hero title")}</label><input maxLength={160} className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3 mb-4" value={cmsTitle} onChange={e=>setCmsTitle(e.target.value)}/><label className="block text-sm font-semibold mb-2">{ui("Hero description")}</label><textarea maxLength={500} className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3 mb-4" rows={4} value={cmsSubtitle} onChange={e=>setCmsSubtitle(e.target.value)}/><h3 className="text-lg font-bold mt-7 mb-3">{ui("Search and sharing metadata")}</h3>
<p className="muted mb-4 text-sm">{ui("Optional localized title and description, shown in search results and social previews. Leave blank to keep the defaults.")}</p>
<label className="block text-sm font-semibold mb-3">{ui("SEO title (up to 70 characters)")}
 <input maxLength={70} value={cmsSeoTitle} onChange={e=>setCmsSeoTitle(e.target.value)} className="block mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3"/>
</label>
<label className="block text-sm font-semibold mb-5">{ui("Meta description (up to 170 characters)")}
 <textarea rows={3} maxLength={170} value={cmsSeoDescription} onChange={e=>setCmsSeoDescription(e.target.value)} className="block mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3"/>
</label>
<h3 className="text-lg font-bold mt-7 mb-3">{ui("All landing sections")}</h3>
<p className="muted text-sm mb-4">{ui("106 editable strings across hero, cards, security, pricing, FAQ and footer. Empty fields use the built-in translation.")}</p>
<div className="grid sm:grid-cols-2 gap-3 mb-5">
 <label className="block text-sm font-semibold">{ui("Content section")}
  <select className="block mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={cmsSection} onChange={e=>setCmsSection(e.target.value)}>
   {landingCopySections.map(group=><option key={group.name} value={group.name}>{group.name} ({group.keys.length})</option>)}
  </select>
 </label>
 <label className="block text-sm font-semibold">{ui("Filter text")}
  <input className="block mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={cmsFilter} onChange={e=>setCmsFilter(e.target.value)} placeholder="Search editable copy"/>
 </label>
</div>
<div className="grid gap-4">{cmsSection==="FAQ"?<>
 <p className="muted text-sm">{ui("Questions and answers are paired so publishing cannot separate a question from its answer.")}</p>
 {faqCopy.slice(0,2).map(key=><label key={key} className="block"><span className="font-semibold text-sm">{translate(key)}</span><textarea rows={2} maxLength={800} className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3 mt-2" value={cmsOverrides[key]||""} placeholder={translate(key)} onChange={e=>setCmsOverrides(old=>({...old,[key]:e.target.value}))}/></label>)}
 {faqPairs.filter(pair=>!cmsFilter||[pair.question,pair.answer].some(key=>key.toLocaleLowerCase("tr").includes(cmsFilter.toLocaleLowerCase("tr")))).map((pair,i)=><fieldset key={pair.question} className="rounded-xl border border-[var(--stroke)] p-5">
  <legend className="font-semibold px-2">{ui("FAQ")} {i+1}</legend>
  <label className="block text-sm font-semibold mb-3">{ui("Question")}
   <textarea rows={2} maxLength={800} className="block mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={cmsOverrides[pair.question]||""} placeholder={translate(pair.question)} onChange={e=>setCmsOverrides(old=>({...old,[pair.question]:e.target.value}))}/>
  </label>
  <label className="block text-sm font-semibold">{ui("Answer")}
   <textarea rows={4} maxLength={800} className="block mt-2 w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={cmsOverrides[pair.answer]||""} placeholder={translate(pair.answer)} onChange={e=>setCmsOverrides(old=>({...old,[pair.answer]:e.target.value}))}/>
  </label>
 </fieldset>)}
 </>:landingCopySections.find(group=>group.name===cmsSection)?.keys.filter(key=>!cmsFilter||key.toLocaleLowerCase("tr").includes(cmsFilter.toLocaleLowerCase("tr"))).map(key=><label key={key} className="block">
 <span className="font-semibold text-sm">{translate(key)}</span>
 <span className="block muted text-xs my-1">{key}</span>
 <textarea rows={2} maxLength={800} className="w-full rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3" value={cmsOverrides[key]||""} placeholder={translate(key)} onChange={e=>setCmsOverrides(old=>({...old,[key]:e.target.value}))}/>
</label>)}</div>
<div className="mt-6 mb-5 rounded-2xl border border-[var(--stroke)] bg-[var(--surface-2)] p-5">
 <div className="text-xs uppercase tracking-widest font-semibold text-[var(--accent)] mb-3">{ui("Draft hero preview")}</div>
 <h3 className="text-3xl font-bold break-words">{cmsTitle||translate("Tüm cihazların.")}</h3>
 <p className="muted mt-3 break-words">{cmsSubtitle||translate("Windows, macOS ve Linux cihazlarını güvenle bağla. Terminal, dosya ve görevlerini modern bir panelden veya MCP destekli yapay zekâ araçlarınla yönet.")}</p>
</div>
<MediaLibrary selected={cmsOverrides} onUse={(id,slot)=>setCmsOverrides(old=>({...old,["media:feature:"+slot]:id}))}/>
<button disabled={cmsBusy||!cmsTitle.trim()||!cmsSubtitle.trim()} onClick={()=>void saveCms()} className="px-5 py-3 bg-[var(--accent)] text-[var(--accent-ink)] rounded-xl font-bold disabled:opacity-50">{ui("Save draft")}</button><p role="status" className="text-sm mt-3">{cmsMessage}</p><h3 className="text-lg font-bold mt-8 mb-3">{ui("Revisions")}</h3>
<label className="block mb-4 text-sm font-semibold">{ui("Current password to publish or restore a revision")}
 <input type="password" autoComplete="current-password" value={cmsPublishPassword} onChange={e=>setCmsPublishPassword(e.target.value)} className="block w-full mt-2 rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3"/>
</label>{cmsItems.map(item=><div key={item.id} className="flex flex-wrap items-center justify-between border-t border-[var(--stroke)] py-4 gap-4"><div className="min-w-0"><button className="font-semibold text-left hover:underline" title="Load this revision into editor" onClick={()=>{setCmsTitle(item.hero_title);setCmsSubtitle(item.hero_subtitle);setCmsSeoTitle(item.seo_title||"");setCmsSeoDescription(item.seo_description||"");setCmsOverrides(item.overrides||{});setCmsMessage("Revision loaded into editor.")}}>{item.hero_title}</button><div className="muted text-sm">{item.state} · revision {item.id}</div></div><button disabled={cmsBusy||cmsPublishPassword.length<12||item.state==="published"} className="rounded-xl border border-[var(--stroke)] px-4 py-2 disabled:opacity-50" onClick={()=>void publishCms(item.id)}>{item.state==="published"?"Published":"Publish"}</button></div>)}</div>:section==="Overview"?<div className="grid gap-5">
       <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Stat label={ui("Total users")} value={overview?.users?.toLocaleString(tr==="tr"?"tr-TR":"en-US")??"—"} icon={Users} onClick={()=>go("Users")}/>
        <Stat label={ui("Organizations")} value={overview?.organizations?.toLocaleString(tr==="tr"?"tr-TR":"en-US")??"—"} icon={Building2} onClick={()=>go("Organizations")}/>
        <Stat label={ui("Registered devices")} value={overview?.devices?.toLocaleString(tr==="tr"?"tr-TR":"en-US")??"—"} icon={Monitor} onClick={()=>go("Devices")}/>
        <Stat label={ui("Recently active devices")} value={overview?.activeDevices?.toLocaleString(tr==="tr"?"tr-TR":"en-US")??"—"} hint={overview&&overview.devices?Math.round(overview.activeDevices/overview.devices*100)+"% "+ui("of registered"):undefined} icon={Activity} tone="success" onClick={()=>go("Devices")}/>
       </div>
       <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <Panel flush title={ui("Recent sign-ups")} actions={<button type="button" className={smallButton} onClick={()=>go("Users")}>{ui("All users")}</button>}>
         {recentUsers.length===0?<p className="px-5 pb-5 text-sm text-[var(--muted)]">{ui("No records.")}</p>:<ul className="divide-y divide-[var(--stroke)] border-t border-[var(--stroke)]">{recentUsers.map(u=><li key={String(u.id)} className="flex items-center gap-3 px-5 py-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--subtle-surface)] text-xs font-bold text-[var(--accent)]"><UserPlus size={15}/></span>
          <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{String(u.email)}</div><div className="text-xs text-[var(--muted)]"><When value={u.created_at} locale={tr} empty="—"/></div></div>
          {u.disabled?<Pill tone="danger">{ui("Disabled")}</Pill>:u.verified?<Pill tone="success">{ui("Verified")}</Pill>:<Pill tone="warning">{ui("Unverified")}</Pill>}
         </li>)}</ul>}
        </Panel>
        <Panel title={ui("Needs attention")} actions={<button type="button" className={smallButton} onClick={()=>go("System")}>{ui("System")}</button>}>
         {(()=>{const sys=(overviewSystem||{}) as {mailQueue?:{pending?:number;failed?:number};operations?:{pending_approvals?:number};signupEnabled?:boolean;mailConfigured?:boolean};
          const rows:Array<{icon:typeof Mail;label:string;value:ReactNodeLike;tone:Tone;go:string}>=[
           {icon:Mail,label:ui("Mail delivery failures"),value:sys.mailQueue?.failed??0,tone:(sys.mailQueue?.failed??0)>0?"danger":"success",go:"System"},
           {icon:Mail,label:ui("Pending mail"),value:sys.mailQueue?.pending??0,tone:(sys.mailQueue?.pending??0)>20?"warning":"neutral",go:"System"},
           {icon:ClipboardCheck,label:ui("Pending approvals"),value:sys.operations?.pending_approvals??0,tone:"neutral",go:"System"},
           {icon:CreditCard,label:ui("Open billing requests"),value:openRequests??"—",tone:(openRequests??0)>0?"warning":"neutral",go:"Billing"},
           {icon:UserPlus,label:ui("Public sign-up"),value:sys.signupEnabled===undefined?"—":ui(sys.signupEnabled?"On":"Off"),tone:"neutral",go:"System"},
          ];
          return <ul className="grid gap-1">{rows.map(row=><li key={row.label}><button type="button" onClick={()=>go(row.go)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-[var(--hover)]"><row.icon size={17} className="text-[var(--muted)]"/><span className="flex-1 text-sm">{row.label}</span><Pill tone={row.tone}>{row.value}</Pill></button></li>)}</ul>;})()}
        </Panel>
       </div>
      </div>:<Panel flush className="pt-5">
        {section==="Users"&&<Toolbar ui={ui} label={ui("Search user email")} placeholder={ui("Search user email")} search={userSearch} onSearch={v=>{setUserPage(0);setUserSearch(v)}} page={userPage} total={userTotal} onPage={setUserPage} busy={recordsBusy}/>}
        {section==="Organizations"&&<Toolbar ui={ui} label={ui("Organizations")} placeholder={ui("Search workspaces")} search={organizationSearch} onSearch={v=>{setOrganizationSearch(v);setOrganizationPage(0)}} page={organizationPage} total={organizationTotal} onPage={setOrganizationPage} busy={recordsBusy}/>}
        {section==="Devices"&&<Toolbar ui={ui} label={ui("Search devices")} placeholder={ui("Search device, platform or workspace")} search={deviceSearch} onSearch={v=>{setDeviceSearch(v);setDevicePage(0)}} page={devicePage} total={deviceTotal} onPage={setDevicePage} busy={recordsBusy} filters={
          <select aria-label={ui("Device status")} value={deviceStatus} onChange={e=>{setDeviceStatus(e.target.value as "all"|"active"|"revoked");setDevicePage(0)}} className={fieldClass}>
           <option value="all">{ui("All devices")}</option><option value="active">{ui("Not revoked")}</option><option value="revoked">{ui("Revoked")}</option>
          </select>}/>}
        {section==="Operations"&&<Toolbar ui={ui} label={ui("Search audit records")} placeholder={ui("Search action or workspace")} search={auditSearch} onSearch={v=>{setAuditSearch(v);setAuditPage(0)}} page={auditPage} total={auditTotal} onPage={setAuditPage} busy={recordsBusy} filters={<>
          <select aria-label={ui("Audit source")} value={auditSource} onChange={e=>{setAuditSource(e.target.value as "all"|"tenant"|"platform");setAuditPage(0)}} className={fieldClass}>
           <option value="all">{ui("All sources")}</option><option value="tenant">{ui("Workspace activity")}</option><option value="platform">{ui("Platform activity")}</option>
          </select>
          <select aria-label={ui("Risk filter")} value={auditRisk} onChange={e=>{setAuditRisk(e.target.value as "all"|"low"|"medium"|"high"|"critical");setAuditPage(0)}} className={fieldClass}>
           <option value="all">{ui("All risks")}</option><option value="low">{ui("Low")}</option><option value="medium">{ui("Medium")}</option><option value="high">{ui("High")}</option><option value="critical">{ui("Critical")}</option>
          </select></>}/>}
        {recordsBusy&&records.length===0?<p className="muted px-5 py-10 text-sm">{ui("Loading records…")}</p>:recordsError?<p role="alert" className="px-5 pb-5 text-[var(--danger)]">{recordsError}</p>:records.length===0?<p className="muted px-5 py-10 text-center text-sm border-t border-[var(--stroke)]">{ui("No records.")}</p>:
         <AdminTable columns={tableColumns[section]??[]} rows={records} rowKey={(row,i)=>String(row.item_id||row.id||i)}/>}
        {(section==="Devices"||section==="Operations")&&<p className="muted text-xs px-5 py-4 border-t border-[var(--stroke)]">{ui("Read-only records. Administrative changes require audited controls.")}</p>}
       </Panel>}
    </main>
  </div>
 </div>;
}
