import {ShieldAlert} from "lucide-react";
import {useEffect,useState} from "react";
import {api} from "../api";
import {consoleText} from "../console-text";
import {useLocale} from "../i18n";

type ChangeRequest={
 id:string;application_uuid:string;requested_by_actor:string;reason:string;digest:string;
 before_values:Record<string,string|boolean>;after_values:Record<string,string|boolean>;
 status:string;expires_at:string;created_at:string;
};

/** Human approval of AI-proposed Coolify release-setting changes. Approving
 *  binds the decision to the exact diff digest shown here; it never deploys. */
export function CoolifyChangeRequests(){
 const language=useLocale();
 const ui=(source:string)=>consoleText(source,language);
 const [items,setItems]=useState<ChangeRequest[]>([]);
 const [configured,setConfigured]=useState<boolean|null>(null);
 const [selected,setSelected]=useState<{id:string;digest:string;decision:"approve"|"deny"}|null>(null);
 const [currentPassword,setCurrentPassword]=useState("");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const reload=async()=>{
  const result=await api<{configured:boolean;items:ChangeRequest[]}>("/api/console/coolify/change-requests?status=pending");
  setConfigured(result.configured);setItems(result.items);
 };
 useEffect(()=>{void reload().catch(e=>setError(String(e)))},[]);
 const decide=async()=>{
  if(!selected)return;
  setBusy(true);setError("");
  try{
   await api("/api/console/coolify/change-requests/"+selected.id+"/"+selected.decision,{method:"POST",
     body:JSON.stringify({digest:selected.digest,currentPassword})});
   setSelected(null);setCurrentPassword("");await reload();
  }catch(e){setError(String(e))}finally{setBusy(false)}
 };
 const show=(value:string|boolean|undefined)=>value===undefined?"—":String(value);
 return <section className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
  <div className="flex justify-between flex-wrap items-center gap-3 mb-4">
   <div><h3 className="text-lg font-bold flex gap-2 items-center"><ShieldAlert size={19}/>{ui("Coolify change requests")}</h3>
    <p className="muted text-sm mt-2">{ui("AI clients can only propose release-setting changes. Approving applies nothing by itself and never deploys.")}</p></div>
   <button type="button" className="rounded-xl border border-[var(--stroke)] px-4 py-2 text-sm" onClick={()=>void reload().catch(e=>setError(String(e)))}>{ui("Refresh")}</button>
  </div>
  {configured===false&&<p className="muted text-sm mb-3">{ui("Coolify integration is not configured on this gateway.")}</p>}
  {items.length===0?<p className="muted text-sm">{ui("No pending change requests.")}</p>:
   <div className="grid gap-3">{items.map(item=><div key={item.id} className="rounded-xl border border-[var(--stroke)] p-4 text-sm">
    <div className="flex justify-between flex-wrap gap-2"><strong>{item.application_uuid}</strong><span className="muted">{ui("Expires")}: {new Date(item.expires_at).toLocaleString(language==="tr"?"tr-TR":"en-US")}</span></div>
    <p className="mt-2">{item.reason}</p>
    <table className="mt-3 w-full text-left"><thead><tr className="muted"><th>{ui("Field")}</th><th>{ui("Current")}</th><th>{ui("New")}</th></tr></thead>
     <tbody>{Object.keys(item.after_values).map(field=><tr key={field}><td className="font-mono">{field}</td><td>{show(item.before_values[field])}</td><td className="font-semibold">{show(item.after_values[field])}</td></tr>)}</tbody></table>
    <p className="muted text-xs mt-2 font-mono break-all">{ui("Digest")}: {item.digest}</p>
    <div className="flex gap-3 mt-3">
     <button type="button" className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-4 py-2" onClick={()=>{setSelected({id:item.id,digest:item.digest,decision:"approve"});setCurrentPassword("")}}>{ui("Approve")}</button>
     <button type="button" className="rounded-xl border border-[var(--stroke)] px-4 py-2" onClick={()=>{setSelected({id:item.id,digest:item.digest,decision:"deny"});setCurrentPassword("")}}>{ui("Deny")}</button>
    </div>
   </div>)}</div>}
  {selected&&<div className="mt-5 rounded-xl border border-[var(--stroke)] p-5">
   <label className="block text-sm font-semibold">{ui("Current admin password")}
    <input type="password" autoComplete="current-password" value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}
      className="block mt-2 w-full max-w-lg rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3"/>
   </label>
   <div className="flex gap-3 mt-4">
    <button type="button" className="rounded-xl border border-[var(--stroke)] px-4 py-2" onClick={()=>{setSelected(null);setCurrentPassword("")}}>{ui("Cancel")}</button>
    <button type="button" className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-4 py-2 disabled:opacity-40" disabled={busy||currentPassword.length<12} onClick={()=>void decide()}>{selected.decision==="approve"?ui("Confirm approval"):ui("Confirm denial")}</button>
   </div>
  </div>}
  {error&&<p role="alert" className="text-sm text-[var(--danger)] mt-4">{error}</p>}
 </section>;
}
