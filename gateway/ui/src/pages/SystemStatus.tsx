import {AlertTriangle,CheckCircle2,Database,Mail,ShieldCheck,RadioTower,Users,ClipboardCheck} from "lucide-react";
import {useLocale} from "../i18n";
import {useEffect,useState} from "react";
import {api} from "../api";
import {consoleText} from "../console-text";

type SystemData={
  mailConfigured?:boolean;
  signupEnabled?:boolean;
  deploymentMode?:string;
  checkedAt?:string;
  database?:string;
  mailQueue?:{pending?:number;delivered?:number;failed?:number};
  operations?:{relay_nodes?:number;healthy_relays?:number;active_sessions?:number;pending_approvals?:number};
};
const count=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?value:0;
type Incident={
 fingerprint:string;kind:"mail_delivery_failed"|"relay_unhealthy";
 severity:"warning"|"critical";title:string;explanation:string;count:number;
 acknowledgedAt:string|null;
};


export function SystemStatus({data}:{data:Record<string,unknown>|null}){
 const language=useLocale();
 const ui=(source:string)=>consoleText(source,language);
 const [incidents,setIncidents]=useState<Incident[]>([]);
 const [incidentError,setIncidentError]=useState("");
 const [incidentLoading,setIncidentLoading]=useState(true);
 const [selected,setSelected]=useState<string|null>(null);
 const [currentPassword,setCurrentPassword]=useState("");
 const [busy,setBusy]=useState(false);
 const reloadIncidents=async()=>{
   const records=await api<{items:Incident[]}>("/api/console/incidents");
   setIncidents(records.items);
 };
 useEffect(()=>{
   let active=true;
   api<{items:Incident[]}>("/api/console/incidents")
    .then(result=>{if(active)setIncidents(result.items)})
    .catch(error=>{if(active)setIncidentError(String(error))})
    .finally(()=>{if(active)setIncidentLoading(false)});
   return()=>{active=false}
 },[]);
 const acknowledge=async()=>{
  if(!selected)return;
  setBusy(true);setIncidentError("");
  try{
    await api("/api/console/incidents/acknowledge",{method:"POST",body:JSON.stringify({
      fingerprint:selected,currentPassword,
    })});
    await reloadIncidents();setCurrentPassword("");setSelected(null);
  }catch(error){setIncidentError(String(error))}finally{setBusy(false)}
 };

 if(!data)return <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6"><p className="muted">{ui("Loading…")}</p></div>;
 const current=data as SystemData;
 const mail=current.mailQueue;
 const ops=current.operations;
 const signals=[
  {title:"Mail delivery failures",value:count(mail?.failed),icon:Mail},
  {title:"Pending mail",value:count(mail?.pending),icon:Mail},
  {title:"Active browser sessions",value:count(ops?.active_sessions),icon:Users},
  {title:"Pending approvals",value:count(ops?.pending_approvals),icon:ClipboardCheck},
  {title:"Healthy relay nodes",value:count(ops?.healthy_relays),icon:RadioTower},
  {title:"Registered relay nodes",value:count(ops?.relay_nodes),icon:RadioTower},
 ];
 const notices:string[]=[];
 if(count(mail?.failed)>0)notices.push("Failed email deliveries require investigation.");
 if(count(ops?.relay_nodes)>0&&count(ops?.healthy_relays)<count(ops?.relay_nodes))
   notices.push("At least one registered relay has not reported a recent heartbeat.");
 if(count(ops?.pending_approvals)>0)notices.push("There are pending operator approvals.");
 if(!current.mailConfigured)notices.push("Branded SMTP delivery is not configured.");
 return <div className="grid gap-6">
  <section className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
   <div className="flex flex-wrap justify-between gap-4 items-start mb-5">
    <div><h2 className="text-xl font-bold">{ui("System status")}</h2><p className="muted text-sm mt-2">{ui("Live operational counters from the gateway database.")}</p></div>
    <div className="flex items-center gap-2 text-sm"><Database size={18}/><strong>{current.database==="connected"?ui("Database connected"):ui("Database status unknown")}</strong></div>
   </div>
   <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
    {signals.map(signal=><div className="rounded-xl border border-[var(--stroke)] p-5" key={signal.title}>
     <div className="flex items-center gap-2 muted text-sm"><signal.icon size={17}/>{ui(signal.title)}</div>
     <div className="text-3xl font-bold mt-3 tabular-nums">{signal.value.toLocaleString(language==="tr"?"tr-TR":"en-US")}</div>
    </div>)}
   </div>
  </section>
  <section className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
   <div className="flex justify-between flex-wrap items-center gap-3 mb-4">
    <div><h3 className="text-lg font-bold">{ui("Incident triage")}</h3>
    <p className="muted text-sm mt-2">{ui("Acknowledgement records a review. It does not resolve or suppress the underlying failure.")}</p></div>
    <button type="button" className="rounded-xl border border-[var(--stroke)] px-4 py-2 text-sm"
      onClick={()=>{setIncidentLoading(true);setIncidentError("");void reloadIncidents().catch(error=>setIncidentError(String(error))).finally(()=>setIncidentLoading(false))}}>{ui("Refresh incidents")}</button>
   </div>
   {incidentLoading?<p className="muted text-sm">{ui("Loading…")}</p>:incidents.length===0?<p className="muted text-sm">{ui("No active incidents were detected.")}</p>:
    <div className="grid gap-3">{incidents.map(incident=><div key={incident.fingerprint} className="rounded-xl border border-[var(--stroke)] p-4">
      <div className="flex justify-between gap-4 items-center flex-wrap">
       <strong className="flex gap-2 items-center"><AlertTriangle size={19}/>{ui(incident.title)} ({incident.count})</strong>
       <span className="text-sm muted">{incident.acknowledgedAt?ui("Reviewed"):ui("Review required")}</span>
      </div>
      <p className="muted text-sm leading-6 mt-2">{ui(incident.explanation)}</p>
      {incident.acknowledgedAt?<p className="muted text-xs mt-2">{ui("Reviewed at")}: {new Date(incident.acknowledgedAt).toLocaleString(language==="tr"?"tr-TR":"en-US")}</p>:
       <button type="button" className="mt-3 rounded-xl border border-[var(--stroke)] px-4 py-2 text-sm" onClick={()=>{setSelected(incident.fingerprint);setCurrentPassword("");setIncidentError("")}}>{ui("Mark reviewed")}</button>}
     </div>)}</div>}
   {selected&&<div className="mt-5 rounded-xl border border-[var(--stroke)] p-5">
    <label className="block text-sm font-semibold">{ui("Current admin password")}
     <input type="password" autoComplete="current-password" value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}
       className="block mt-2 w-full max-w-lg rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3"/>
    </label>
    <div className="flex gap-3 mt-4">
     <button type="button" className="rounded-xl border border-[var(--stroke)] px-4 py-2" onClick={()=>{setSelected(null);setCurrentPassword("")}}>{ui("Cancel")}</button>
     <button type="button" className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-4 py-2 disabled:opacity-40" onClick={()=>void acknowledge()} disabled={busy||currentPassword.length<12}>{ui("Confirm review")}</button>
    </div>
   </div>}
   {incidentError&&<p role="alert" className="text-sm text-[var(--danger)] mt-4">{incidentError}</p>}
  </section>
  <section className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
   <h3 className="text-lg font-bold mb-4">{ui("Operational notices")}</h3>
   {notices.length?notices.map(note=><p key={note} className="flex items-start gap-3 py-3 text-sm border-b border-[var(--stroke)]"><AlertTriangle size={17} className="shrink-0 mt-0.5 text-[var(--accent)]"/>{ui(note)}</p>):
    <p className="text-sm flex items-center gap-2"><CheckCircle2 size={18}/>{ui("No notices from available gateway counters.")}</p>}
   <p className="muted text-xs mt-4">{ui("These are read-only indicators; no external notifications are sent.")}</p>
  </section>
  <section className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
   <h3 className="text-lg font-bold mb-4 flex gap-2 items-center"><ShieldCheck size={19}/>{ui("Configuration summary")}</h3>
   <dl className="grid gap-3 text-sm">
    <div className="flex justify-between gap-4"><dt className="muted">{ui("Deployment mode")}</dt><dd className="font-medium">{current.deploymentMode||"—"}</dd></div>
    <div className="flex justify-between gap-4"><dt className="muted">{ui("Branded SMTP")}</dt><dd className="font-medium">{current.mailConfigured?ui("Configured"):ui("Not configured")}</dd></div>
    <div className="flex justify-between gap-4"><dt className="muted">{ui("Public signup")}</dt><dd className="font-medium">{current.signupEnabled?ui("Enabled"):ui("Disabled")}</dd></div>
    {current.checkedAt&&<div className="flex justify-between gap-4"><dt className="muted">{ui("Last checked")}</dt><dd className="font-medium">{new Date(current.checkedAt).toLocaleString(language==="tr"?"tr-TR":"en-US")}</dd></div>}
   </dl>
   <p className="muted text-sm mt-5">{ui("Credentials and secrets are not exposed.")}</p>
  </section>
 </div>;
}
