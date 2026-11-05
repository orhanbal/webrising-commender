import {useCallback,useEffect,useState} from "react";
import {Copy,Globe2,MailPlus,Trash2,UserMinus,Users} from "lucide-react";
import {t as translate,useLocale,localizedDate} from "../i18n";
import {api,type Account} from "../api";
import {Alert,Badge,Button,Card,CardContent,CardDescription,CardHeader,CardTitle,Dialog,DialogContent,DialogDescription,DialogTitle,EmptyState,Input,PageHeader,Skeleton,Spinner} from "../components/ui";
import {DashboardShell} from "./Dashboard";
import type {Nav,Theme} from "../App";

// Team and workspace settings (v1.1 item 5e): members, invitations and the
// relay region, moved from the legacy /advanced console. Same REST routes,
// same server-side role checks (admin for members and invitations, owner and
// a browser session for the relay region).
type Role="viewer"|"operator"|"admin"|"owner";
type Member={id:string;email:string;role:Role;last_login_at?:string|null;member_since?:string|null;disabled_at?:string|null};
type Invitation={id:string;email:string;role:Role;status:"pending"|"accepted"|"revoked"|"expired";expires_at:string;created_at:string};
const roles:Role[]=["viewer","operator","admin","owner"];
const roleText:Record<Role,string>={viewer:"İzleyici",operator:"Operatör",admin:"Yönetici",owner:"Sahip"};
const roleHelp:Record<Role,string>={viewer:"Yalnızca görüntüler.",operator:"Cihazlarda araç çalıştırır; yüksek riskli işlemler onay ister.",admin:"Onay verir, üyeleri ve cihaz politikalarını yönetir.",owner:"Tüm yetkiler, faturalama ve bölge seçimi."};

export function TeamPage({nav,account,checking,theme,toggle,logout}:{nav:Nav;account:Account|null;checking:boolean;theme:Theme;toggle:()=>void;logout:()=>void}){
 useLocale();
 const [members,setMembers]=useState<Member[]|null>(null);
 const [invites,setInvites]=useState<Invitation[]|null>(null);
 const [forbidden,setForbidden]=useState(false);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const [email,setEmail]=useState("");
 const [role,setRole]=useState<Role>("operator");
 const [inviteUrl,setInviteUrl]=useState("");
 const [busy,setBusy]=useState(false);
 const [removing,setRemoving]=useState<Member|null>(null);
 const load=useCallback(async()=>{
  try{const [m,i]=await Promise.all([api<{items:Member[]}>("/api/members"),api<{items:Invitation[]}>("/api/invitations")]);setMembers(m.items);setInvites(i.items);setForbidden(false)}
  catch(e){const message=(e as Error).message;if(/forbidden/i.test(message)){setForbidden(true);setMembers([]);setInvites([])}else setError(message)}
 },[]);
 useEffect(()=>{if(account)load()},[account,load]);
 if(!checking&&!account){nav("/login");return null}
 const invite=async()=>{setBusy(true);setError("");setInviteUrl("");
  try{const r=await api<{inviteUrl:string}>("/api/invitations",{method:"POST",body:JSON.stringify({email:email.trim(),role,ttlHours:72})});setInviteUrl(r.inviteUrl);setEmail("");setNotice(translate("Davet oluşturuldu. Bağlantıyı davet ettiğin kişiyle paylaş; 72 saat geçerli."));await load()}
  catch(e){setError((e as Error).message)}finally{setBusy(false)}};
 const changeRole=async(member:Member,next:Role)=>{setError("");try{await api("/api/members/"+member.id,{method:"PATCH",body:JSON.stringify({role:next})});setNotice(member.email+": "+translate(roleText[next]));await load()}catch(e){setError((e as Error).message);await load()}};
 const remove=async()=>{if(!removing)return;setBusy(true);try{await api("/api/members/"+removing.id,{method:"DELETE"});setNotice(removing.email+" "+translate("çalışma alanından çıkarıldı."));setRemoving(null);await load()}catch(e){setError((e as Error).message);setRemoving(null)}finally{setBusy(false)}};
 const revoke=async(item:Invitation)=>{setError("");try{await api("/api/invitations/"+item.id+"/revoke",{method:"POST",body:"{}"});await load()}catch(e){setError((e as Error).message)}};
 const copy=async(text:string)=>{try{await navigator.clipboard.writeText(text);setNotice(translate("Kopyalandı"))}catch{/* clipboard blocked */}};
 return <DashboardShell nav={nav} path="/team" account={account} theme={theme} toggle={toggle} logout={logout}>
  <PageHeader kicker={translate("ÇALIŞMA ALANI")} title={translate("Ekip")} description={translate("Üyeleri ve rollerini yönet, yeni kişileri davet et ve çalışma alanının bölgesini seç.")}/>
  <div className="grid gap-5 mt-8">
   {notice&&<Alert tone="success">{notice}</Alert>}
   {error&&<Alert tone="danger" title={translate("İşlem tamamlanamadı")}>{error}</Alert>}
   {forbidden?<Alert tone="info" title={translate("Yönetici yetkisi gerekiyor")}>{translate("Üyeleri ve davetleri yalnızca çalışma alanı sahipleri ve yöneticileri yönetebilir.")}</Alert>:<>
   <Card><CardHeader><CardTitle className="flex items-center gap-2"><MailPlus className="size-5 text-[var(--accent)]" aria-hidden="true"/>{translate("Davet et")}</CardTitle><CardDescription>{translate("Davet bağlantısını oluştur ve kişiyle paylaş. Kişi bağlantıyla hesap oluşturur ya da mevcut hesabıyla katılır.")}</CardDescription></CardHeader><CardContent>
    <form className="grid gap-3 sm:grid-cols-[1fr_200px_auto] items-end" onSubmit={e=>{e.preventDefault();invite()}}>
     <label className="grid gap-1"><span className="text-sm font-semibold">{translate("E-posta")}</span><Input type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder={translate("siz@ornek.com")}/></label>
     <label className="grid gap-1"><span className="text-sm font-semibold">{translate("Rol")}</span><select className="h-11 rounded-xl border border-[var(--stroke)] bg-[var(--input)] px-3 text-sm" value={role} onChange={e=>setRole(e.target.value as Role)}>{roles.map(r=><option key={r} value={r}>{translate(roleText[r])}</option>)}</select></label>
     <Button type="submit" disabled={busy||!email.trim()}>{busy?<Spinner label={translate("Gönderiliyor…")}/>:translate("Davet oluştur")}</Button>
    </form>
    <p className="text-xs muted mt-2">{translate(roleHelp[role])}</p>
    {inviteUrl&&<div className="mt-4 flex gap-2 items-center"><code className="approval-op flex-1 !mt-0">{inviteUrl}</code><Button variant="outline" size="icon" aria-label={translate("Bağlantıyı kopyala")} onClick={()=>copy(inviteUrl)}><Copy className="size-4"/></Button></div>}
   </CardContent></Card>
   <Card><CardHeader><CardTitle className="flex items-center gap-2"><Users className="size-5 text-[var(--accent)]" aria-hidden="true"/>{translate("Üyeler")}{members&&<Badge className="ml-1">{members.length}</Badge>}</CardTitle></CardHeader><CardContent>
    {members===null?<div className="grid gap-2" aria-busy="true"><Skeleton className="h-12"/><Skeleton className="h-12"/></div>
    :<ul className="grid gap-2">{members.map(member=><li key={member.id} className="team-row"><div className="min-w-0 flex-1"><p className="font-semibold truncate">{member.email}{member.email===account?.email&&<span className="muted font-normal"> · {translate("sen")}</span>}</p><p className="text-xs muted">{translate("Son giriş")}: {member.last_login_at?localizedDate(member.last_login_at,{dateStyle:"short",timeStyle:"short"}):"—"} · {translate("Üyelik")}: {localizedDate(member.member_since,{dateStyle:"short"})}</p></div>
     <select aria-label={translate("Rol")+": "+member.email} className="h-10 rounded-xl border border-[var(--stroke)] bg-[var(--input)] px-3 text-sm" value={member.role} onChange={e=>changeRole(member,e.target.value as Role)}>{roles.map(r=><option key={r} value={r}>{translate(roleText[r])}</option>)}</select>
     <Button size="sm" variant="ghost" aria-label={translate("Çıkar")+": "+member.email} onClick={()=>setRemoving(member)}><UserMinus className="size-4"/></Button></li>)}</ul>}
   </CardContent></Card>
   <Card><CardHeader><CardTitle>{translate("Davetler")}</CardTitle></CardHeader><CardContent>
    {invites===null?<Skeleton className="h-12"/>:invites.length===0?<EmptyState icon={MailPlus} title={translate("Henüz davet yok")}/>
    :<ul className="grid gap-2">{invites.map(item=><li key={item.id} className="team-row"><div className="min-w-0 flex-1"><p className="font-semibold truncate">{item.email}</p><p className="text-xs muted">{translate(roleText[item.role])} · {translate("Bitiş")}: {localizedDate(item.expires_at,{dateStyle:"short",timeStyle:"short"})}</p></div><Badge className={item.status==="pending"?"text-[var(--accent)]":item.status==="accepted"?"text-[var(--success)]":""}>{translate(item.status==="pending"?"Bekliyor":item.status==="accepted"?"Kabul edildi":item.status==="revoked"?"İptal edildi":"Süresi doldu")}</Badge>{item.status==="pending"&&<Button size="sm" variant="ghost" aria-label={translate("Daveti iptal et")+": "+item.email} onClick={()=>revoke(item)}><Trash2 className="size-4"/></Button>}</li>)}</ul>}
   </CardContent></Card>
   </>}
   {account?.role==="owner"&&<RelayRegion onError={setError} onSaved={setNotice}/>}
  </div>
  <Dialog open={!!removing} onOpenChange={open=>{if(!open&&!busy)setRemoving(null)}}><DialogContent>{removing&&<>
   <DialogTitle className="text-xl font-bold">{translate("Üyeyi çıkar?")}</DialogTitle>
   <DialogDescription className="text-sm muted mt-2">{removing.email} {translate("bu çalışma alanına erişimini kaybeder. Hesabı silinmez.")}</DialogDescription>
   <div className="flex justify-end gap-2 mt-6"><Button variant="outline" onClick={()=>setRemoving(null)} disabled={busy}>{translate("Vazgeç")}</Button><Button variant="danger" onClick={remove} disabled={busy}>{translate("Çıkar")}</Button></div>
  </>}</DialogContent></Dialog>
 </DashboardShell>;
}

function RelayRegion({onError,onSaved}:{onError:(m:string)=>void;onSaved:(m:string)=>void}){
 const [regions,setRegions]=useState<{enabled:boolean;items:Array<{region:string;nodes:number}>}|null>(null);
 const [value,setValue]=useState("");
 useEffect(()=>{Promise.all([api<{item:{relay_region?:string|null}}>("/api/organization"),api<{enabled:boolean;items:Array<{region:string;nodes:number}>}>("/api/relay-regions")]).then(([org,r])=>{setRegions(r);setValue(org.item.relay_region||"")}).catch(()=>setRegions({enabled:false,items:[]}))},[]);
 if(!regions?.enabled)return null;
 const save=async()=>{try{await api("/api/organization/relay-region",{method:"PATCH",body:JSON.stringify({region:value||null})});onSaved(translate("Bölge kaydedildi. Cihazlar bir sonraki bağlantıda yeni bölgeye geçer."))}catch(e){onError((e as Error).message)}};
 return <Card><CardHeader><CardTitle className="flex items-center gap-2"><Globe2 className="size-5 text-[var(--accent)]" aria-hidden="true"/>{translate("Bölge")}</CardTitle><CardDescription>{translate("Cihazlarının bağlanacağı bölgesel aktarım noktasını seç. Otomatik, en uygun sağlıklı bölgeyi kullanır.")}</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-3 items-end">
  <select aria-label={translate("Bölge")} className="h-11 min-w-[220px] rounded-xl border border-[var(--stroke)] bg-[var(--input)] px-3 text-sm" value={value} onChange={e=>setValue(e.target.value)}><option value="">{translate("Otomatik")}</option>{regions.items.map(r=><option key={r.region} value={r.region}>{r.region} · {r.nodes}</option>)}</select>
  <Button variant="outline" onClick={save}>{translate("Kaydet")}</Button>
 </CardContent></Card>;
}
