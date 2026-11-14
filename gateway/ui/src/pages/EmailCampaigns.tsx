import {useEffect,useState} from "react";
import {api} from "../api";
import {useLocale} from "../i18n";
import {Pill,When,fieldClass,smallButton} from "./ConsoleParts";

/** Console > Pazarlama > E-posta kampanyaları: mail to the people who agreed to product news. */

type Email={id:string;subject:string;body:string;audience:{plans:string[];minDays:number|null;maxDays:number|null};status:"draft"|"sent";sent_at:string|null;created_at:string;recipients:number};
type Draft={id?:string;subject:string;body:string;plans:string;minDays:string;maxDays:string};

const L={
 tr:{title:"E-posta kampanyaları",intro:"Ürün haberleri, yeni sürümler ve kampanyalar. Yalnızca kayıtta ya da hesap ayarlarında e-posta almayı kabul edenlere gider; her e-postanın sonunda abonelikten çıkma bağlantısı vardır ve kimse aynı kampanyayı iki kez almaz.",
  subscribers:"Abone",of:"doğrulanmış kullanıcıdan",new:"Yeni e-posta",subject:"Konu",body:"Metin",bodyHelp:"Düz metin. Sonuna abonelikten çıkma bağlantısı kendiliğinden eklenir.",
  audience:"Kime gitsin",plans:"Paketler (virgülle, boş = hepsi)",minDays:"Kayıttan en az … gün",maxDays:"Kayıttan en fazla … gün",reach:"Şu an alacak kişi",
  save:"Kaydet (taslak)",cancel:"Vazgeç",edit:"Düzenle",del:"Sil",test:"Bana deneme gönder",send:"Gönder",sendMore:"Yeni abonelere gönder",
  draft:"Taslak",sent:"Gönderildi",recipients:"Alıcı",confirmDel:"Bu taslak silinsin mi?",saved:"Kaydedildi. Önce kendine deneme gönder, sonra \"Gönder\"e bas.",
  testSent:(to:string)=>`Deneme e-postası ${to} adresine sıraya alındı.`,sentDone:(n:number,r:number)=>`${n} kişiye sıraya alındı.`+(r>0?` ${r} kişi kaldı; tekrar "Gönder"e bas.`:""),
  password:"Göndermek için yönetici şifren",confirm:"Gönder",none:"Henüz e-posta yok. \"Yeni e-posta\" ile ilkini yaz.",noMail:"Sunucuda e-posta ayarlı değil; gönderim yapılamaz.",
  templates:"Hazır şablonlar",tRelease:"WECOMMANDER'da yeni neler var",tRelease2:"Merhaba,\n\nWECOMMANDER'ın yeni sürümü yayında. Öne çıkanlar:\n\n• …\n• …\n\nGüncellemek için uygulamada \"Güncellemeleri denetle\"ye tıkla ya da https://wecommander.app/download adresinden indir.\n\nGörüşlerini bu e-postayı yanıtlayarak bize yazabilirsin.\n\nWECOMMANDER ekibi",
  tWelcome:"WECOMMANDER'dan en iyi şekilde yararlanmak için 3 ipucu",tWelcome2:"Merhaba,\n\nAramıza hoş geldin! Başlamak için üç ipucu:\n\n1. Sunucularını ekle ve tek tıkla bağlan.\n2. Sunucu yönetiminden diski, süreçleri ve zombi süreçleri izle.\n3. Yapay zekâ asistanını MCP ile bağla; komutlar senin onayınla çalışsın.\n\nKolay gelsin,\nWECOMMANDER ekibi"},
 en:{title:"Email campaigns",intro:"Product news, releases and offers. Sent only to people who agreed at sign-up or in their account settings; every mail ends with an unsubscribe link and nobody receives the same campaign twice.",
  subscribers:"Subscribers",of:"of verified users",new:"New email",subject:"Subject",body:"Text",bodyHelp:"Plain text. The unsubscribe link is added at the end automatically.",
  audience:"Who receives it",plans:"Plans (comma separated, empty = all)",minDays:"At least … days after sign-up",maxDays:"At most … days after sign-up",reach:"Would reach now",
  save:"Save (draft)",cancel:"Cancel",edit:"Edit",del:"Delete",test:"Send me a test",send:"Send",sendMore:"Send to new subscribers",
  draft:"Draft",sent:"Sent",recipients:"Recipients",confirmDel:"Delete this draft?",saved:"Saved. Send yourself a test first, then press \"Send\".",
  testSent:(to:string)=>`Test email queued to ${to}.`,sentDone:(n:number,r:number)=>`Queued to ${n} people.`+(r>0?` ${r} remain; press "Send" again.`:""),
  password:"Your administrator password to send",confirm:"Send",none:"No emails yet. Write the first one with \"New email\".",noMail:"Mail is not configured on the server; nothing can be sent.",
  templates:"Templates",tRelease:"What's new in WECOMMANDER",tRelease2:"Hi,\n\nA new WECOMMANDER release is out. Highlights:\n\n• …\n• …\n\nTo update, click \"Check for updates\" in the app or download it from https://wecommander.app/download.\n\nReply to this email to tell us what you think.\n\nThe WECOMMANDER team",
  tWelcome:"3 tips to get the most out of WECOMMANDER",tWelcome2:"Hi,\n\nWelcome aboard! Three tips to get started:\n\n1. Add your servers and connect with one click.\n2. Watch disk, processes and zombie processes in server management.\n3. Connect your AI assistant over MCP; commands run with your approval.\n\nHave fun,\nThe WECOMMANDER team"},
};
const emptyDraft=(subject="",body=""):Draft=>({subject,body,plans:"",minDays:"",maxDays:""});
const audienceOf=(d:Draft)=>{const num=(v:string)=>v.trim()===""?null:Math.max(0,Math.round(Number(v)));return {plans:d.plans.split(",").map(x=>x.trim()).filter(Boolean),minDays:num(d.minDays),maxDays:num(d.maxDays)}};

export function EmailCampaigns(){
 const locale=useLocale();
 const t=L[locale];
 const [items,setItems]=useState<Email[]>([]);
 const [stats,setStats]=useState({subscribers:0,users:0,mailConfigured:true});
 const [draft,setDraft]=useState<Draft|null>(null);
 const [reach,setReach]=useState<number|null>(null);
 const [sending,setSending]=useState<Email|null>(null);
 const [password,setPassword]=useState("");
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState("");
 const load=()=>api<{items:Email[];subscribers:number;users:number;mailConfigured:boolean}>("/api/console/marketing/emails")
  .then(r=>{setItems(r.items);setStats({subscribers:r.subscribers,users:r.users,mailConfigured:r.mailConfigured})}).catch(e=>setMessage(String(e)));
 useEffect(()=>{void load()},[]);
 // How many people the draft would reach, refreshed as the audience changes.
 useEffect(()=>{
  if(!draft){setReach(null);return}
  const timer=setTimeout(()=>{(()=>{const a=audienceOf(draft);const q=new URLSearchParams({plans:a.plans.join(","),minDays:a.minDays==null?"":String(a.minDays),maxDays:a.maxDays==null?"":String(a.maxDays)});return api<{count:number}>("/api/console/marketing/emails/audience?"+q)})().then(r=>setReach(r.count)).catch(()=>setReach(null))},400);
  return()=>clearTimeout(timer);
 },[draft?.plans,draft?.minDays,draft?.maxDays,draft!==null]);

 const act=async(op:()=>Promise<void>)=>{setBusy(true);setMessage("");try{await op()}catch(e){setMessage(String(e))}finally{setBusy(false)}};
 const save=()=>act(async()=>{
  if(!draft)return;
  await api("/api/console/marketing/emails",{method:"POST",body:JSON.stringify({id:draft.id,subject:draft.subject,body:draft.body,audience:audienceOf(draft)})});
  setDraft(null);setMessage(t.saved);await load();
 });
 const test=(id:string)=>act(async()=>{const r=await api<{to:string}>("/api/console/marketing/emails/test",{method:"POST",body:JSON.stringify({id})});setMessage(t.testSent(r.to))});
 const send=()=>act(async()=>{
  if(!sending)return;
  const r=await api<{queued:number;remaining:number}>("/api/console/marketing/emails/send",{method:"POST",body:JSON.stringify({id:sending.id,currentPassword:password})});
  setSending(null);setPassword("");setMessage(t.sentDone(r.queued,r.remaining));await load();
 });
 const remove=(id:string)=>{if(confirm(t.confirmDel))void act(async()=>{await api("/api/console/marketing/emails/delete",{method:"POST",body:JSON.stringify({id})});await load()})};
 const edit=(e:Email)=>setDraft({id:e.id,subject:e.subject,body:e.body,plans:(e.audience.plans??[]).join(", "),minDays:e.audience.minDays==null?"":String(e.audience.minDays),maxDays:e.audience.maxDays==null?"":String(e.audience.maxDays)});
 const field=(label:string,node:React.ReactNode,help?:string)=><label className="block"><span className="block text-sm font-semibold mb-1.5">{label}</span>{node}{help&&<span className="muted text-xs mt-1 block">{help}</span>}</label>;

 if(draft) return <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6 grid gap-4 max-w-3xl">
  {field(t.subject,<input maxLength={150} className={fieldClass} value={draft.subject} onChange={e=>setDraft({...draft,subject:e.target.value})}/>)}
  {field(t.body,<textarea maxLength={20000} rows={14} className={fieldClass+" font-mono text-sm"} value={draft.body} onChange={e=>setDraft({...draft,body:e.target.value})}/>,t.bodyHelp)}
  <h3 className="font-bold mt-2">{t.audience}</h3>
  {field(t.plans,<input className={fieldClass} placeholder="pro, team" value={draft.plans} onChange={e=>setDraft({...draft,plans:e.target.value})}/>)}
  <div className="grid md:grid-cols-2 gap-4">
   {field(t.minDays,<input type="number" min={0} className={fieldClass} value={draft.minDays} onChange={e=>setDraft({...draft,minDays:e.target.value})}/>)}
   {field(t.maxDays,<input type="number" min={0} className={fieldClass} value={draft.maxDays} onChange={e=>setDraft({...draft,maxDays:e.target.value})}/>)}
  </div>
  <p className="text-sm"><span className="muted">{t.reach}:</span> <strong className="tabular-nums">{reach??"…"}</strong></p>
  <div className="flex gap-3 mt-2"><button type="button" disabled={busy||!draft.subject.trim()||!draft.body.trim()} className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-5 py-2.5 font-bold disabled:opacity-50" onClick={()=>void save()}>{t.save}</button><button type="button" className={smallButton} onClick={()=>setDraft(null)}>{t.cancel}</button></div>
  <p className="text-sm" role="status">{message}</p>
 </div>;

 return <div className="grid gap-5 max-w-5xl">
  <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
   <div className="flex flex-wrap items-start gap-3"><div className="flex-1 min-w-[240px]"><h2 className="text-xl font-bold">{t.title}</h2><p className="muted text-sm mt-1">{t.intro}</p></div>
    <button type="button" className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-5 py-2.5 font-bold" onClick={()=>setDraft(emptyDraft())}>+ {t.new}</button></div>
   <div className="mt-4 flex flex-wrap items-baseline gap-2"><span className="text-3xl font-bold tabular-nums">{stats.subscribers}</span><span className="muted text-sm">{t.subscribers} · {stats.users} {t.of}</span></div>
   {!stats.mailConfigured&&<p className="mt-3 text-sm text-[var(--danger)]">{t.noMail}</p>}
   <div className="mt-4 flex flex-wrap gap-2 text-sm"><span className="muted">{t.templates}:</span>
    <button type="button" className={smallButton} onClick={()=>setDraft(emptyDraft(t.tRelease,t.tRelease2))}>🚀 {t.tRelease}</button>
    <button type="button" className={smallButton} onClick={()=>setDraft({...emptyDraft(t.tWelcome,t.tWelcome2),maxDays:"14"})}>👋 {t.tWelcome}</button>
   </div>
   {message&&<p className="text-sm mt-3" role="status">{message}</p>}
  </div>
  {sending&&<div className="rounded-2xl border border-[var(--accent)] bg-[var(--surface)] p-6 grid gap-3">
   <div className="font-semibold">{sending.subject}</div>
   {field(t.password,<input type="password" autoComplete="current-password" className={fieldClass} value={password} onChange={e=>setPassword(e.target.value)}/>)}
   <div className="flex gap-3"><button type="button" disabled={busy||password.length<12} className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-5 py-2.5 font-bold disabled:opacity-50" onClick={()=>void send()}>{t.confirm}</button><button type="button" className={smallButton} onClick={()=>{setSending(null);setPassword("")}}>{t.cancel}</button></div>
  </div>}
  {items.length===0?<p className="muted text-sm">{t.none}</p>:<div className="grid gap-3">{items.map(e=><div key={e.id} className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-5">
   <div className="flex flex-wrap items-center gap-2"><div className="font-semibold flex-1 min-w-[200px]">{e.subject}</div><Pill tone={e.status==="sent"?"success":"neutral"} dot>{e.status==="sent"?t.sent:t.draft}</Pill></div>
   <div className="muted text-sm mt-2 flex flex-wrap gap-x-4 gap-y-1 tabular-nums"><span>{t.recipients}: {e.recipients}</span><span><When value={e.sent_at??e.created_at} locale={locale} empty=""/></span></div>
   <div className="mt-3 flex flex-wrap gap-2">
    <button type="button" disabled={busy||!stats.mailConfigured} className={smallButton} onClick={()=>void test(e.id)}>✉ {t.test}</button>
    <button type="button" disabled={busy||!stats.mailConfigured} className={smallButton} onClick={()=>{setSending(e);setPassword("")}}>▶ {e.status==="sent"?t.sendMore:t.send}</button>
    {e.status==="draft"&&<button type="button" className={smallButton} onClick={()=>edit(e)}>{t.edit}</button>}
    {e.status==="draft"&&<button type="button" className={smallButton+" text-[var(--danger)]"} onClick={()=>remove(e.id)}>{t.del}</button>}
   </div>
  </div>)}</div>}
 </div>;
}
