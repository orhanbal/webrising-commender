import {useEffect,useState} from "react";import type{FormEvent}from"react";
import { t as translate,useLocale } from "../i18n";
import{ArrowLeft,ArrowRight,Check,Eye,EyeOff,KeyRound,LockKeyhole,Monitor,ShieldCheck,Sparkles}from"lucide-react";
import{Button,Badge,Input}from"../components/ui";import{api,type Account,type Pricing}from"../api";import type{Nav}from"../App";import{NavLink}from"../App";
type Mode="/login"|"/register"|"/forgot-password"|"/reset-password"|"/verify";
export function AuthPage({path,nav,refresh,pricing,signupEnabled}:{path:string;nav:Nav;refresh:()=>Promise<Account|null>;pricing:Pricing|null;signupEnabled:boolean|null}){
 const language=useLocale();
 const mode=path as Mode;
 const [email,setEmail]=useState("");
 const [password,setPassword]=useState("");
 const [workspace,setWorkspace]=useState("");
 const [show,setShow]=useState(false);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState("");
 const [success,setSuccess]=useState("");
 const [token,setToken]=useState("");
 useEffect(()=>{setError("");setSuccess("");setPassword("");const fragment=new URLSearchParams(window.location.hash.slice(1));setToken(fragment.get(mode==="/verify"?"verify":"reset")||"")},[mode]);
 const titles:Record<Mode,string>={
  "/login":translate("Tekrar hoş geldiniz"),"/register":translate("Hesabınızı oluşturun"),
  "/forgot-password":translate("Şifrenizi sıfırlayın"),"/reset-password":translate("Yeni bir şifre belirleyin"),"/verify":translate("E-posta adresinizi doğrulayın")
 };
 const descriptions:Record<Mode,string>={
  "/login":translate("Cihazlarınıza ve çalışma alanınıza güvenle erişin."),
  "/register":translate("Kurulumu tamamlayarak yeni çalışma alanınızı oluşturun."),
  "/forgot-password":translate("Bağlantıyı gönderebilmemiz için kayıtlı e-postanızı yazın."),
  "/reset-password":translate("Güvenliğiniz için en az 12 karakterli yeni bir şifre belirleyin."),
  "/verify":translate("Doğrulama için kayıt sırasında kullandığınız şifreyi girin.")
 };
 async function submit(e:FormEvent){
  e.preventDefault();setError("");setSuccess("");setLoading(true);
  try{
   if(mode==="/login"){
    await api("/api/auth/login",{method:"POST",body:JSON.stringify({email,password})});
    await refresh();nav("/dashboard");return;
   }
   if(mode==="/register"){
    await api("/api/auth/signup",{method:"POST",body:JSON.stringify({email,password,workspaceName:workspace})});
    setSuccess(translate("Kayıt talebiniz alındı. E-postanıza gelen doğrulama bağlantısını açarak işlemi tamamlayın."));
    return;
   }
   if(mode==="/verify"){
    if(!token)throw new Error(translate("Doğrulama bağlantısı geçersiz; e-postanızdaki bağlantıyı tekrar açın."));
    await api("/api/auth/signup/verify",{method:"POST",body:JSON.stringify({token,password})});
    await refresh();
    const chosen=sessionStorage.getItem("wc-selected-plan");
    sessionStorage.removeItem("wc-selected-plan");
    nav(chosen?"/checkout?plan="+encodeURIComponent(chosen):"/dashboard");return;
   }
   if(mode==="/forgot-password"){
    await api("/api/auth/password-reset/request",{method:"POST",body:JSON.stringify({email})});
    setSuccess(translate("Bu e-posta için kayıtlı bir hesap varsa, şifre sıfırlama bağlantısı gönderildi."));return;
   }
   if(mode==="/reset-password"){
    if(!token)throw new Error(translate("Bağlantı geçersiz. Şifre sıfırlama e-postasındaki bağlantıyı açın."));
    await api("/api/auth/password-reset/confirm",{method:"POST",body:JSON.stringify({token,newPassword:password})});
    setSuccess(translate("Şifreniz değiştirildi. Yeni şifrenizle oturum açabilirsiniz."));return;
   }
  }catch(err){setError(err instanceof Error?err.message:translate("Bir hata oluştu."))}
  finally{setLoading(false)}
 }
 return <div className="auth-wrap"><aside className="auth-aside">
   <Badge><Sparkles size={14}/> {translate("Windows Fluent Workspace")}</Badge>
   <h2 className="mt-8">{translate("İşinize odaklanın.")}<br/><span className="text-gradient">{translate("Kontrol sizde olsun.")}</span></h2>
   <p>{translate("İster tek cihaz ister ekip çalışma alanı; WECOMMANDER ile tüm sistemlerinizi bir araya getirin.")}</p>
   <div className="auth-feature"><Monitor/> {translate("Tek uygulamadan cihazlarınızı yönetin")}</div>
   <div className="auth-feature"><ShieldCheck/> {translate("Güvenli kimlik doğrulama ve roller")}</div>
   <div className="auth-feature"><LockKeyhole/> {translate("Hassas işlemler için kullanıcı kontrolü")}</div>
   <div className="mt-16 border-t border-[var(--stroke)] pt-6 text-xs text-[var(--muted)]">{translate("WECOMMANDER · Güvenli Remote MCP")}</div>
  </aside>
  <div className="auth-panel"><div className="auth-card">
   <button type="button" className="inline-flex items-center gap-2 text-sm text-[var(--muted)] hover:text-[var(--text)] mb-9" onClick={()=>nav("/")}><ArrowLeft size={16}/> {translate("Ana sayfaya dön")}</button>
   <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-[var(--subtle-surface)] text-[var(--accent)]"><KeyRound size={23}/></div>
   <h1>{titles[mode]}</h1><p>{descriptions[mode]}</p>
   {mode==="/register"&&(pricing?.mode==="self_hosted"||signupEnabled===false)&&<div className="form-error mb-5">{translate("Bu kurulumda genel kayıt kapalıdır. Self-hosted yönetici hesabınızla giriş yapın.")}</div>}
   <form onSubmit={submit} className="form-stack" autoComplete="on">
    {["/login","/register","/forgot-password"].includes(mode)&&<label><span className="field-label">{translate("E-posta adresi")}</span><Input autoComplete="email" type="email" placeholder={translate("siz@ornek.com")} required maxLength={320} value={email} onChange={e=>setEmail(e.target.value)}/></label>}
    {mode==="/register"&&<label><span className="field-label">{translate("Çalışma alanı adı")}</span><Input placeholder={translate("Örn. Benim Çalışma Alanım")} autoComplete="organization" required minLength={2} maxLength={120} value={workspace} onChange={e=>setWorkspace(e.target.value)}/></label>}
    {!["/forgot-password"].includes(mode)&&<label><span className="flex items-center justify-between mb-2"><span className="field-label !mb-0">{mode==="/reset-password"?translate("Yeni şifre"):translate("Şifre")}</span>{mode==="/login"&&<NavLink nav={nav} to="/forgot-password" className="text-xs text-[var(--accent)] font-semibold">{translate("Şifremi unuttum")}</NavLink>}</span><span className="relative block"><Input placeholder="••••••••••••" type={show?"text":"password"} required minLength={mode==="/verify"?1:12} maxLength={256} autoComplete={mode==="/login"?"current-password":"new-password"} value={password} onChange={e=>setPassword(e.target.value)} className="pr-12"/><button type="button" onClick={()=>setShow(!show)} className="absolute top-2 right-3 size-7 grid place-items-center text-[var(--muted)]" aria-label={show?translate("Şifreyi gizle"):translate("Şifreyi göster")}>{show?<EyeOff size={17}/>:<Eye size={17}/>}</button></span>{mode==="/register"&&<small className="form-help">{translate("En az 12 karakter; güçlü bir parola kullanın.")}</small>}</label>}
    {error&&<div role="alert" className="form-error">{error}</div>}
    {success&&<div role="status" className="form-success">{success}</div>}
    <Button className="w-full" size="lg" type="submit" disabled={loading||(mode==="/register"&&(pricing?.mode==="self_hosted"||signupEnabled===false))}>{loading?"İşlem yapılıyor…":mode==="/login"?translate("Giriş Yap"):mode==="/register"?translate("Hesap Oluştur"):mode==="/forgot-password"?translate("Bağlantı Gönder"):mode==="/reset-password"?translate("Şifreyi Güncelle"):translate("Hesabı Doğrula")}<ArrowRight size={18}/></Button>
   </form>
   {mode==="/login"&&<p className="text-center text-sm text-[var(--muted)] mt-8">{translate("Henüz hesabınız yok mu?")} <NavLink to="/register" nav={nav} className="font-bold text-[var(--accent)]">{translate("Hesap oluşturun")}</NavLink></p>}
   {mode==="/register"&&<p className="text-center text-sm text-[var(--muted)] mt-8">{translate("Zaten hesabınız var mı?")} <NavLink to="/login" nav={nav} className="font-bold text-[var(--accent)]">{translate("Giriş yapın")}</NavLink></p>}
   {["/forgot-password","/reset-password","/verify"].includes(mode)&&<p className="text-center mt-8 text-sm"><NavLink to="/login" nav={nav} className="font-semibold text-[var(--accent)]">{translate("Giriş sayfasına dön")}</NavLink></p>}
   <div className="divider-text">{translate("Güvenli oturum")}</div><p className="text-xs leading-6 text-[var(--muted)] flex gap-2"><Check className="size-4 text-[var(--success)] shrink-0 mt-1"/>{translate("Oturumunuz HttpOnly çerez ile korunur. Şifreniz tarayıcıda saklanmaz.")}</p>
   <p className="text-xs mt-8 text-[var(--faint)]">{translate("Devam ederek")} <NavLink to="/terms" nav={nav} className="underline">{translate("kullanım koşullarını")}</NavLink> {translate("ve")} <NavLink to="/privacy" nav={nav} className="underline">{translate("gizlilik ilkelerini")}</NavLink>{language==="en"?".":" kabul etmiş olursunuz."}</p>
  </div></div>
 </div>;
}
