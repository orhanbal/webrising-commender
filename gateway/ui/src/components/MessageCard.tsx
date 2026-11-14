import {useEffect,useState} from "react";
import {X} from "lucide-react";
import {api} from "../api";
import {useLocale} from "../i18n";

/** A marketing message or survey as people see it (bottom left, like an app survey). */
export type InAppMessage={id:string;kind:"csat"|"nps"|"announcement"|"tip";title:string;body:string;ctaLabel:string|null;ctaUrl:string|null};

const faces=["😩","🙁","🤔","🙂","😄"];
const text={
 tr:{thanks:"Teşekkürler!",note:"Eklemek istediğin bir şey var mı? (isteğe bağlı)",send:"Gönder",close:"Kapat",low:"Hiç olası değil",high:"Çok olası"},
 en:{thanks:"Thank you!",note:"Anything you'd like to add? (optional)",send:"Send",close:"Close",low:"Not likely",high:"Very likely"},
};

export function MessageCard({message,onDone,preview=false}:{message:InAppMessage;onDone:()=>void;preview?:boolean}){
 const t=text[useLocale()];
 const [score,setScore]=useState<number|null>(null);
 const [comment,setComment]=useState("");
 const [sent,setSent]=useState(false);
 const respond=async(action:"answered"|"dismissed"|"clicked",value:number|null=null)=>{
  if(preview)return;
  try{await api("/api/messages/respond",{method:"POST",body:JSON.stringify({id:message.id,platform:"web",action,score:value,comment:action==="answered"&&comment.trim()?comment.trim():null})})}catch{/* a lost answer is not worth an error */}
 };
 const finish=async()=>{await respond("answered",score);setSent(true);setTimeout(onDone,1400)};
 const survey=message.kind==="csat"||message.kind==="nps";
 return <div role="dialog" aria-label={message.title} className="w-[320px] max-w-[calc(100vw-32px)] rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] shadow-2xl p-4 text-sm">
  <div className="flex items-start gap-2">
   <div className="font-semibold flex-1">{message.kind==="tip"?"💡 ":message.kind==="announcement"?"📣 ":"👋 "}{message.title}</div>
   <button type="button" aria-label={t.close} className="muted hover:opacity-80" onClick={()=>{void respond("dismissed");onDone()}}><X size={16}/></button>
  </div>
  {message.body&&<p className="muted mt-2 whitespace-pre-line">{message.body}</p>}
  {sent?<p className="mt-3 font-semibold">{t.thanks}</p>:survey?<>
   {message.kind==="csat"?<div className="mt-3 flex justify-between rounded-xl border border-[var(--stroke)] px-3 py-2">
    {faces.map((f,i)=><button key={f} type="button" aria-label={String(i+1)} onClick={()=>setScore(i+1)} className={"text-2xl transition-transform hover:scale-125 "+(score===i+1?"scale-125":"opacity-80")}>{f}</button>)}
   </div>:<div className="mt-3">
    <div className="grid grid-cols-11 gap-1">{Array.from({length:11},(_,i)=><button key={i} type="button" onClick={()=>setScore(i)} className={"rounded-md border border-[var(--stroke)] py-1 text-xs font-semibold "+(score===i?"bg-[var(--accent)] text-[var(--accent-ink)]":"")}>{i}</button>)}</div>
    <div className="muted mt-1 flex justify-between text-xs"><span>{t.low}</span><span>{t.high}</span></div>
   </div>}
   {score!==null&&<>
    <textarea maxLength={1000} rows={2} value={comment} onChange={e=>setComment(e.target.value)} placeholder={t.note} className="mt-3 w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-2"/>
    <button type="button" onClick={()=>void finish()} className="mt-2 w-full rounded-xl bg-[var(--accent)] py-2 font-semibold text-[var(--accent-ink)]">{t.send}</button>
   </>}
  </>:message.ctaUrl&&message.ctaLabel&&<a href={message.ctaUrl} target="_blank" rel="noopener noreferrer" onClick={()=>{void respond("clicked");onDone()}} className="mt-3 inline-block rounded-xl bg-[var(--accent)] px-4 py-2 font-semibold text-[var(--accent-ink)]">{message.ctaLabel}</a>}
 </div>;
}

/** Fetches the person's next message once per page load and shows it bottom left. */
export function InAppMessages(){
 const [message,setMessage]=useState<InAppMessage|null>(null);
 useEffect(()=>{
  let active=true;
  const timer=setTimeout(()=>{
   void api<{message:InAppMessage|null}>("/api/messages?platform=web").then(r=>{
    if(!active||!r.message)return;
    setMessage(r.message);
    void api("/api/messages/respond",{method:"POST",body:JSON.stringify({id:r.message.id,platform:"web",action:"shown"})}).catch(()=>{});
   }).catch(()=>{});
  },4000);
  return()=>{active=false;clearTimeout(timer)};
 },[]);
 if(!message)return null;
 return <div className="fixed bottom-4 left-4 z-50"><MessageCard message={message} onDone={()=>setMessage(null)}/></div>;
}
