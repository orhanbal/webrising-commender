import {useCallback,useEffect,useMemo,useState} from "react";
import {Check,Clock3,KeyRound,ListChecks,Monitor,Plus,ShieldAlert,ShieldCheck,ShieldQuestion,Trash2,X,Zap} from "lucide-react";
import {t as translate,useLocale,localizedDate} from "../i18n";
import {api,type Account,type Device} from "../api";
import {Alert,Badge,Button,Card,CardContent,CardDescription,CardHeader,CardTitle,Dialog,DialogContent,DialogDescription,DialogTitle,EmptyState,Input,PageHeader,Skeleton,Spinner} from "../components/ui";
import {DashboardShell} from "./Dashboard";
import type {Nav,Theme} from "../App";

// Approvals inbox and per-device AI policy (v1.1 item 5c). Replaces the
// approvals, allowlist and trust panes of the legacy /advanced console. Every
// decision and policy change goes through the same session-only, CSRF-checked
// and audited REST routes the legacy console used.
type ApprovalRequest={id:string;device_id:string;requested_by:string;action_kind:string;action:Record<string,unknown>;status:string;expires_at:string;created_at:string};
type PolicyDevice=Device&{trust_level?:"strict"|"standard"|"full";trust_full_until?:string|null};
type AllowEntry={id:string;pattern:string;created_by?:string;created_at:string};
type Trust="strict"|"standard"|"full";
const trustInfo:Record<Trust,{title:string;text:string;icon:typeof ShieldCheck}>={
 strict:{title:"Sıkı",text:"Her yüksek riskli işlem onay ister; izinli komut listesi kullanılmaz.",icon:ShieldAlert},
 standard:{title:"Standart",text:"İzinli komutlar onaysız çalışır, diğer yüksek riskli işlemler onay ister.",icon:ShieldCheck},
 full:{title:"Tam",text:"Yüksek riskli işlemler tek tek onay istemez. Cihaz yetkileri, izinli klasörler ve denetim kaydı yine geçerlidir.",icon:ShieldQuestion},
};

/** The exact operation an approval would allow, shown before deciding. */
/** What an AI wants to type into a terminal: printable, one line, bounded. */
export function terminalInputText(dataBase64:string){
 let text="";
 try{text=new TextDecoder().decode(Uint8Array.from(atob(dataBase64),c=>c.charCodeAt(0)))}catch{return ""}
 return text.replace(/\r?\n|\r/g,"⏎").replace(/[\u0000-\u001f\u007f]/g,"·").slice(0,300);
}
function operationSummary(item:ApprovalRequest){
 const a=item.action||{};
 if(typeof a.dataBase64==="string")return terminalInputText(a.dataBase64);
 const pick=(...keys:string[])=>keys.map(k=>a[k]).find(v=>typeof v==="string"&&v) as string|undefined;
 return pick("command","path","source","name")??"";
}
function remaining(until:string){const ms=new Date(until).getTime()-Date.now();if(ms<=0)return translate("süresi doldu");const m=Math.round(ms/60000);return m<60?m+" "+translate("dk"):Math.round(m/60)+" "+translate("sa")}

export function ApprovalsPage({nav,account,checking,theme,toggle,logout}:{nav:Nav;account:Account|null;checking:boolean;theme:Theme;toggle:()=>void;logout:()=>void}){
 useLocale();
 const [items,setItems]=useState<ApprovalRequest[]|null>(null);
 const [devices,setDevices]=useState<PolicyDevice[]>([]);
 const [error,setError]=useState("");
 const [forbidden,setForbidden]=useState(false);
 const [decision,setDecision]=useState<{item:ApprovalRequest;kind:"approve"|"deny"}|null>(null);
 const [busy,setBusy]=useState(false);
 const [notice,setNotice]=useState("");
 const deviceName=useMemo(()=>new Map(devices.map(d=>[d.id,d.name])),[devices]);
 const load=useCallback(async()=>{
  try{
   const [approvals,deviceList]=await Promise.all([api<{items:ApprovalRequest[]}>("/api/approval-requests?status=pending&limit=100"),api<{items:PolicyDevice[]}>("/api/devices")]);
   setItems(approvals.items);setDevices(deviceList.items.filter(d=>!d.revoked_at));setForbidden(false);setError("");
  }catch(e){const message=(e as Error).message;if(/forbidden|insufficient/i.test(message)){setForbidden(true);setItems([])}else setError(message)}
 },[]);
 useEffect(()=>{if(!account)return;load();const timer=setInterval(load,15000);return()=>clearInterval(timer)},[account,load]);
 if(!checking&&!account){nav("/login");return null}
 const decide=async()=>{
  if(!decision)return;setBusy(true);
  try{await api("/api/approval-requests/"+decision.item.id+"/"+decision.kind,{method:"POST",body:"{}"});setNotice(decision.kind==="approve"?translate("İşlem onaylandı. Yapay zekâ aynı işlemi tekrar gönderdiğinde bir kez çalışır."):translate("İşlem reddedildi."));setDecision(null);await load()}
  catch(e){setError((e as Error).message);setDecision(null);await load().catch(()=>undefined)}
  finally{setBusy(false)}
 };
 return <DashboardShell nav={nav} path="/approvals" account={account} theme={theme} toggle={toggle} logout={logout}>
  <PageHeader kicker={translate("YAPAY ZEKÂ GÜVENLİĞİ")} title={translate("Onaylar")} description={translate("Yapay zekânın istediği yüksek riskli işlemleri burada tam haliyle gör ve karar ver. Cihaz başına güven seviyesini ve izinli komutları da buradan yönet.")} actions={<Button variant="outline" size="sm" onClick={load}>{translate("Yenile")}</Button>}/>
  <div className="grid gap-5 mt-8">
   {notice&&<Alert tone="success" action={<Button size="sm" variant="ghost" onClick={()=>setNotice("")} aria-label={translate("Kapat")}><X className="size-4"/></Button>}>{notice}</Alert>}
   {error&&<Alert tone="danger" title={translate("İşlem tamamlanamadı")}>{error}</Alert>}
   {forbidden&&<Alert tone="info" title={translate("Yönetici yetkisi gerekiyor")}>{translate("Onay kararlarını ve cihaz politikalarını yalnızca çalışma alanı sahipleri ve yöneticileri görebilir.")}</Alert>}
   {!forbidden&&<Card><CardHeader><CardTitle className="flex items-center gap-2"><Clock3 className="size-5 text-[var(--accent)]" aria-hidden="true"/>{translate("Bekleyen onaylar")}{items&&items.length>0&&<Badge className="ml-1">{items.length}</Badge>}</CardTitle><CardDescription>{translate("Her onay tek kullanımlıktır ve yalnızca gösterilen işlem için geçerlidir.")}</CardDescription></CardHeader><CardContent>
    {items===null?<div className="grid gap-3" aria-busy="true"><Spinner/><Skeleton className="h-20"/><Skeleton className="h-20"/></div>
    :items.length===0?<EmptyState icon={Check} title={translate("Bekleyen onay yok")} description={translate("Yapay zekâ onay gerektiren bir işlem istediğinde burada görünür ve yöneticilere e-posta gider.")}/>
    :<ul className="grid gap-3">{items.map(item=><li key={item.id} className="approval-item"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2 text-sm"><Badge>{item.action_kind}</Badge><span className="font-semibold">{deviceName.get(item.device_id)||item.device_id.slice(0,8)}</span><span className="muted">· {item.requested_by}</span></div>
     {operationSummary(item)&&<code className="approval-op">{operationSummary(item)}</code>}
     <details className="mt-2"><summary className="text-xs muted">{translate("Tam işlem ayrıntısı")}</summary><pre className="approval-json">{JSON.stringify(item.action,null,2)}</pre></details>
     <p className="text-xs muted mt-2">{localizedDate(item.created_at,{dateStyle:"short",timeStyle:"short"})} · {translate("Kalan süre")}: {remaining(item.expires_at)}</p></div>
     <div className="flex gap-2 shrink-0"><Button size="sm" disabled={new Date(item.expires_at).getTime()<=Date.now()} onClick={()=>setDecision({item,kind:"approve"})}><Check className="size-4"/>{translate("Onayla")}</Button><Button size="sm" variant="outline" onClick={()=>setDecision({item,kind:"deny"})}><X className="size-4"/>{translate("Reddet")}</Button></div></li>)}</ul>}
   </CardContent></Card>}
   {!forbidden&&<AutonomyCard devices={devices} onChanged={load} onError={setError}/>}
   {!forbidden&&<CentersCard onError={setError}/>}
   {!forbidden&&<DevicePolicy devices={devices} onChanged={load} onError={setError}/>}
  </div>
  <Dialog open={!!decision} onOpenChange={open=>{if(!open&&!busy)setDecision(null)}}><DialogContent>{decision&&<>
   <DialogTitle className="text-xl font-bold">{decision.kind==="approve"?translate("Bu işlemi onayla?"):translate("Bu işlemi reddet?")}</DialogTitle>
   <DialogDescription className="text-sm muted mt-2">{decision.kind==="approve"?translate("Onay yalnızca aşağıdaki işlem için ve bir kez geçerlidir."):translate("Yapay zekâ bu işlemi çalıştıramaz.")}</DialogDescription>
   <div className="mt-4 grid gap-2 text-sm"><div><span className="muted">{translate("Cihaz")}: </span><strong>{deviceName.get(decision.item.device_id)||decision.item.device_id}</strong></div><div><span className="muted">{translate("İşlem")}: </span><strong>{decision.item.action_kind}</strong></div>{operationSummary(decision.item)&&<code className="approval-op">{operationSummary(decision.item)}</code>}</div>
   <div className="flex justify-end gap-2 mt-6"><Button variant="outline" onClick={()=>setDecision(null)} disabled={busy}>{translate("Vazgeç")}</Button><Button variant={decision.kind==="approve"?"default":"danger"} onClick={decide} disabled={busy}>{busy?<Spinner label={translate("Gönderiliyor…")}/>:decision.kind==="approve"?translate("Onayla"):translate("Reddet")}</Button></div>
  </>}</DialogContent></Dialog>
 </DashboardShell>;
}

/** Minutes until tomorrow 09:00 local time. */
function untilTomorrowMorning(){const t=new Date();t.setDate(t.getDate()+1);t.setHours(9,0,0,0);return Math.max(5,Math.round((t.getTime()-Date.now())/60000))}
const autonomyPresets:{label:string;minutes:()=>number|null}[]=[
 {label:"30 dk",minutes:()=>30},{label:"1 saat",minutes:()=>60},{label:"4 saat",minutes:()=>240},
 {label:"Yarın 09:00'a kadar",minutes:untilTomorrowMorning},{label:"Süresiz",minutes:()=>null},
];

// Autonomous mode (owner request, 2026-11-07): switch per-call approvals off
// for every device or the selected ones, for a time or indefinitely, and stop
// it with one click. Only a browser session can do this; AI clients cannot.
function AutonomyCard({devices,onChanged,onError}:{devices:PolicyDevice[];onChanged:()=>void;onError:(m:string)=>void}){
 const [scope,setScope]=useState<"all"|"some">("all");
 const [picked,setPicked]=useState<Set<string>>(new Set());
 const [preset,setPreset]=useState(1);
 const [password,setPassword]=useState("");
 const [busy,setBusy]=useState(false);
 const [done,setDone]=useState("");
 const active=devices.filter(d=>d.trust_level==="full");
 if(!devices.length)return null;
 const send=async(enable:boolean)=>{
  setBusy(true);setDone("");
  try{
   const deviceIds=scope==="some"?[...picked]:undefined;
   const body=enable?{enable,minutes:autonomyPresets[preset]!.minutes(),deviceIds,currentPassword:password}:{enable};
   const r=await api<{items:unknown[]}>("/api/trust/autonomy",{method:"POST",body:JSON.stringify(body)});
   setPassword("");setDone(enable?translate("Otonom mod açıldı")+" ("+r.items.length+" "+translate("cihaz")+")":translate("Otonom mod durduruldu. Onaylar yeniden geçerli."));onChanged();
  }catch(e){onError((e as Error).message)}finally{setBusy(false)}
 };
 return <Card><CardHeader><CardTitle className="flex items-center gap-2"><Zap className="size-5 text-[var(--warning)]" aria-hidden="true"/>{translate("Otonom mod")}{active.length>0&&<Badge className="ml-1">{active.length} {translate("açık")}</Badge>}</CardTitle><CardDescription>{translate("Onayları geçici ya da süresiz kapat; yapay zekâ yüksek riskli işlemleri beklemeden çalıştırır. Cihaz sınırları, sır maskeleme ve denetim kaydı yine geçerlidir. Bunu yalnızca sen açabilirsin; yapay zekâ istemcileri açamaz.")}</CardDescription></CardHeader><CardContent className="grid gap-5">
  {active.length>0&&<Alert tone="warning" title={translate("Otonom mod açık")} action={<Button size="sm" variant="danger" onClick={()=>send(false)} disabled={busy}>{translate("Hepsini durdur")}</Button>}>{active.map(d=>d.name+(d.trust_full_until?" · "+translate("bitiş")+" "+localizedDate(d.trust_full_until,{dateStyle:"short",timeStyle:"short"}):" · "+translate("süresiz"))).join(", ")}</Alert>}
  <fieldset className="grid gap-2"><legend className="text-sm font-semibold mb-1">{translate("Kapsam")}</legend>
   <label className="flex items-center gap-2 text-sm"><input type="radio" name="autonomy-scope" checked={scope==="all"} onChange={()=>setScope("all")}/>{translate("Tüm cihazlar")} ({devices.length})</label>
   <label className="flex items-center gap-2 text-sm"><input type="radio" name="autonomy-scope" checked={scope==="some"} onChange={()=>setScope("some")}/>{translate("Seçtiğim cihazlar")}</label>
   {scope==="some"&&<div className="grid gap-1 pl-6">{devices.map(d=><label key={d.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={picked.has(d.id)} onChange={e=>{const next=new Set(picked);if(e.target.checked)next.add(d.id);else next.delete(d.id);setPicked(next)}}/>{d.name}</label>)}</div>}
  </fieldset>
  <fieldset className="grid gap-2"><legend className="text-sm font-semibold mb-1">{translate("Süre")}</legend>
   <div className="flex flex-wrap gap-2">{autonomyPresets.map((p,i)=><Button key={p.label} type="button" size="sm" variant={preset===i?"default":"outline"} aria-pressed={preset===i} onClick={()=>setPreset(i)}>{translate(p.label)}</Button>)}</div>
   {autonomyPresets[preset]!.minutes()===null&&<p className="text-xs text-[var(--warning)]">{translate("Süresiz otonom mod siz durdurana kadar açık kalır.")}</p>}
  </fieldset>
  <label className="grid gap-1 max-w-sm"><span className="text-sm font-semibold">{translate("Mevcut şifren")}</span><Input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></label>
  <div className="flex flex-wrap items-center gap-3"><Button onClick={()=>send(true)} disabled={busy||!password||(scope==="some"&&picked.size===0)}>{busy?<Spinner label={translate("Kaydediliyor…")}/>:translate("Otonom modu başlat")}</Button>{done&&<span role="status" className="text-sm text-[var(--success)]">{done}</span>}</div>
 </CardContent></Card>;
}

function DevicePolicy({devices,onChanged,onError}:{devices:PolicyDevice[];onChanged:()=>void;onError:(m:string)=>void}){
 const [selectedId,setSelectedId]=useState("");
 const selected=devices.find(d=>d.id===selectedId)??devices[0];
 const [level,setLevel]=useState<Trust>("standard");
 const [minutes,setMinutes]=useState("60");
 const [password,setPassword]=useState("");
 const [allow,setAllow]=useState<AllowEntry[]|null>(null);
 const [pattern,setPattern]=useState("");
 const [saving,setSaving]=useState(false);
 const [saved,setSaved]=useState("");
 useEffect(()=>{setLevel((selected?.trust_level as Trust)||"standard");setPassword("");setSaved("")},[selected?.id,selected?.trust_level]);
 const loadAllow=useCallback(async()=>{if(!selected){setAllow([]);return}try{setAllow((await api<{items:AllowEntry[]}>("/api/devices/"+selected.id+"/command-allowlist")).items)}catch(e){onError((e as Error).message);setAllow([])}},[selected?.id]);
 useEffect(()=>{setAllow(null);loadAllow()},[loadAllow]);
 if(!devices.length)return <Card><CardHeader><CardTitle>{translate("Cihaz politikası")}</CardTitle></CardHeader><CardContent><EmptyState icon={ShieldCheck} title={translate("Henüz bağlı cihaz yok")} description={translate("Bir cihaz bağladığında güven seviyesini ve izinli komutları buradan yönetirsin.")}/></CardContent></Card>;
 const fullUntil=selected?.trust_level==="full"&&selected.trust_full_until?selected.trust_full_until:null;
 const saveTrust=async()=>{
  if(!selected)return;setSaving(true);setSaved("");
  try{await api("/api/devices/"+selected.id+"/trust",{method:"PUT",body:JSON.stringify({level,...(level==="full"?{currentPassword:password,...(minutes?{minutes:Number(minutes)}:{})}:{})})});setPassword("");setSaved(translate("Güven seviyesi kaydedildi."));onChanged()}
  catch(e){onError((e as Error).message)}finally{setSaving(false)}
 };
 const addPattern=async()=>{if(!selected||!pattern.trim())return;try{await api("/api/devices/"+selected.id+"/command-allowlist",{method:"POST",body:JSON.stringify({pattern:pattern.trim()})});setPattern("");await loadAllow()}catch(e){onError((e as Error).message)}};
 const removePattern=async(id:string)=>{if(!selected)return;try{await api("/api/devices/"+selected.id+"/command-allowlist/"+id,{method:"DELETE"});await loadAllow()}catch(e){onError((e as Error).message)}};
 return <Card><CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="size-5 text-[var(--accent)]" aria-hidden="true"/>{translate("Cihaz politikası")}</CardTitle><CardDescription>{translate("Yapay zekânın bu cihazda onaysız ne yapabileceğini belirle. Bu ayarları yapay zekâ istemcileri değiştiremez.")}</CardDescription></CardHeader><CardContent className="grid gap-6">
  <label className="grid gap-2 max-w-md"><span className="text-sm font-semibold">{translate("Cihaz")}</span><select className="h-11 rounded-xl border border-[var(--stroke)] bg-[var(--input)] px-3 text-sm" value={selected?.id} onChange={e=>setSelectedId(e.target.value)}>{devices.map(d=><option key={d.id} value={d.id}>{d.name}{d.online?"":" · "+translate("çevrim dışı")}</option>)}</select></label>
  <fieldset className="grid gap-3"><legend className="text-sm font-semibold mb-2">{translate("Güven seviyesi")}</legend>
   <div className="trust-options">{(Object.keys(trustInfo) as Trust[]).map(key=>{const info=trustInfo[key];return <label key={key} className={"trust-option"+(level===key?" active":"")}><input type="radio" name="trust" value={key} checked={level===key} onChange={()=>setLevel(key)} className="sr-only"/><info.icon className="size-5" aria-hidden="true"/><span className="font-semibold">{translate(info.title)}{selected?.trust_level===key&&<span className="muted font-normal"> · {translate("şu an")}</span>}</span><span className="text-xs muted">{translate(info.text)}</span></label>})}</div>
   {fullUntil&&<p className="text-xs muted">{translate("Tam güven bitişi")}: {localizedDate(fullUntil,{dateStyle:"short",timeStyle:"short"})}</p>}
   {level==="full"&&<Alert tone="warning" title={translate("Tam güven yüksek riskli işlemleri onaysız çalıştırır")}>{translate("Süreyi sınırla. Değişiklik tüm yöneticilere e-postayla bildirilir ve denetim kaydına yazılır.")}
    <div className="grid gap-3 sm:grid-cols-2 mt-3"><label className="grid gap-1"><span className="text-xs font-semibold text-[var(--text)]">{translate("Süre (dakika, 5–10080)")}</span><Input type="number" min={5} max={10080} value={minutes} onChange={e=>setMinutes(e.target.value)}/></label><label className="grid gap-1"><span className="text-xs font-semibold text-[var(--text)]">{translate("Mevcut şifren")}</span><Input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></label></div></Alert>}
   <div className="flex items-center gap-3"><Button onClick={saveTrust} disabled={saving||!selected||(level==="full"&&!password)}>{saving?<Spinner label={translate("Kaydediliyor…")}/>:translate("Güven seviyesini kaydet")}</Button>{saved&&<span role="status" className="text-sm text-[var(--success)]">{saved}</span>}</div>
  </fieldset>
  <section className="grid gap-3" aria-labelledby="allow-title"><h3 id="allow-title" className="text-sm font-semibold flex items-center gap-2"><ListChecks className="size-4" aria-hidden="true"/>{translate("İzinli komutlar")}</h3><p className="text-xs muted">{translate("Standart seviyede bu komutlarla başlayan process_exec çağrıları onaysız çalışır. Kabuk karakterleri, yorumlayıcılar, sudo ve silme komutları hiçbir zaman eklenemez.")}</p>
   <form className="flex gap-2 max-w-xl" onSubmit={e=>{e.preventDefault();addPattern()}}><Input aria-label={translate("Komut kalıbı")} placeholder="df -h" value={pattern} onChange={e=>setPattern(e.target.value)} className="font-mono"/><Button type="submit" variant="outline" disabled={!pattern.trim()}><Plus className="size-4"/>{translate("Ekle")}</Button></form>
   {allow===null?<Skeleton className="h-10"/>:allow.length===0?<p className="text-sm muted">{translate("Bu cihazda izinli komut yok.")}</p>
   :<ul className="grid gap-2">{allow.map(entry=><li key={entry.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--stroke)] px-4 py-2"><code className="font-mono text-sm">{entry.pattern}</code><Button size="sm" variant="ghost" aria-label={translate("Kaldır")+": "+entry.pattern} onClick={()=>removePattern(entry.id)}><Trash2 className="size-4"/></Button></li>)}</ul>}
  </section>
 </CardContent></Card>;
}

type Center={id:string;name:string;email:string;created_at:string;last_seen_at:string|null;revoked_at:string|null};

/** Management Centers: tray apps signed in to this workspace, with revoke. */
function CentersCard({onError}:{onError:(m:string)=>void}){
 const [items,setItems]=useState<Center[]|null>(null);
 const [copied,setCopied]=useState("");
 const command="irm "+window.location.origin+"/install/center.ps1 | iex";
 const macCommand="curl -fsSL "+window.location.origin+"/install/center.sh | sh";
 const load=useCallback(async()=>{try{setItems((await api<{items:Center[]}>("/api/centers")).items)}catch(e){onError((e as Error).message);setItems([])}},[onError]);
 useEffect(()=>{load()},[load]);
 const revoke=async(id:string)=>{try{await api("/api/centers/"+id+"/revoke",{method:"POST",body:"{}"});await load()}catch(e){onError((e as Error).message)}};
 const copy=async(text:string)=>{try{await navigator.clipboard.writeText(text);setCopied(text);setTimeout(()=>setCopied(""),2000)}catch{/* clipboard unavailable */}};
 const active=(items||[]).filter(c=>!c.revoked_at);
 return <Card><CardHeader><CardTitle className="flex items-center gap-2"><Monitor className="size-5 text-[var(--accent)]" aria-hidden="true"/>{translate("Yönetim merkezleri")}</CardTitle>
  <CardDescription>{translate("Masaüstündeki tepsi uygulaması: tüm cihazlardan gelen onay isteklerini bildirir, onaylar/reddeder ve otonom modu yönetir. Yapay zekâ araçlarını çalıştıramaz.")}</CardDescription></CardHeader>
  <CardContent className="grid gap-3">
   <div><p className="text-sm font-semibold">{translate("Windows'a kur (PowerShell)")}</p><div className="flex flex-wrap items-center gap-2 mt-1"><code className="approval-op flex-1">{command}</code><Button size="sm" variant="outline" onClick={()=>copy(command)}>{copied===command?translate("Kopyalandı"):translate("Kopyala")}</Button></div></div>
   <div><p className="text-sm font-semibold">{translate("macOS'a kur (Terminal)")}</p><div className="flex flex-wrap items-center gap-2 mt-1"><code className="approval-op flex-1">{macCommand}</code><Button size="sm" variant="outline" onClick={()=>copy(macCommand)}>{copied===macCommand?translate("Kopyalandı"):translate("Kopyala")}</Button></div></div>
   {items===null?<Skeleton className="h-12"/>:active.length===0?<p className="text-sm muted">{translate("Bağlı yönetim merkezi yok.")}</p>
   :<ul className="grid gap-2">{active.map(c=><li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span><span className="font-semibold">{c.name}</span> <span className="muted">· {c.email} · {translate("son görülme")}: {c.last_seen_at?localizedDate(c.last_seen_at,{dateStyle:"short",timeStyle:"short"}):"—"}</span></span>
    <Button size="sm" variant="outline" onClick={()=>revoke(c.id)}><X className="size-4"/>{translate("Bağlantıyı iptal et")}</Button></li>)}</ul>}
  </CardContent></Card>;
}
