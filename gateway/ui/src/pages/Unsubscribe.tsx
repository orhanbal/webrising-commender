import {useState} from "react";
import {MailX} from "../components/icons";
import {api} from "../api";
import {useLocale} from "../i18n";

/** The page the unsubscribe link in marketing mail opens. Nothing changes until the button is pressed. */
const text={
 tr:{title:"E-posta aboneliği",body:"WECOMMANDER ürün haberleri ve kampanya e-postalarını artık almak istemiyor musun?",button:"Abonelikten çık",done:"Abonelikten çıktın. Artık pazarlama e-postası almayacaksın. Hesap ve güvenlik e-postaları gelmeye devam eder.",
  again:"Fikrini değiştirirsen hesap ayarlarından yeniden açabilirsin.",invalid:"Bu bağlantı geçersiz. E-postadaki bağlantıyı yeniden aç ya da hesap ayarlarından kapat.",failed:"Şu an işlem yapılamadı; biraz sonra tekrar dene."},
 en:{title:"Email subscription",body:"Don't want WECOMMANDER product news and offers by email anymore?",button:"Unsubscribe",done:"You are unsubscribed and won't receive marketing email anymore. Account and security emails still arrive.",
  again:"Changed your mind? Turn it back on in your account settings.",invalid:"This link is not valid. Open the link in the email again, or turn it off in your account settings.",failed:"That didn't work right now; please try again in a moment."},
 de:{title:"E-Mail-Abonnement",body:"Du möchtest keine Produktneuigkeiten und Angebote von WECOMMANDER mehr per E-Mail erhalten?",button:"Abmelden",done:"Du bist abgemeldet und erhältst keine Marketing-E-Mails mehr. Konto- und Sicherheits-E-Mails kommen weiterhin.",
  again:"Meinung geändert? Du kannst es in deinen Kontoeinstellungen wieder einschalten.",invalid:"Dieser Link ist ungültig. Öffne den Link in der E-Mail erneut oder schalte es in deinen Kontoeinstellungen aus.",failed:"Das hat gerade nicht geklappt; bitte versuche es gleich noch einmal."},
 "pt-BR":{title:"Assinatura de e-mail",body:"Não quer mais receber novidades e ofertas da WECOMMANDER por e-mail?",button:"Cancelar inscrição",done:"Sua inscrição foi cancelada e você não receberá mais e-mails de marketing. E-mails de conta e segurança continuam chegando.",
  again:"Mudou de ideia? Ative novamente nas configurações da sua conta.",invalid:"Este link não é válido. Abra o link do e-mail novamente ou desative nas configurações da sua conta.",failed:"Não foi possível agora; tente novamente em instantes."},
 es:{title:"Suscripción por correo",body:"¿Ya no quieres recibir noticias y ofertas de WECOMMANDER por correo?",button:"Darse de baja",done:"Te has dado de baja y ya no recibirás correos de marketing. Los correos de cuenta y seguridad seguirán llegando.",
  again:"¿Cambiaste de opinión? Vuelve a activarlo en la configuración de tu cuenta.",invalid:"Este enlace no es válido. Abre de nuevo el enlace del correo o desactívalo en la configuración de tu cuenta.",failed:"No se pudo hacer ahora; inténtalo de nuevo en un momento."},
 fr:{title:"Abonnement e-mail",body:"Vous ne souhaitez plus recevoir les nouveautés et offres de WECOMMANDER par e-mail ?",button:"Se désabonner",done:"Vous êtes désabonné et ne recevrez plus d'e-mails marketing. Les e-mails de compte et de sécurité continuent d'arriver.",
  again:"Vous avez changé d'avis ? Réactivez-le dans les paramètres de votre compte.",invalid:"Ce lien n'est pas valide. Rouvrez le lien de l'e-mail ou désactivez-le dans les paramètres de votre compte.",failed:"Cela n'a pas fonctionné pour le moment ; réessayez dans un instant."},
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
