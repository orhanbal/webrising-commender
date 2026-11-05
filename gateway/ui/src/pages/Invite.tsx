import {useState} from "react";
import {UserPlus} from "lucide-react";
import {t as translate,useLocale} from "../i18n";
import {Alert,Button,Card,CardContent,CardDescription,CardHeader,CardTitle,Input,Spinner} from "../components/ui";
import type {Nav} from "../App";

// Invitation acceptance. Invitation e-mails link to /invite#token=…; links
// from before this page existed (/app#invite=…) are forwarded here by App.
// The token stays in the URL fragment, so it is never sent to the server in a
// request line or logged, and is removed from the address bar after use.
export function readInviteToken(){
 const hash=new URLSearchParams(location.hash.replace(/^#/,""));
 return hash.get("token")||hash.get("invite")||"";
}

export function InvitePage({nav,refresh}:{nav:Nav;refresh:()=>Promise<unknown>}){
 useLocale();
 const [token]=useState(readInviteToken);
 const [password,setPassword]=useState("");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const accept=async()=>{
  setBusy(true);setError("");
  try{
   const r=await fetch("/api/invitations/accept",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({token,password})});
   const body=await r.json().catch(()=>({}));
   if(!r.ok)throw new Error(body.error==="invalid_or_expired_invitation"?translate("Davet geçersiz, kullanılmış ya da süresi dolmuş."):body.error==="rate_limited"?translate("Çok fazla deneme yapıldı. Bir süre sonra tekrar deneyin."):translate("Davet kabul edilemedi. Mevcut bir hesabın varsa şifresini gir."));
   history.replaceState(null,"","/invite");
   await refresh();
   nav("/dashboard");
  }catch(e){setError((e as Error).message)}finally{setBusy(false)}
 };
 return <section className="container-w py-16 grid place-items-center"><Card className="w-full max-w-md"><CardHeader><CardTitle className="flex items-center gap-2"><UserPlus className="size-5 text-[var(--accent)]" aria-hidden="true"/>{translate("Daveti kabul et")}</CardTitle><CardDescription>{translate("Bu e-posta için hesabın yoksa yeni bir şifre belirle; varsa mevcut şifreni gir.")}</CardDescription></CardHeader><CardContent className="grid gap-4">
  {!token?<Alert tone="warning" title={translate("Davet bağlantısı eksik")}>{translate("E-postadaki bağlantıyı yeniden aç ya da yöneticinden yeni bir davet iste.")}</Alert>:<form className="grid gap-4" onSubmit={e=>{e.preventDefault();accept()}}>
   <label className="grid gap-1"><span className="text-sm font-semibold">{translate("Şifre (en az 12 karakter)")}</span><Input type="password" autoComplete="new-password" minLength={12} required value={password} onChange={e=>setPassword(e.target.value)}/></label>
   {error&&<Alert tone="danger">{error}</Alert>}
   <Button type="submit" disabled={busy||password.length<12}>{busy?<Spinner label={translate("Gönderiliyor…")}/>:translate("Katıl")}</Button>
  </form>}
 </CardContent></Card></section>;
}
