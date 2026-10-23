import{useEffect,useState}from"react";
import { t as translate,useLocale } from "../i18n";
import{ArrowRight,CheckCircle2,KeyRound,LockKeyhole,Plus,ShieldCheck,Users}from"lucide-react";
import{api,type Account}from"../api";
import{Badge,Button,Card,CardContent,CardDescription,CardHeader,CardTitle,Input}from"../components/ui";
import{DashboardShell}from"./Dashboard";import type{Nav,Theme}from"../App";
type Workspace={id:string;name:string;role:string};
export function AccountPage({nav,account,checking,refresh,logout,theme,toggle}:{nav:Nav;account:Account|null;checking:boolean;refresh:()=>Promise<Account|null>;logout:()=>void;theme:Theme;toggle:()=>void}){
 useLocale();
 const [spaces,setSpaces]=useState<Workspace[]>([]);
 const [current,setCurrent]=useState<Workspace|null>(null);
 const [oldPassword,setOldPassword]=useState("");
 const [newPassword,setNewPassword]=useState("");
 const [name,setName]=useState("");
 const [newSpace,setNewSpace]=useState("");
 const [error,setError]=useState("");
 const [success,setSuccess]=useState("");
 const [busy,setBusy]=useState(false);
 const isOwner=account?.role==="owner";
 async function load(){
  if(!account)return;
  const [groups,org]=await Promise.allSettled([
   api<{items:Workspace[]}>("/api/auth/organizations"),
   api<{item:Workspace}>("/api/organization")
  ]);
  if(groups.status==="fulfilled")setSpaces(groups.value.items);
  if(org.status==="fulfilled"){setCurrent(org.value.item);setName(org.value.item.name)}
 }
 useEffect(()=>{void load()},[account?.organizationId]);
 async function mutate(op:()=>Promise<void>){
  setBusy(true);setError("");setSuccess("");
  try{await op()}catch(e){setError(e instanceof Error?e.message:translate("İşlem gerçekleştirilemedi."))}
  finally{setBusy(false)}
 }
 const changePassword=()=>mutate(async()=>{
  if(oldPassword.length<12||newPassword.length<12)throw Error(translate("Şifre en az 12 karakter olmalıdır."));
  await api("/api/auth/change-password",{method:"POST",body:JSON.stringify({currentPassword:oldPassword,newPassword})});
  setOldPassword("");setNewPassword("");setSuccess(translate("Şifreniz değiştirildi. Diğer oturumlar kapatıldı."));
 });
 const switchWorkspace=(organizationId:string)=>mutate(async()=>{
  await api("/api/auth/switch-organization",{method:"POST",body:JSON.stringify({organizationId})});
  await refresh();window.location.reload();
 });
 const createWorkspace=()=>mutate(async()=>{
  await api("/api/auth/organizations",{method:"POST",body:JSON.stringify({name:newSpace.trim()})});
  await refresh();window.location.reload();
 });
 const rename=()=>mutate(async()=>{
  const r=await api<{item:Workspace}>("/api/organization",{method:"PATCH",body:JSON.stringify({name:name.trim()})});
  setCurrent(r.item);setSuccess(translate("Çalışma alanı adı güncellendi."));await load();
 });
 return <DashboardShell nav={nav}path="/account"account={account}theme={theme}toggle={toggle}logout={logout}>
  <span className="dash-kicker">{translate("HESAP & GÜVENLİK")}</span><h1 className="dash-title mt-2">{translate("Hesap Ayarları")}</h1><p className="muted mt-2 text-sm">{translate("Hesabınızı, çalışma alanlarınızı ve erişiminizi yönetin.")}</p>
  {error&&<div className="form-error mt-5"role="alert">{error}</div>}
  {success&&<div className="form-success mt-5"role="status">{success}</div>}
  {!account&&!checking?<Card className="p-6 mt-6"><p className="font-semibold">{translate("Hesap bilgilerini görmek için giriş yapın.")}</p><Button className="mt-4" onClick={()=>nav("/login")}>{translate("Giriş Yap")} <ArrowRight size={16}/></Button></Card>:
  <div className="grid lg:grid-cols-2 gap-5 mt-7"><div className="grid gap-5 content-start">
   <Card><CardHeader><CardTitle>{translate("Profil Bilgileri")}</CardTitle><CardDescription>{translate("Mevcut güvenli oturumunuz")}</CardDescription></CardHeader><CardContent><div className="flex gap-4 items-center"><div className="size-13 rounded-xl bg-[var(--subtle-surface)] text-[var(--accent)] grid place-items-center text-lg font-extrabold">{account?.email?.slice(0,2).toUpperCase()||"WC"}</div><div><h3 className="font-bold">{account?.email||"—"}</h3><p className="muted text-sm">{account?.role||"—"} rolü</p></div></div><p className="muted text-xs mt-6 flex gap-2 items-center"><ShieldCheck size={16}/> {translate("HttpOnly oturum çerezleri ve CSRF koruması")}</p></CardContent></Card>
   <Card><CardHeader><CardTitle>{translate("Şifremi Değiştir")}</CardTitle><CardDescription>{translate("Diğer açık oturumlar yeni şifrenizle kapatılır.")}</CardDescription></CardHeader><CardContent><form className="grid gap-4" onSubmit={e=>{e.preventDefault();void changePassword()}}><label className="field-label">{translate("Mevcut şifre")}<Input className="mt-2" type="password" autoComplete="current-password" value={oldPassword} onChange={e=>setOldPassword(e.target.value)} minLength={12} required/></label><label className="field-label">{translate("Yeni şifre")}<Input className="mt-2" type="password" autoComplete="new-password" value={newPassword} onChange={e=>setNewPassword(e.target.value)} minLength={12} required/></label><Button type="submit" disabled={busy||account?.authKind!=="session"}><LockKeyhole size={16}/> {translate("Şifreyi Güncelle")}</Button></form></CardContent></Card>
  </div><div className="grid gap-5 content-start">
   <Card><CardHeader><CardTitle>{translate("Çalışma Alanlarım")}</CardTitle><CardDescription>{translate("Organizasyonlarınız ve hesap rolleriniz")}</CardDescription></CardHeader><CardContent><div className="grid gap-2">{spaces.map(org=><div key={org.id} className="flex gap-3 items-center p-3 bg-[var(--subtle-surface)] border border-[var(--stroke)] rounded-xl"><div className="size-9 grid place-items-center bg-[var(--surface)] rounded-lg text-[var(--accent)]"><Users size={17}/></div><div className="flex-1 min-w-0"><strong className="text-sm block truncate">{org.name}</strong><small className="muted">{org.role}</small></div>{org.id===account?.organizationId?<Badge><CheckCircle2 size={12}/> {translate("Aktif")}</Badge>:<Button variant="outline" size="sm" onClick={()=>void switchWorkspace(org.id)} disabled={busy}>{translate("Geç")}</Button>}</div>)}{spaces.length===0&&<p className="muted text-sm py-3">{translate("Ek çalışma alanı bulunamadı.")}</p>}</div><div className="mt-5 border-t border-[var(--stroke)] pt-5"><label className="field-label">{translate("Yeni çalışma alanı")}</label><div className="flex gap-2"><Input placeholder="Ad" value={newSpace} onChange={e=>setNewSpace(e.target.value)} maxLength={120}/><Button size="icon" aria-label="Yeni çalışma alanı ekle" disabled={busy||newSpace.trim().length<2} onClick={()=>void createWorkspace()}><Plus size={18}/></Button></div></div></CardContent></Card>
   <Card><CardHeader><CardTitle>{translate("Aktif Çalışma Alanı")}</CardTitle><CardDescription>{translate("Sadece çalışma alanı sahibi adını değiştirebilir.")}</CardDescription></CardHeader><CardContent><label className="field-label">Ad<Input className="mt-2" value={name} onChange={e=>setName(e.target.value)} maxLength={120} disabled={!isOwner}/></label><small className="muted block mt-3 break-all">{translate("Kimlik:")} {current?.id||account?.organizationId||"—"}</small><Button className="mt-5 w-full" disabled={busy||!isOwner||name.trim().length<2} onClick={()=>void rename()}><KeyRound size={16}/> {translate("Değişiklikleri Kaydet")}</Button></CardContent></Card>
  </div></div>}
 </DashboardShell>;
}
