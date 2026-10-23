import {useEffect,useState} from "react";
import {FileText,ShieldCheck} from "lucide-react";
import {api} from "../api";
import {useLocale} from "../i18n";

type LegalPageName="privacy"|"terms";
type PublishedLegal={id:string;page:LegalPageName;locale:string;title:string;body:string};

export function LegalPage({page}:{page:LegalPageName}){
 const locale=useLocale();
 const [published,setPublished]=useState<PublishedLegal|null>(null);
 const [loading,setLoading]=useState(true);
 useEffect(()=>{
  let active=true;setPublished(null);setLoading(true);
  api<{item:PublishedLegal|null}>("/api/public/legal?page="+page+"&locale="+locale)
   .then(result=>{if(active)setPublished(result.item)})
   .catch(()=>{if(active)setPublished(null)})
   .finally(()=>{if(active)setLoading(false)});
  return()=>{active=false};
 },[page,locale]);
 const privacy=page==="privacy";
 const title=published?.title||(locale==="tr"?(privacy?"Gizlilik Politikası":"Kullanım Koşulları"):(privacy?"Privacy Policy":"Terms of Service"));
 const placeholder=locale==="tr"?
   "Bu sayfanın tam hukuki metni henüz yayımlanmamıştır. Hesap oturumları HttpOnly çerezleri kullanır; kart ödemeleri Paddle tarafından işlenir. Hizmete ilişkin koşullar ve veri işleme taahhütleri için yayımlanacak resmi metin esas alınacaktır.":
   "The full legal policy has not yet been published. Account sessions use HttpOnly cookies and card payments are processed by Paddle. Refer to the published official policy for binding service and data-processing terms.";
 return <main className="container-w section-modern max-w-4xl mx-auto">
  <div className="flex items-center gap-3 text-[var(--accent)]">
   {privacy?<ShieldCheck size={26}/>:<FileText size={26}/>}
   <span className="text-xs tracking-widest font-bold uppercase">WECOMMANDER / {privacy?"Privacy":"Terms"}</span>
  </div>
  <h1 className="h2 mt-6">{title}</h1>
  {loading?<p className="muted mt-8">Loading…</p>:published?
   <article className="mt-8 rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-7 sm:p-10 space-y-5">
    {published.body.split(/\n\s*\n/).filter(Boolean).map((paragraph,index)=>
      <p key={index} className="text-base leading-8 whitespace-pre-wrap break-words">{paragraph}</p>)}
   </article>:
   <section className="mt-8 rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-7 sm:p-10">
    <p className="muted leading-8">{placeholder}</p>
    <p className="text-sm muted mt-5">{locale==="tr"?"Resmi metin henüz yayınlanmadı.":"The official legal text is not published yet."}</p>
   </section>}
 </main>;
}
