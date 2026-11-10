import {useEffect,useState} from "react";
import {FileText,ReceiptText,ShieldCheck} from "lucide-react";
import {api} from "../api";
import {useLocale} from "../i18n";

type LegalPageName="privacy"|"terms"|"refund";
// Shown until a refund policy is published in the console (Legal CMS).
const REFUND_DEFAULT={
 tr:{title:"İade ve İptal Politikası",body:`Ödemeler, resmi satıcımız (Merchant of Record) Paddle.com tarafından işlenir. Faturalarınız ve iade talepleriniz Paddle üzerinden yönetilir.

İptal: Aboneliğinizi istediğiniz zaman Faturalandırma sayfasındaki "Paddle'da yönet" bağlantısından iptal edebilirsiniz. İptal, mevcut fatura döneminin sonunda geçerli olur; dönem sonuna kadar planınızı kullanmaya devam edersiniz ve sonraki dönem için ücret alınmaz.

İade: İlk ödemenizden itibaren 14 gün içinde, herhangi bir gerekçe göstermeden tam iade talep edebilirsiniz. Yenileme ödemelerinde, yenilemeden sonraki 14 gün içinde ve planı kullanmamış olmanız koşuluyla iade talep edebilirsiniz.

Talep: İade için siparişinizle gelen Paddle e-postasındaki bağlantıyı ya da paddle.net adresini kullanın veya bize Faturalandırma sayfası üzerinden ulaşın. Onaylanan iadeler, ödemenin yapıldığı karta bankanıza bağlı olarak genellikle 5–10 iş günü içinde yansır.

Ücretsiz plan hiçbir ödeme gerektirmez.`},
 en:{title:"Refund and Cancellation Policy",body:`Payments are processed by our reseller and Merchant of Record, Paddle.com. Your invoices and refund requests are handled by Paddle.

Cancellation: You can cancel your subscription at any time from the "Manage in Paddle" link on the Billing page. Cancellation takes effect at the end of the current billing period; you keep your plan until then and are not charged for the next period.

Refunds: You can request a full refund within 14 days of your first payment, for any reason. For renewal payments you can request a refund within 14 days of the renewal, provided the plan was not used in that period.

How to request: Use the link in the Paddle email you received with your order or visit paddle.net, or contact us from the Billing page. Approved refunds usually reach the card you paid with within 5–10 business days, depending on your bank.

The free plan requires no payment.`},
};
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
 const refund=page==="refund";
 const refundDefault=REFUND_DEFAULT[locale==="tr"?"tr":"en"];
 const shown=published??(refund?{id:"default",page,locale,title:refundDefault.title,body:refundDefault.body}:null);
 const title=shown?.title||(locale==="tr"?(privacy?"Gizlilik Politikası":"Kullanım Koşulları"):(privacy?"Privacy Policy":"Terms of Service"));
 const placeholder=locale==="tr"?
   "Bu sayfanın tam hukuki metni henüz yayımlanmamıştır. Hesap oturumları HttpOnly çerezleri kullanır; kart ödemeleri Paddle tarafından işlenir. Hizmete ilişkin koşullar ve veri işleme taahhütleri için yayımlanacak resmi metin esas alınacaktır.":
   "The full legal policy has not yet been published. Account sessions use HttpOnly cookies and card payments are processed by Paddle. Refer to the published official policy for binding service and data-processing terms.";
 return <article className="container-w section-modern max-w-4xl mx-auto">
  <div className="flex items-center gap-3 text-[var(--accent)]">
   {privacy?<ShieldCheck size={26}/>:refund?<ReceiptText size={26}/>:<FileText size={26}/>}
   <span className="text-xs tracking-widest font-bold uppercase">WECOMMANDER / {privacy?"Privacy":refund?"Refunds":"Terms"}</span>
  </div>
  <h1 className="h2 mt-6">{title}</h1>
  {loading?<p className="muted mt-8">Loading…</p>:shown?
   <article className="mt-8 rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-7 sm:p-10 space-y-5">
    {shown.body.split(/\n\s*\n/).filter(Boolean).map((paragraph,index)=>
      <p key={index} className="text-base leading-8 whitespace-pre-wrap break-words">{paragraph}</p>)}
   </article>:
   <section className="mt-8 rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-7 sm:p-10">
    <p className="muted leading-8">{placeholder}</p>
    <p className="text-sm muted mt-5">{locale==="tr"?"Resmi metin henüz yayınlanmadı.":"The official legal text is not published yet."}</p>
   </section>}
 </article>;
}
