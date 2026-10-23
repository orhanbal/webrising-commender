import {useEffect,useState} from "react";
import {api} from "../api";
import {useLocale} from "../i18n";
import {consoleText} from "../console-text";
type Page="privacy"|"terms";
type Locale="en"|"tr";
type Revision={id:string;title:string;body:string;state:string;created_at:string};

export function LegalEditor(){
 const currentLocale=useLocale();
 const ui=(source:string)=>consoleText(source,currentLocale);
 const [page,setPage]=useState<Page>("privacy");
 const [locale,setLocale]=useState<Locale>("en");
 const [title,setTitle]=useState("");
 const [body,setBody]=useState("");
 const [password,setPassword]=useState("");
 const [revisions,setRevisions]=useState<Revision[]>([]);
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState("");
 const [error,setError]=useState("");
 const reload=async()=>{
  const result=await api<{items:Revision[]}>("/api/console/legal?page="+page+"&locale="+locale);
  setRevisions(result.items);
 };
 useEffect(()=>{let active=true;setTitle("");setBody("");setPassword("");setMessage("");setError("");
  api<{items:Revision[]}>("/api/console/legal?page="+page+"&locale="+locale)
   .then(result=>{if(active)setRevisions(result.items)})
   .catch(e=>{if(active)setError(String(e))});
  return()=>{active=false};
 },[page,locale]);
 const save=async()=>{setBusy(true);setMessage("");setError("");try{
  await api("/api/console/legal",{method:"POST",body:JSON.stringify({page,locale,title:title.trim(),body:body.trim()})});
  await reload();setMessage(ui("Legal page draft saved. The live page is unchanged."));
 }catch(e){setError(String(e))}finally{setBusy(false)}};
 const publish=async(id:string)=>{setBusy(true);setMessage("");setError("");try{
  await api("/api/console/legal/publish",{method:"POST",body:JSON.stringify({id,currentPassword:password})});
  await reload();setPassword("");setMessage(ui("Published legal page. The previous published revision is still available for rollback."));
 }catch(e){setError(String(e))}finally{setBusy(false)}};
 return <section className="max-w-5xl rounded-2xl bg-[var(--surface)] border border-[var(--stroke)] p-6">
  <h2 className="text-xl font-bold">{ui("Privacy & terms editor")}</h2>
  <p className="text-sm muted mt-2 mb-6">{ui("Maintain EN/TR legal drafts and published versions. Only publish content reviewed by the appropriate legal owner. Text is rendered as plain paragraphs, never executable HTML.")}</p>
  <div className="grid sm:grid-cols-2 gap-4">
   <label className="text-sm font-semibold">Page
    <select value={page} onChange={e=>setPage(e.target.value as Page)} className="block mt-2 w-full p-3 rounded-xl border border-[var(--stroke)] bg-[var(--surface)]"><option value="privacy">{ui("Privacy policy")}</option><option value="terms">{ui("Terms of service")}</option></select>
   </label>
   <label className="text-sm font-semibold">Language
    <select value={locale} onChange={e=>setLocale(e.target.value as Locale)} className="block mt-2 w-full p-3 rounded-xl border border-[var(--stroke)] bg-[var(--surface)]"><option value="en">{ui("English")}</option><option value="tr">{ui("Türkçe")}</option></select>
   </label>
  </div>
  <label className="block text-sm font-semibold mt-5">Page heading
   <input value={title} maxLength={160} onChange={e=>setTitle(e.target.value)} className="block mt-2 w-full p-3 rounded-xl border border-[var(--stroke)] bg-[var(--surface)]"/>
  </label>
  <label className="block text-sm font-semibold mt-5">Full legal text (up to 30,000 characters)
   <textarea value={body} maxLength={30000} rows={14} onChange={e=>setBody(e.target.value)} className="block mt-2 w-full p-3 rounded-xl border border-[var(--stroke)] bg-[var(--surface)]"/>
  </label>
  <p className="muted text-xs mt-2">{body.length} / 30000 characters</p>
  <div className="mt-6 rounded-xl border border-[var(--stroke)] p-5">
   <h3 className="font-bold mb-3">{ui("Draft preview")}</h3>
   <h4 className="text-lg font-semibold break-words">{title||"Untitled legal page"}</h4>
   <div className="mt-4 space-y-4">{body.split(/\n\s*\n/).filter(Boolean).map((paragraph,index)=><p key={index} className="whitespace-pre-wrap break-words text-sm leading-7">{paragraph}</p>)}</div>
  </div>
  <button disabled={busy||title.trim().length<1||body.trim().length<20} onClick={()=>void save()} className="mt-5 rounded-xl px-5 py-3 bg-[var(--accent)] text-[var(--accent-ink)] font-semibold disabled:opacity-40">{ui("Save new draft")}</button>
  {error&&<p role="alert" className="mt-4 text-sm text-[var(--danger)]">{error}</p>}
  {message&&<p role="status" className="mt-4 text-sm">{message}</p>}
  <h3 className="text-lg font-bold mt-9 mb-3">{ui("Revision history")}</h3>
  <label className="block text-sm font-semibold mb-4">Current admin password (required to publish)
   <input value={password} type="password" autoComplete="current-password" onChange={e=>setPassword(e.target.value)} className="block w-full p-3 mt-2 rounded-xl border border-[var(--stroke)] bg-[var(--surface)]"/>
  </label>
  <div className="grid gap-3">{revisions.length===0?<p className="muted text-sm">{ui("No revisions yet.")}</p>:revisions.map(item=><div key={item.id} className="flex flex-wrap justify-between items-center gap-4 rounded-xl border border-[var(--stroke)] p-4">
    <div className="min-w-0"><button type="button" onClick={()=>{setTitle(item.title);setBody(item.body);setMessage(ui("Revision loaded for editing; save a new draft before publishing changes."))}} className="font-semibold text-left hover:underline">{item.title}</button><p className="muted text-xs mt-2">{item.state} · {new Date(item.created_at).toLocaleString()}</p></div>
    <button type="button" disabled={busy||password.length<12||item.state==="published"} onClick={()=>void publish(item.id)} className="px-4 py-2 rounded-xl border border-[var(--stroke)] disabled:opacity-40">{item.state==="published"?"Published":"Publish / restore"}</button>
   </div>)}</div>
 </section>;
}
