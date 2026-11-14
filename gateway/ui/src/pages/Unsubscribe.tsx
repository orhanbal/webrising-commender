import {useState} from "react";
import {MailX} from "lucide-react";
import {api} from "../api";
import {useLocale} from "../i18n";

/** The page the unsubscribe link in marketing mail opens. Nothing changes until the button is pressed. */
const text={
 tr:{title:"E-posta aboneliği",body:"WECOMMANDER ürün haberleri ve kampanya e-postalarını artık almak istemiyor musun?",button:"Abonelikten çık",done:"Abonelikten çıktın. Artık pazarlama e-postası almayacaksın. Hesap ve güvenlik e-postaları gelmeye devam eder.",
  again:"Fikrini değiştirirsen hesap ayarlarından yeniden açabilirsin.",invalid:"Bu bağlantı geçersiz. E-postadaki bağlantıyı yeniden aç ya da hesap ayarlarından kapat.",failed:"Şu an işlem yapılamadı; biraz sonra tekrar dene."},
 en:{title:"Email subscription",body:"Don't want WECOMMANDER product news and offers by email anymore?",button:"Unsubscribe",done:"You are unsubscribed and won't receive marketing email anymore. Account and security emails still arrive.",
  again:"Changed your mind? Turn it back on in your account settings.",invalid:"This link is not valid. Open the link in the email again, or turn it off in your account settings.",failed:"That didn't work right now; please try again in a moment."},
};

export function UnsubscribePage(){
 const t=text[useLocale()];
 const params=new URLSearchParams(window.location.search);
 const query="u="+encodeURIComponent(params.get("u")??"")+"&t="+encodeURIComponent(params.get("t")??"");
 const [state,setState]=useState<"ready"|"busy"|"done"|"invalid"|"failed">(params.get("u")&&params.get("t")?"ready":"invalid");
 const go=async()=>{
  setState("busy");
  try{await api("/api/unsubscribe?"+query,{method:"POST",body:"{}"});setState("done")}
  catch(e){setState(String(e).includes("invalid unsubscribe link")?"invalid":"failed")}
 };
 return <main className="container-w py-20 grid place-items-center">
  <div className="w-full max-w-md rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-8 text-center">
   <div className="mx-auto size-12 rounded-xl bg-[var(--subtle-surface)] text-[var(--accent)] grid place-items-center"><MailX size={22}/></div>
   <h1 className="text-2xl font-bold mt-4">{t.title}</h1>
   {state==="done"?<><p className="mt-3">{t.done}</p><p className="muted text-sm mt-2">{t.again}</p></>:
    state==="invalid"?<p className="mt-3 text-[var(--danger)]">{t.invalid}</p>:
    <><p className="muted mt-3">{t.body}</p>
     <button type="button" disabled={state==="busy"} onClick={()=>void go()} className="mt-6 w-full rounded-xl bg-[var(--accent)] py-3 font-bold text-[var(--accent-ink)] disabled:opacity-60">{t.button}</button>
     {state==="failed"&&<p className="mt-3 text-sm text-[var(--danger)]" role="alert">{t.failed}</p>}</>}
  </div>
 </main>;
}
