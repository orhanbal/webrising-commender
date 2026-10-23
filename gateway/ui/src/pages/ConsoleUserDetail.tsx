import {useEffect,useRef,useState} from "react";
import {ShieldCheck,Users,Monitor,CalendarClock,X} from "lucide-react";
import {api} from "../api";
import {useLocale} from "../i18n";
import {consoleText} from "../console-text";

export type ConsoleUser={
 id:string;email:string;created_at:string;last_login_at:string|null;
 disabled:boolean;verified:boolean;platform_administrator:boolean;
 active_sessions:number;revoked_sessions:number;
};
type Membership={id:string;name:string;role:string;created_at:string};
type Detail={user:ConsoleUser;organizations:Membership[]};
type Props={userId:string;onClose:()=>void;onSessions:(user:{id:string;email:string})=>void};
export function ConsoleUserDetail({userId,onClose,onSessions}:Props){
 const locale=useLocale(),ui=(message:string)=>consoleText(message,locale);
 const [detail,setDetail]=useState<Detail|null>(null);
 const [loading,setLoading]=useState(true),[error,setError]=useState("");
 const root=useRef<HTMLDivElement>(null),previousFocus=useRef<HTMLElement|null>(null);
 useEffect(()=>{
  let active=true;setLoading(true);setDetail(null);setError("");
  api<Detail>("/api/console/users/detail?userId="+encodeURIComponent(userId))
    .then(value=>{if(active)setDetail(value)})
    .catch(e=>{if(active)setError(String(e))})
    .finally(()=>{if(active)setLoading(false)});
  return()=>{active=false};
 },[userId]);
 useEffect(()=>{
  previousFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
  const oldOverflow=document.body.style.overflow;
  document.body.style.overflow="hidden";
  const focusable=()=>Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),[href],input:not(:disabled),[tabindex]:not([tabindex="-1"])')||[])
   .filter(node=>node.getClientRects().length>0);
  focusable()[0]?.focus();
  const onKey=(event:KeyboardEvent)=>{
   if(event.key==="Escape"){event.preventDefault();onClose();return}
   if(event.key!=="Tab")return;
   const nodes=focusable();
   if(!nodes.length){event.preventDefault();return}
   const first=nodes[0],last=nodes[nodes.length-1];
   if(!root.current?.contains(document.activeElement)){event.preventDefault();first.focus()}
   else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
  };
  document.addEventListener("keydown",onKey);
  return()=>{document.removeEventListener("keydown",onKey);document.body.style.overflow=oldOverflow;previousFocus.current?.focus()};
 },[onClose]);
 const date=(value:string|null)=>value?new Date(value).toLocaleString(locale==="tr"?"tr-TR":"en-US"):"—";
 return <div ref={root} role="dialog" aria-modal="true" aria-label={ui("User details")} className="fixed inset-0 z-[230] bg-black/70 flex items-center justify-center p-4">
  <section className="w-full max-w-3xl max-h-[85vh] overflow-y-auto bg-[var(--surface)] border border-[var(--stroke)] rounded-2xl p-6 sm:p-8">
   <div className="flex justify-between items-start gap-4">
    <div><div className="flex gap-2 items-center text-[var(--accent)] mb-3"><ShieldCheck size={19}/><span className="text-xs uppercase tracking-wider font-semibold">{ui("User details")}</span></div>
      <h2 className="text-xl sm:text-2xl font-bold break-all">{detail?.user.email||ui("User details")}</h2>
    </div>
    <button type="button" onClick={onClose} aria-label={ui("Close")} className="shrink-0 rounded-lg border border-[var(--stroke)] p-3"><X size={19}/></button>
   </div>
   {loading?<p className="muted mt-6" role="status">{ui("Loading…")}</p>:error?<p className="text-[var(--danger)] mt-6" role="alert">{error}</p>:detail&&<>
    <div className="grid sm:grid-cols-2 gap-3 mt-6">
     <div className="rounded-xl border border-[var(--stroke)] p-4"><p className="muted text-sm">{ui("Account status")}</p><p className="font-semibold mt-2">{detail.user.disabled?ui("Disabled"):ui("Active")}</p></div>
     <div className="rounded-xl border border-[var(--stroke)] p-4"><p className="muted text-sm">{ui("Email verification")}</p><p className="font-semibold mt-2">{detail.user.verified?ui("Verified"):ui("Not verified")}</p></div>
     <div className="rounded-xl border border-[var(--stroke)] p-4"><p className="muted text-sm">{ui("Platform access")}</p><p className="font-semibold mt-2">{detail.user.platform_administrator?ui("Platform administrator"):ui("Workspace member")}</p></div>
     <div className="rounded-xl border border-[var(--stroke)] p-4"><div className="flex gap-2 muted items-center text-sm"><Monitor size={17}/>{ui("Active sessions")}</div><p className="font-semibold text-2xl tabular-nums mt-2">{detail.user.active_sessions}</p></div>
    </div>
    <div className="grid sm:grid-cols-2 gap-3 text-sm mt-5">
      <p className="flex items-center gap-2"><CalendarClock size={16}/>{ui("Created")}: {date(detail.user.created_at)}</p>
      <p className="flex items-center gap-2"><CalendarClock size={16}/>{ui("Last login")}: {date(detail.user.last_login_at)}</p>
    </div>
    <div className="mt-6 flex items-center justify-between flex-wrap gap-3">
      <h3 className="text-lg font-bold flex gap-2 items-center"><Users size={20}/>{ui("Workspace memberships")} ({detail.organizations.length})</h3>
      <button type="button" className="rounded-xl border border-[var(--stroke)] px-4 py-2" onClick={()=>{onClose();onSessions({id:detail.user.id,email:detail.user.email})}}>{ui("Sessions")}</button>
    </div>
    {detail.organizations.length===0?<p className="muted mt-4">{ui("No workspace memberships.")}</p>:
      <div className="grid gap-3 mt-4">{detail.organizations.map(org=><div key={org.id} className="rounded-xl border border-[var(--stroke)] p-4 flex justify-between gap-4 flex-wrap">
        <div><p className="font-semibold break-words">{org.name}</p><p className="muted text-sm mt-1">{ui("Joined")}: {date(org.created_at)}</p></div>
        <p className="text-sm font-semibold">{org.role}</p>
      </div>)}</div>}
    <p className="muted text-xs mt-6">{ui("This view does not expose passwords, tokens or raw session credentials.")}</p>
   </>}
  </section>
 </div>;
}
