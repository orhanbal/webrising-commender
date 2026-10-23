import {useEffect,useMemo,useState} from "react";
import {Activity,ArrowRight,Check,Clock3,Copy,HardDrive,Info,Monitor,MoreHorizontal,Plus,RefreshCw,Search,Server,ShieldCheck,TerminalSquare,Wifi,WifiOff} from "lucide-react";
import {api,type Account,type Device} from "../api";
import {Badge,Button,Card,CardContent,CardHeader,CardTitle,Dialog,DialogContent,DialogDescription,DialogTitle,Input} from "../components/ui";
import {dateText} from "../lib";
import {DashboardShell} from "./Dashboard";
import type {Nav,Theme} from "../App";

type ManagedDevice=Device&{revoked_at?:string|null;agent_version?:string|null;capabilities?:string[]|null};
export function DevicesPage({nav,account,checking,theme,toggle,logout}:{nav:Nav;account:Account|null;checking:boolean;theme:Theme;toggle:()=>void;logout:()=>void}){
 const [devices,setDevices]=useState<ManagedDevice[]>([]);
 const [loading,setLoading]=useState(false);
 const [filter,setFilter]=useState("");
 const [showRevoked,setShowRevoked]=useState(false);
 const [error,setError]=useState("");
 const [info,setInfo]=useState("");
 const [pairOpen,setPairOpen]=useState(false);
 const [pairCode,setPairCode]=useState("");
 const [expiresAt,setExpiresAt]=useState<number|null>(null);
 const [pairBusy,setPairBusy]=useState(false);
 const [selected,setSelected]=useState<ManagedDevice|null>(null);
 const [name,setName]=useState("");
 const [busy,setBusy]=useState(false);
 const canOperator=["operator","admin","owner"].includes(account?.role||"")||account?.actor?.startsWith("global:")===true;
 const canAdmin=["admin","owner"].includes(account?.role||"")||account?.actor?.startsWith("global:")===true;
 async function load(){
  if(!account)return;
  setLoading(true);setError("");
  try{const data=await api<{items:ManagedDevice[]}>("/api/devices");setDevices(data.items)}
  catch(e){setError(e instanceof Error?e.message:"Cihazlar yüklenemedi.")}
  finally{setLoading(false)}
 }
 useEffect(()=>{void load();const timer=setInterval(()=>void load(),30000);return()=>clearInterval(timer)},[account?.organizationId]);
 const filtered=useMemo(()=>devices.filter(d=>(showRevoked||!d.revoked_at)&&[d.name,d.hostname,d.platform,d.id].some(x=>String(x||"").toLocaleLowerCase("tr").includes(filter.toLocaleLowerCase("tr")))),[devices,filter,showRevoked]);
 const active=devices.filter(d=>!d.revoked_at);
 async function pair(){
  setError("");setPairBusy(true);
  try{
   const data=await api<{pairingCode:string;expiresInSeconds:number}>("/api/pairing",{method:"POST",body:"{}"});
   setPairCode(data.pairingCode);setExpiresAt(Date.now()+data.expiresInSeconds*1000);setPairOpen(true);
  }catch(e){setError(e instanceof Error?e.message:"Eşleştirme kodu oluşturulamadı.")}
  finally{setPairBusy(false)}
 }
 async function copyCode(){
  try{await navigator.clipboard.writeText(pairCode);setInfo("Eşleştirme kodu kopyalandı.")}
  catch{setInfo("Kod kopyalanamadı; lütfen manuel kopyalayın.")}
 }
 async function rename(){
  if(!selected||!name.trim()||!canAdmin)return;
  setBusy(true);setError("");
  try{
   await api("/api/devices/"+encodeURIComponent(selected.id),{method:"PATCH",body:JSON.stringify({name:name.trim()})});
   setInfo("Cihaz adı güncellendi.");setSelected(null);await load();
  }catch(e){setError(e instanceof Error?e.message:"İşlem başarısız.")}
  finally{setBusy(false)}
 }
 async function disconnect(device:ManagedDevice){
  if(!canOperator||!confirm(device.name+" cihazının bağlantısı kesilsin mi?"))return;
  setBusy(true);setError("");
  try{await api("/api/devices/"+encodeURIComponent(device.id)+"/disconnect",{method:"POST",body:"{}"});setInfo("Cihazın bağlantısı kesildi.");await load()}
  catch(e){setError(e instanceof Error?e.message:"Bağlantı kesilemedi.")}
  finally{setBusy(false)}
 }
 async function revoke(device:ManagedDevice){
  if(!canAdmin||!confirm(device.name+" kaydı kalıcı olarak iptal edilsin mi? Agent bağlantısı durdurulur."))return;
  setBusy(true);setError("");
  try{await api("/api/devices/"+encodeURIComponent(device.id)+"/revoke",{method:"POST",body:"{}"});setInfo("Cihaz yetkisi iptal edildi.");await load()}
  catch(e){setError(e instanceof Error?e.message:"İptal işlemi başarısız.")}
  finally{setBusy(false)}
 }
 return <DashboardShell nav={nav} path="/devices" account={account} theme={theme} toggle={toggle} logout={logout}>
  <div className="flex items-end justify-between gap-4 flex-wrap"><div><span className="dash-kicker">ÇALIŞMA ALANI</span><h1 className="dash-title mt-2">Cihazlarım<span className="text-[var(--accent)]">.</span></h1><p className="muted text-sm mt-2">Tüm cihazlarını tek yerden yönet, bağlantı durumlarını izle.</p></div><div className="flex gap-2"><Button variant="outline" onClick={()=>void load()} disabled={loading||!account}><RefreshCw size={17} className={loading?"animate-spin":""}/> Yenile</Button><Button disabled={!account||!canOperator||pairBusy} onClick={()=>void pair()}><Plus size={18}/> Cihaz Ekle</Button></div></div>
  {error&&<div className="form-error mt-6" role="alert">{error}</div>}
  {info&&<div role="status" className="form-success mt-6 flex items-center justify-between">{info}<button onClick={()=>setInfo("")} aria-label="Bildirimi kapat">×</button></div>}
  {!account&&!checking&&<Card className="p-6 mt-6"><h2 className="font-semibold">Cihazlarınızı görmek için giriş yapın</h2><p className="muted text-sm mt-1">Cihazlar ve erişim kodları yalnızca yetkili hesaplarla gösterilir.</p><Button className="mt-4" onClick={()=>nav("/login")}>Giriş yap <ArrowRight size={16}/></Button></Card>}
  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-7">{[{t:"Toplam cihaz",v:active.length,icon:Monitor},{t:"Çevrimiçi",v:active.filter(x=>x.online).length,icon:Wifi},{t:"Çevrimdışı",v:active.filter(x=>!x.online).length,icon:WifiOff},{t:"Bağlantısı kapalı",v:devices.filter(x=>x.revoked_at).length,icon:ShieldCheck}].map(s=><Card className="p-5" key={s.t}><s.icon className="text-[var(--accent)] size-5"/><p className="muted text-xs mt-3">{s.t}</p><strong className="text-2xl">{account?s.v:"—"}</strong></Card>)}</div>
  <Card className="mt-5"><CardHeader className="flex flex-col sm:flex-row justify-between gap-4 sm:items-center"><div><CardTitle>Bağlı Makineler</CardTitle><p className="muted text-sm mt-1">Yetkili cihazların ve durumları</p></div><div className="flex gap-2 items-center"><div className="relative"><Search size={16} className="absolute left-3 top-3 text-[var(--muted)]"/><Input aria-label="Cihaz ara" className="pl-10 h-10" placeholder="Cihaz ara…" value={filter} onChange={e=>setFilter(e.target.value)}/></div></div></CardHeader>
  <CardContent><label className="flex items-center gap-2 text-xs muted mb-3"><input type="checkbox" checked={showRevoked} onChange={e=>setShowRevoked(e.target.checked)}/> İptal edilmiş kayıtları göster</label>
  {!filtered.length?<div className="py-15 text-center"><Monitor className="mx-auto size-11 text-[var(--faint)]"/><h3 className="font-semibold mt-3">{account?"Eşleşen cihaz bulunamadı":"Giriş yaparak cihazlarını görüntüle"}</h3><p className="muted text-sm mt-1">{account?"Eşleştirme koduyla yeni cihaz ekleyebilirsiniz.":"Cihazlarınıza güvenli erişmek için hesabınızı açın."}</p></div>:
   <div className="divide-y divide-[var(--stroke)]">{filtered.map(d=><div key={d.id} className="py-4 flex flex-wrap sm:flex-nowrap items-center gap-3">
    <div className="size-11 flex-none grid place-items-center rounded-xl bg-[var(--subtle-surface)] text-[var(--accent)]"><Monitor size={21}/></div>
    <div className="flex-1 min-w-[145px]"><strong className="text-sm">{d.name}</strong><small className="muted block text-xs mt-1 truncate">{d.platform||"Sistem"} · {d.hostname||d.id.slice(0,8)} · {d.agent_version||"Agent sürümü bilinmiyor"}</small></div>
    <Badge className={d.revoked_at?"text-[var(--danger)]":d.online?"text-[var(--success)]":""}>{d.revoked_at?"● İptal edildi":d.online?"● Çevrimiçi":"● Çevrimdışı"}</Badge>
    <div className="flex gap-2 sm:ml-auto"><Button size="sm" variant="outline" onClick={()=>nav("/terminal?device="+encodeURIComponent(d.id))} disabled={!!d.revoked_at}>Yönet <ArrowRight size={15}/></Button>
     {canAdmin&&!d.revoked_at&&<Button size="sm" variant="ghost" onClick={()=>{setSelected(d);setName(d.name)}} aria-label={d.name+" düzenle"}><MoreHorizontal size={17}/></Button>}
    </div>
   </div>)}</div>}
  </CardContent></Card>
  <div className="mt-5 flex items-start gap-3 p-4 rounded-xl border border-[var(--stroke)] bg-[var(--surface)]"><Info size={18} className="shrink-0 text-[var(--accent)]"/><p className="text-sm muted">Eşleştirme kodları 10 dakika geçerlidir. Terminal ve dosya erişimi cihazdaki ajan ve kullanıcı yetkilerine bağlıdır. Kritik işlemler ayrıca onay gerektirir.</p></div>
  <Dialog open={pairOpen} onOpenChange={setPairOpen}><DialogContent><DialogTitle className="text-xl font-bold">Yeni cihaz eşleştir</DialogTitle><DialogDescription className="text-sm muted mt-2">Cihazınıza WECOMMANDER Agent kurduktan sonra bu tek kullanımlık eşleştirme kodunu cihazdaki agent'a girin.</DialogDescription><div className="border border-[var(--stroke)] bg-[var(--subtle-surface)] rounded-xl p-4 mt-6"><small className="muted">Eşleştirme kodu</small><div className="flex gap-2 items-center mt-2"><code className="font-mono text-sm break-all select-all flex-1">{pairCode}</code><Button variant="outline" size="icon" aria-label="Eşleştirme kodunu kopyala" onClick={()=>void copyCode()}><Copy size={17}/></Button></div></div><p className="text-xs muted mt-4 flex gap-2 items-center"><Clock3 size={14}/> {expiresAt&&Date.now()<expiresAt?"10 dakika geçerli":"Kodun süresi dolmuş olabilir; yeni kod oluşturun."}</p><Button className="w-full mt-5" onClick={()=>setPairOpen(false)}>Tamam</Button></DialogContent></Dialog>
  <Dialog open={!!selected} onOpenChange={open=>{if(!open)setSelected(null)}}><DialogContent><DialogTitle className="text-xl font-bold">Cihazı yönet</DialogTitle><DialogDescription className="text-sm muted mt-1">Cihaz adını değiştirin veya erişimini yönetin.</DialogDescription><form onSubmit={e=>{e.preventDefault();void rename()}} className="mt-6 grid gap-3"><label className="text-sm font-semibold">Cihaz adı<Input className="mt-2" value={name} onChange={e=>setName(e.target.value)} maxLength={120} required/></label><Button type="submit" disabled={busy||!name.trim()}>Kaydet <Check size={16}/></Button></form><div className="border-t border-[var(--stroke)] mt-5 pt-4 grid gap-2"><Button variant="outline" disabled={busy||!selected?.online} onClick={()=>selected&&void disconnect(selected)}>Bağlantıyı kes</Button><Button variant="danger" disabled={busy} onClick={()=>{if(selected){const device=selected;setSelected(null);void revoke(device)}}}>Cihaz yetkisini iptal et</Button></div></DialogContent></Dialog>
 </DashboardShell>
}
