import {useEffect,useState} from "react";
import {api} from "../api";
import {useLocale} from "../i18n";
import {MessageCard,type InAppMessage} from "../components/MessageCard";
import {Pill,When,fieldClass,smallButton,type Tone} from "./ConsoleParts";

/** Console > Pazarlama > Mesajlar ve anketler: in-app messages, surveys and their results. */

type Campaign={id:string;kind:InAppMessage["kind"];title:string;body:string;cta_label:string|null;cta_url:string|null;
 audience:{platforms:string[];plans:string[];minDays:number|null;maxDays:number|null};status:"draft"|"active"|"ended";
 starts_at:string|null;ends_at:string|null;created_at:string;reached:number;answered:number;dismissed:number;clicked:number;average:number|null};
type Results={campaign:Campaign;distribution:Array<{score:number;n:number}>;nps:number|null;platforms:Array<{platform:string;n:number}>;comments:Array<{score:number|null;comment:string;platform:string;updated_at:string;email:string}>};
type Draft={id?:string;kind:InAppMessage["kind"];title:string;body:string;ctaLabel:string;ctaUrl:string;platforms:string[];plans:string;minDays:string;maxDays:string;startsAt:string;endsAt:string};

const L={
 tr:{title:"Mesajlar ve anketler",intro:"Uygulamalarda ve web panelinde sol altta görünen anketler, duyurular ve ipuçları. Her kişi bir mesajı bir kez görür; cevaplayınca ya da kapatınca bir daha gösterilmez.",
  new:"Yeni mesaj",kinds:{csat:"Memnuniyet anketi (1–5)",nps:"Tavsiye puanı (NPS, 0–10)",announcement:"Duyuru",tip:"İpucu"},
  status:{draft:"Taslak",active:"Yayında",ended:"Bitti"},kind:"Tür",heading:"Başlık",body:"Metin",cta:"Düğme yazısı",ctaUrl:"Düğme bağlantısı (https)",
  audience:"Kime gösterilsin",platforms:"Platformlar (boş = hepsi)",plans:"Paketler (virgülle, boş = hepsi)",minDays:"Kayıttan en az … gün",maxDays:"Kayıttan en fazla … gün",
  starts:"Başlangıç",ends:"Bitiş",save:"Kaydet (taslak)",cancel:"Vazgeç",preview:"Önizleme",edit:"Düzenle",publish:"Yayınla",stop:"Durdur",results:"Sonuçlar",del:"Sil",
  reached:"Gören",answered:"Cevaplayan",dismissed:"Kapatan",clicked:"Tıklayan",avg:"Ortalama",nps:"NPS",comments:"Yorumlar",none:"Henüz mesaj yok. \"Yeni mesaj\" ile ilk anketini oluştur.",
  confirmDel:"Bu mesaj ve tüm cevapları silinsin mi?",noComments:"Henüz yorum yok.",back:"Listeye dön",distribution:"Puan dağılımı",byPlatform:"Platformlara göre",
  templates:"Hazır şablonlar",tCsat:"WECOMMANDER'ı kullanmak nasıl gidiyor?",tNps:"WECOMMANDER'ı bir arkadaşına ne kadar olası tavsiye edersin?",
  saved:"Kaydedildi. Hazır olunca \"Yayınla\"ya bas."},
 en:{title:"Messages & surveys",intro:"Surveys, announcements and tips shown bottom left in the apps and the web dashboard. Each person sees a message once; answering or closing it hides it for good.",
  new:"New message",kinds:{csat:"Satisfaction survey (1–5)",nps:"Recommendation score (NPS, 0–10)",announcement:"Announcement",tip:"Tip"},
  status:{draft:"Draft",active:"Live",ended:"Ended"},kind:"Type",heading:"Title",body:"Text",cta:"Button label",ctaUrl:"Button link (https)",
  audience:"Who sees it",platforms:"Platforms (empty = all)",plans:"Plans (comma separated, empty = all)",minDays:"At least … days after sign-up",maxDays:"At most … days after sign-up",
  starts:"Starts",ends:"Ends",save:"Save (draft)",cancel:"Cancel",preview:"Preview",edit:"Edit",publish:"Publish",stop:"Stop",results:"Results",del:"Delete",
  reached:"Seen",answered:"Answered",dismissed:"Closed",clicked:"Clicked",avg:"Average",nps:"NPS",comments:"Comments",none:"No messages yet. Create your first survey with \"New message\".",
  confirmDel:"Delete this message and all its answers?",noComments:"No comments yet.",back:"Back to the list",distribution:"Score distribution",byPlatform:"By platform",
  templates:"Templates",tCsat:"How do you feel about using WECOMMANDER lately?",tNps:"How likely are you to recommend WECOMMANDER to a friend?",
  saved:"Saved. Press \"Publish\" when it is ready."},
};
const platformNames:Record<string,string>={windows:"Windows",macos:"macOS",linux:"Linux",web:"Web"};
const statusTone:Record<Campaign["status"],Tone>={draft:"neutral",active:"success",ended:"warning"};
const emptyDraft=(kind:InAppMessage["kind"]="csat",title=""):Draft=>({kind,title,body:"",ctaLabel:"",ctaUrl:"",platforms:[],plans:"",minDays:"",maxDays:"",startsAt:"",endsAt:""});
const toLocalInput=(v:string|null)=>v?new Date(new Date(v).getTime()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16):"";

export function Marketing(){
 const locale=useLocale();
 const t=L[locale];
 const [items,setItems]=useState<Campaign[]>([]);
 const [draft,setDraft]=useState<Draft|null>(null);
 const [results,setResults]=useState<Results|null>(null);
 const [message,setMessage]=useState("");
 const load=()=>api<{items:Campaign[]}>("/api/console/marketing/campaigns").then(r=>setItems(r.items)).catch(e=>setMessage(String(e)));
 useEffect(()=>{void load()},[]);

 const save=async()=>{
  if(!draft)return;
  setMessage("");
  try{
   const num=(v:string)=>v.trim()===""?null:Math.max(0,Math.round(Number(v)));
   await api("/api/console/marketing/campaigns",{method:"POST",body:JSON.stringify({
    id:draft.id,kind:draft.kind,title:draft.title,body:draft.body,
    ctaLabel:draft.ctaLabel.trim()||null,ctaUrl:draft.ctaUrl.trim()||null,
    audience:{platforms:draft.platforms,plans:draft.plans.split(",").map(x=>x.trim()).filter(Boolean),minDays:num(draft.minDays),maxDays:num(draft.maxDays)},
    startsAt:draft.startsAt?new Date(draft.startsAt).toISOString():null,endsAt:draft.endsAt?new Date(draft.endsAt).toISOString():null,
   })});
   setDraft(null);setMessage(t.saved);await load();
  }catch(e){setMessage(String(e))}
 };
 const setStatus=async(id:string,status:Campaign["status"])=>{try{await api("/api/console/marketing/status",{method:"POST",body:JSON.stringify({id,status})});await load()}catch(e){setMessage(String(e))}};
 const remove=async(id:string)=>{if(!confirm(t.confirmDel))return;try{await api("/api/console/marketing/delete",{method:"POST",body:JSON.stringify({id})});await load()}catch(e){setMessage(String(e))}};
 const open=async(id:string)=>{try{setResults(await api<Results>("/api/console/marketing/results?id="+id))}catch(e){setMessage(String(e))}};
 const edit=(c:Campaign)=>setDraft({id:c.id,kind:c.kind,title:c.title,body:c.body,ctaLabel:c.cta_label??"",ctaUrl:c.cta_url??"",platforms:c.audience.platforms??[],plans:(c.audience.plans??[]).join(", "),minDays:c.audience.minDays==null?"":String(c.audience.minDays),maxDays:c.audience.maxDays==null?"":String(c.audience.maxDays),startsAt:toLocalInput(c.starts_at),endsAt:toLocalInput(c.ends_at)});

 if(results){
  const c=results.campaign;
  const total=results.distribution.reduce((s,d)=>s+d.n,0);
  const range=c.kind==="csat"?[1,2,3,4,5]:c.kind==="nps"?Array.from({length:11},(_,i)=>i):[];
  const max=Math.max(1,...results.distribution.map(d=>d.n));
  return <div className="grid gap-5 max-w-5xl">
   <button type="button" className={smallButton+" w-fit"} onClick={()=>setResults(null)}>← {t.back}</button>
   <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
    <div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-bold">{c.title}</h2><Pill tone={statusTone[c.status]} dot>{t.status[c.status]}</Pill><Pill tone="accent">{t.kinds[c.kind]}</Pill></div>
    <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3">
     {[[t.reached,items.find(i=>i.id===c.id)?.reached??0],[t.answered,items.find(i=>i.id===c.id)?.answered??0],[t.dismissed,items.find(i=>i.id===c.id)?.dismissed??0],[c.kind==="nps"?t.nps:t.avg,c.kind==="nps"?(results.nps??"—"):(items.find(i=>i.id===c.id)?.average??"—")]].map(([k,v])=>
      <div key={String(k)} className="rounded-xl border border-[var(--stroke)] p-4"><div className="muted text-xs">{k}</div><div className="text-2xl font-bold tabular-nums">{String(v)}</div></div>)}
    </div>
    {range.length>0&&<><h3 className="font-bold mt-7 mb-3">{t.distribution} ({total})</h3>
     <div className="flex items-end gap-2 h-40">{range.map(s=>{const n=results.distribution.find(d=>d.score===s)?.n??0;const tone=c.kind==="nps"?(s>=9?"var(--success)":s>=7?"var(--warning)":"var(--danger)"):(s>=4?"var(--success)":s===3?"var(--warning)":"var(--danger)");
      return <div key={s} className="flex-1 flex flex-col items-center gap-1"><div className="text-xs tabular-nums muted">{n}</div><div className="w-full rounded-t-md" style={{height:`${Math.max(4,n/max*120)}px`,background:tone}}/><div className="text-xs font-semibold">{c.kind==="csat"?["😩","🙁","🤔","🙂","😄"][s-1]:s}</div></div>})}</div></>}
    {results.platforms.length>0&&<p className="muted text-sm mt-5">{t.byPlatform}: {results.platforms.map(p=>`${platformNames[p.platform]??p.platform} ${p.n}`).join(" · ")}</p>}
   </div>
   <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
    <h3 className="font-bold mb-3">{t.comments}</h3>
    {results.comments.length===0?<p className="muted text-sm">{t.noComments}</p>:<ul className="grid gap-3">{results.comments.map((r,i)=><li key={i} className="rounded-xl border border-[var(--stroke)] p-3">
     <div className="flex flex-wrap gap-2 text-xs muted"><span className="font-semibold">{r.email}</span>{r.score!==null&&<span>· {c.kind==="csat"?["😩","🙁","🤔","🙂","😄"][r.score-1]:r.score}</span>}<span>· {platformNames[r.platform]??r.platform}</span><span>· <When value={r.updated_at} locale={locale} empty=""/></span></div>
     <p className="mt-1 whitespace-pre-line">{r.comment}</p></li>)}</ul>}
   </div>
  </div>;
 }

 if(draft){
  const previewMessage:InAppMessage={id:"preview",kind:draft.kind,title:draft.title||t.heading,body:draft.body,ctaLabel:draft.ctaLabel||null,ctaUrl:draft.ctaUrl||null};
  const field=(label:string,node:React.ReactNode)=><label className="block"><span className="block text-sm font-semibold mb-1.5">{label}</span>{node}</label>;
  return <div className="grid lg:grid-cols-[1fr_340px] gap-6 max-w-5xl">
   <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6 grid gap-4">
    {field(t.kind,<select className={fieldClass} value={draft.kind} onChange={e=>setDraft({...draft,kind:e.target.value as Draft["kind"]})}>{(Object.keys(t.kinds) as Array<Draft["kind"]>).map(k=><option key={k} value={k}>{t.kinds[k]}</option>)}</select>)}
    {field(t.heading,<input maxLength={120} className={fieldClass} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/>)}
    {field(t.body,<textarea maxLength={600} rows={3} className={fieldClass} value={draft.body} onChange={e=>setDraft({...draft,body:e.target.value})}/>)}
    {(draft.kind==="announcement"||draft.kind==="tip")&&<div className="grid md:grid-cols-2 gap-4">
     {field(t.cta,<input maxLength={40} className={fieldClass} value={draft.ctaLabel} onChange={e=>setDraft({...draft,ctaLabel:e.target.value})}/>)}
     {field(t.ctaUrl,<input maxLength={500} className={fieldClass} placeholder="https://wecommander.app/…" value={draft.ctaUrl} onChange={e=>setDraft({...draft,ctaUrl:e.target.value})}/>)}
    </div>}
    <h3 className="font-bold mt-2">{t.audience}</h3>
    <div><span className="block text-sm font-semibold mb-1.5">{t.platforms}</span><div className="flex flex-wrap gap-3">{Object.keys(platformNames).map(p=><label key={p} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.platforms.includes(p)} onChange={e=>setDraft({...draft,platforms:e.target.checked?[...draft.platforms,p]:draft.platforms.filter(x=>x!==p)})}/>{platformNames[p]}</label>)}</div></div>
    {field(t.plans,<input className={fieldClass} placeholder="free, pro, team" value={draft.plans} onChange={e=>setDraft({...draft,plans:e.target.value})}/>)}
    <div className="grid md:grid-cols-2 gap-4">
     {field(t.minDays,<input type="number" min={0} className={fieldClass} value={draft.minDays} onChange={e=>setDraft({...draft,minDays:e.target.value})}/>)}
     {field(t.maxDays,<input type="number" min={0} className={fieldClass} value={draft.maxDays} onChange={e=>setDraft({...draft,maxDays:e.target.value})}/>)}
     {field(t.starts,<input type="datetime-local" className={fieldClass} value={draft.startsAt} onChange={e=>setDraft({...draft,startsAt:e.target.value})}/>)}
     {field(t.ends,<input type="datetime-local" className={fieldClass} value={draft.endsAt} onChange={e=>setDraft({...draft,endsAt:e.target.value})}/>)}
    </div>
    <div className="flex gap-3 mt-2"><button type="button" disabled={!draft.title.trim()} className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-5 py-2.5 font-bold disabled:opacity-50" onClick={()=>void save()}>{t.save}</button><button type="button" className={smallButton} onClick={()=>setDraft(null)}>{t.cancel}</button></div>
    <p className="text-sm" role="status">{message}</p>
   </div>
   <div><div className="text-sm font-semibold mb-2">{t.preview}</div><MessageCard message={previewMessage} onDone={()=>{}} preview/></div>
  </div>;
 }

 return <div className="grid gap-5 max-w-6xl">
  <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6">
   <div className="flex flex-wrap items-start gap-3"><div className="flex-1 min-w-[240px]"><h2 className="text-xl font-bold">{t.title}</h2><p className="muted text-sm mt-1">{t.intro}</p></div>
    <button type="button" className="rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-5 py-2.5 font-bold" onClick={()=>setDraft(emptyDraft())}>+ {t.new}</button></div>
   <div className="mt-4 flex flex-wrap gap-2 text-sm"><span className="muted">{t.templates}:</span>
    <button type="button" className={smallButton} onClick={()=>setDraft(emptyDraft("csat",t.tCsat))}>😄 {t.kinds.csat}</button>
    <button type="button" className={smallButton} onClick={()=>setDraft({...emptyDraft("nps",t.tNps),minDays:"14"})}>📈 {t.kinds.nps}</button>
   </div>
   {message&&<p className="text-sm mt-3" role="status">{message}</p>}
  </div>
  {items.length===0?<p className="muted text-sm">{t.none}</p>:<div className="grid gap-3">{items.map(c=><div key={c.id} className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-5">
   <div className="flex flex-wrap items-center gap-2"><div className="font-semibold flex-1 min-w-[200px]">{c.title}</div><Pill tone={statusTone[c.status]} dot>{t.status[c.status]}</Pill><Pill tone="accent">{t.kinds[c.kind]}</Pill></div>
   <div className="muted text-sm mt-2 flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
    <span>{t.reached}: {c.reached}</span><span>{t.answered}: {c.answered}</span><span>{t.dismissed}: {c.dismissed}</span>{(c.kind==="announcement"||c.kind==="tip")&&<span>{t.clicked}: {c.clicked}</span>}{c.average!==null&&<span>{t.avg}: {c.average}</span>}
    <span>{c.audience.platforms?.length?c.audience.platforms.map(p=>platformNames[p]??p).join(", "):"Windows, macOS, Linux, Web"}</span>
   </div>
   <div className="mt-3 flex flex-wrap gap-2">
    {c.status!=="active"&&<button type="button" className={smallButton} onClick={()=>void setStatus(c.id,"active")}>▶ {t.publish}</button>}
    {c.status==="active"&&<button type="button" className={smallButton} onClick={()=>void setStatus(c.id,"ended")}>■ {t.stop}</button>}
    <button type="button" className={smallButton} onClick={()=>void open(c.id)}>{t.results}</button>
    <button type="button" className={smallButton} onClick={()=>edit(c)}>{t.edit}</button>
    <button type="button" className={smallButton+" text-[var(--danger)]"} onClick={()=>void remove(c.id)}>{t.del}</button>
   </div>
  </div>)}</div>}
 </div>;
}
