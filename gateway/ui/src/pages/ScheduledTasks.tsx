import {useCallback,useEffect,useMemo,useState,type ReactNode} from "react";
import {CalendarClock,Check,ChevronLeft,History,Monitor,Pencil,Play,Plus,RefreshCw,Server,Trash2,X} from "../components/icons";
import {t as translate,useLocale,localizedDate,intlLocale} from "../i18n";
import {api,type Account,type Device} from "../api";
import {Alert,Badge,Button,Card,CardContent,CardDescription,CardHeader,CardTitle,Dialog,DialogContent,DialogDescription,DialogTitle,EmptyState,Input,PageHeader,Skeleton,Spinner} from "../components/ui";
import {DashboardShell} from "./Dashboard";
import type {Nav,Theme} from "../App";

// WECOMMANDER's own scheduled tasks (stored on the server, not the OS task
// scheduler). Device targets run on the device's agent; saved SSH hosts are
// added from the desktop app (it holds the credentials) and shown here.
type Schedule={kind:"cron";expr:string}|{kind:"interval";minutes:number}|{kind:"once";at:string};
type Target={kind:"device";deviceId:string}|{kind:"ssh";centerId:string;hostId:string;hostLabel:string};
type RunStatus="queued"|"running"|"succeeded"|"failed"|"missed"|"skipped"|"cancelled";
type Run={id:string;taskId:string;scheduledFor:string;startedAt?:string;finishedAt?:string;status:RunStatus;exitCode?:number;output?:string;runner:"agent"|"center";trigger:"schedule"|"manual";error?:string};
type Task={id:string;name:string;description?:string;target:Target;targetLabel?:string;command:string;schedule:Schedule;timezone:string;enabled:boolean;timeoutSec:number;notify:"failure"|"always"|"never";createdBy:string;createdAt:string;updatedAt:string;nextRunAt:string|null;lastRun?:Run};
type Draft={name:string;description:string;deviceId:string;command:string;kind:Schedule["kind"];expr:string;minutes:string;at:string;timezone:string;timeoutSec:string;notify:Task["notify"];enabled:boolean};

const statusText:Record<RunStatus,string>={queued:"Sırada",running:"Çalışıyor",succeeded:"Başarılı",failed:"Başarısız",missed:"Kaçırıldı",skipped:"Atlandı",cancelled:"İptal edilen"};
const statusClass:Record<RunStatus,string>={queued:"text-[var(--info)]",running:"text-[var(--info)]",succeeded:"text-[var(--success)]",failed:"text-[var(--danger)]",missed:"text-[var(--warning)]",skipped:"",cancelled:""};
const notifyText:Record<Task["notify"],string>={failure:"Yalnızca hata olursa",always:"Her çalışmada",never:"Bildirme"};
const presets:{label:string;expr:string}[]=[
 {label:"Her saat",expr:"0 * * * *"},{label:"Her gün 03:00",expr:"0 3 * * *"},{label:"Hafta içi 09:00",expr:"0 9 * * 1-5"},
 {label:"Her pazartesi 09:00",expr:"0 9 * * 1"},{label:"Her ayın 1'i 00:00",expr:"0 0 1 * *"},
];
const fill=(text:string,values:Record<string,string|number>)=>text.replace(/\{(\w+)\}/g,(_,k:string)=>String(values[k]??""));
function browserZone(){try{return Intl.DateTimeFormat().resolvedOptions().timeZone||"Europe/Istanbul"}catch{return "Europe/Istanbul"}}
function zoneNames():string[]{try{return (Intl as unknown as {supportedValuesOf:(k:string)=>string[]}).supportedValuesOf("timeZone")}catch{return ["Europe/Istanbul","UTC"]}}
const pad=(n:number)=>String(n).padStart(2,"0");
function weekdayName(dow:number){const d=new Date(Date.UTC(2026,0,4+(dow%7)));return new Intl.DateTimeFormat(intlLocale(),{weekday:"long",timeZone:"UTC"}).format(d)}

/** The schedule in words in the interface language (common cron forms; others show the expression). */
export function scheduleText(s:Schedule):string{
 if(s.kind==="interval"){
  if(s.minutes%1440===0)return fill(translate("Her {n} günde bir"),{n:s.minutes/1440});
  if(s.minutes%60===0)return s.minutes===60?translate("Her saat"):fill(translate("Her {n} saatte bir"),{n:s.minutes/60});
  return fill(translate("Her {n} dakikada bir"),{n:s.minutes});
 }
 if(s.kind==="once")return fill(translate("Bir kez: {date}"),{date:localizedDate(s.at,{dateStyle:"medium",timeStyle:"short"})});
 const f=s.expr.trim().split(/\s+/);
 if(f.length!==5)return s.expr;
 const [mi,ho,dom,mon,dow]=f as [string,string,string,string,string];
 const num=(v:string)=>/^\d{1,2}$/.test(v);
 if(f.every(x=>x==="*"))return translate("Her dakika");
 const step=/^\*\/(\d+)$/.exec(mi);
 if(step&&ho==="*"&&dom==="*"&&mon==="*"&&dow==="*")return fill(translate("Her {n} dakikada bir"),{n:step[1]!});
 if(num(mi)&&ho==="*"&&dom==="*"&&mon==="*"&&dow==="*")return fill(translate("Her saat, {m}. dakikada"),{m:Number(mi)});
 if(num(mi)&&num(ho)&&mon==="*"){
  const time=pad(Number(ho))+":"+pad(Number(mi));
  if(dom==="*"&&dow==="*")return fill(translate("Her gün {time}"),{time});
  if(dom==="*"&&dow==="1-5")return fill(translate("Hafta içi her gün {time}"),{time});
  if(dom==="*"&&(dow==="0,6"||dow==="6,0"||dow==="6,7"))return fill(translate("Hafta sonu {time}"),{time});
  if(dom==="*"&&/^[0-7]$/.test(dow))return fill(translate("Her {day} {time}"),{day:weekdayName(Number(dow)),time});
  if(num(dom)&&dow==="*")return fill(translate("Her ayın {d}. günü {time}"),{d:Number(dom),time});
 }
 return fill(translate("Cron: {expr}"),{expr:s.expr});
}
function inZone(iso:string,timeZone:string){try{return new Intl.DateTimeFormat(intlLocale(),{dateStyle:"medium",timeStyle:"short",timeZone}).format(new Date(iso))}catch{return localizedDate(iso,{dateStyle:"medium",timeStyle:"short"})}}
function duration(run:Run){if(!run.startedAt||!run.finishedAt)return "";const s=Math.max(0,Math.round((new Date(run.finishedAt).getTime()-new Date(run.startedAt).getTime())/1000));return s<60?s+" "+translate("sn"):Math.floor(s/60)+" "+translate("dk")+" "+s%60+" "+translate("sn")}
function localInput(iso:string){const d=new Date(iso);return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())+"T"+pad(d.getHours())+":"+pad(d.getMinutes())}
function StatusBadge({status}:{status:RunStatus}){return <Badge className={statusClass[status]}>● {translate(statusText[status])}</Badge>}

function emptyDraft(deviceId:string):Draft{return {name:"",description:"",deviceId,command:"",kind:"cron",expr:"0 3 * * *",minutes:"60",at:localInput(new Date(Date.now()+3600_000).toISOString()),timezone:browserZone(),timeoutSec:"600",notify:"failure",enabled:true}}
function draftOf(task:Task):Draft{return {name:task.name,description:task.description??"",deviceId:task.target.kind==="device"?task.target.deviceId:"",command:task.command,kind:task.schedule.kind,expr:task.schedule.kind==="cron"?task.schedule.expr:"0 3 * * *",minutes:task.schedule.kind==="interval"?String(task.schedule.minutes):"60",at:task.schedule.kind==="once"?localInput(task.schedule.at):localInput(new Date(Date.now()+3600_000).toISOString()),timezone:task.timezone,timeoutSec:String(task.timeoutSec),notify:task.notify,enabled:task.enabled}}
function scheduleOf(d:Draft):Schedule|null{
 if(d.kind==="cron")return {kind:"cron",expr:d.expr.trim()};
 if(d.kind==="interval")return {kind:"interval",minutes:Number(d.minutes)};
 const at=new Date(d.at);return Number.isNaN(at.getTime())?null:{kind:"once",at:at.toISOString()};
}

export function ScheduledTasksPage({nav,account,checking,theme,toggle,logout}:{nav:Nav;account:Account|null;checking:boolean;theme:Theme;toggle:()=>void;logout:()=>void}){
 useLocale();
 const [tasks,setTasks]=useState<Task[]|null>(null);
 const [devices,setDevices]=useState<Device[]>([]);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const [editing,setEditing]=useState<{task:Task|null;draft:Draft}|null>(null);
 const [removing,setRemoving]=useState<Task|null>(null);
 const [history,setHistory]=useState<Task|null>(null);
 const [busy,setBusy]=useState(false);
 const canAdmin=["admin","owner"].includes(account?.role||"")||account?.global===true;
 const deviceName=useMemo(()=>new Map(devices.map(d=>[d.id,d.name])),[devices]);
 const load=useCallback(async()=>{
  try{
   const [list,deviceList]=await Promise.all([api<{items:Task[]}>("/api/scheduled-tasks"),api<{items:Device[]}>("/api/devices")]);
   setTasks(list.items);setDevices(deviceList.items.filter(d=>!d.revoked_at));setError("");
  }catch(e){setError((e as Error).message);setTasks(old=>old??[])}
 },[]);
 useEffect(()=>{if(!account)return;void load();const timer=setInterval(()=>void load(),15000);return()=>clearInterval(timer)},[account,load]);
 if(!checking&&!account){nav("/login");return null}
 const targetText=(task:Task)=>task.target.kind==="device"?(task.targetLabel||deviceName.get(task.target.deviceId)||task.target.deviceId.slice(0,8)):task.target.hostLabel;
 async function act(work:()=>Promise<unknown>,done:string){
  setBusy(true);setError("");
  try{await work();setNotice(done);await load()}catch(e){setError((e as Error).message)}finally{setBusy(false)}
 }
 const toggleEnabled=(task:Task)=>act(()=>api("/api/scheduled-tasks/"+task.id,{method:"PATCH",body:JSON.stringify({enabled:!task.enabled})}),task.enabled?translate("Görev durduruldu."):translate("Görev etkinleştirildi."));
 const runNow=(task:Task)=>act(()=>api("/api/scheduled-tasks/"+task.id+"/run",{method:"POST",body:"{}"}),task.target.kind==="ssh"?translate("Çalıştırma sıraya alındı; masaüstü uygulaması bir sonraki kontrolünde çalıştırır."):translate("Görev çalıştırılıyor. Sonucu geçmişte görebilirsiniz."));
 const remove=async()=>{if(!removing)return;const task=removing;await act(()=>api("/api/scheduled-tasks/"+task.id,{method:"DELETE"}),translate("Görev silindi."));setRemoving(null)};
 const failing=(tasks??[]).filter(t=>t.lastRun&&(t.lastRun.status==="failed"||t.lastRun.status==="missed")).length;
 return <DashboardShell nav={nav} path="/scheduled-tasks" account={account} theme={theme} toggle={toggle} logout={logout}>
  <PageHeader kicker={translate("ÇALIŞMA ALANI")} title={translate("Zamanlanmış görevler")} description={translate("Komutları belirlediğiniz zamanda WECOMMANDER sunucusu çalıştırır: cihaz görevleri cihazın ajanında, bilgisayarınız kapalıyken de. SSH sunucuları için görevleri masaüstü uygulamasından ekleyin.")}
   actions={<><Button variant="outline" size="sm" onClick={()=>void load()}><RefreshCw className="size-4"/>{translate("Yenile")}</Button>{canAdmin&&<Button size="sm" disabled={!devices.length} onClick={()=>setEditing({task:null,draft:emptyDraft(devices.find(d=>d.online)?.id??devices[0]?.id??"")})}><Plus className="size-4"/>{translate("Yeni görev")}</Button>}</>}/>
  <div className="grid gap-5 mt-8">
   {notice&&<Alert tone="success" action={<Button size="sm" variant="ghost" onClick={()=>setNotice("")} aria-label={translate("Kapat")}><X className="size-4"/></Button>}>{notice}</Alert>}
   {error&&<Alert tone="danger" title={translate("İşlem tamamlanamadı")}>{error}</Alert>}
   {failing>0&&<Alert tone="warning" title={fill(translate("{n} görevin son çalışması başarısız oldu veya kaçırıldı."),{n:failing})}>{translate("Ayrıntılar için görevin geçmişini açın.")}</Alert>}
   {!canAdmin&&account&&<Alert tone="info">{translate("Görevleri görüntüleyebilirsiniz; eklemek, değiştirmek ve çalıştırmak için yönetici veya sahip rolü gerekir.")}</Alert>}
   <Card><CardHeader><CardTitle className="flex items-center gap-2"><CalendarClock className="size-5 text-[var(--accent)]" aria-hidden="true"/>{translate("Görevler")}{tasks&&tasks.length>0&&<Badge className="ml-1">{tasks.length}</Badge>}</CardTitle><CardDescription>{translate("Her çalışma denetim kaydına yazılır. Görevi oluşturmanız, çalışmalarının onayıdır; her çalışmada ayrıca onay istenmez.")}</CardDescription></CardHeader><CardContent>
    {tasks===null?<div className="grid gap-3" aria-busy="true"><Spinner/><Skeleton className="h-16"/><Skeleton className="h-16"/></div>
    :tasks.length===0?<EmptyState icon={CalendarClock} title={translate("Henüz zamanlanmış görev yok")} description={devices.length?translate("Yedekleme, temizlik veya rapor komutlarını düzenli çalıştırmak için yeni bir görev ekleyin."):translate("Görev eklemek için önce bir cihaz bağlayın.")} action={canAdmin&&devices.length?<Button size="sm" onClick={()=>setEditing({task:null,draft:emptyDraft(devices[0]!.id)})}><Plus className="size-4"/>{translate("Yeni görev")}</Button>:undefined}/>
    :<ul className="divide-y divide-[var(--stroke)]">{tasks.map(task=><li key={task.id} className="py-4 flex flex-wrap lg:flex-nowrap items-center gap-3">
     <div className="size-11 flex-none grid place-items-center rounded-xl bg-[var(--subtle-surface)] text-[var(--accent)]">{task.target.kind==="device"?<Monitor size={20}/>:<Server size={20}/>}</div>
     <div className="flex-1 min-w-[200px]">
      <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{task.name}</strong>{!task.enabled&&<Badge>{translate("Durduruldu")}</Badge>}{task.target.kind==="ssh"&&<Badge>SSH</Badge>}</div>
      <small className="muted block text-xs mt-1">{targetText(task)} · {scheduleText(task.schedule)} · {task.timezone}</small>
      <code className="block text-xs mt-1 truncate font-mono muted" title={task.command}>{task.command}</code>
     </div>
     <div className="text-xs min-w-[150px]"><span className="muted block">{translate("Sonraki çalışma")}</span><span>{task.nextRunAt?inZone(task.nextRunAt,task.timezone):"—"}</span></div>
     <div className="min-w-[110px]">{task.lastRun?<StatusBadge status={task.lastRun.status}/>:<span className="text-xs muted">{translate("Henüz çalışmadı")}</span>}</div>
     <div className="flex flex-wrap gap-1 lg:ml-auto">
      {canAdmin&&<label className="inline-flex items-center gap-2 text-xs px-2" title={translate("Etkin")}><input type="checkbox" role="switch" aria-label={translate("Etkin")+": "+task.name} checked={task.enabled} disabled={busy} onChange={()=>void toggleEnabled(task)}/>{translate("Etkin")}</label>}
      {canAdmin&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void runNow(task)}><Play className="size-4"/>{translate("Şimdi çalıştır")}</Button>}
      <Button size="sm" variant="ghost" onClick={()=>setHistory(task)} aria-label={translate("Geçmiş")+": "+task.name}><History className="size-4"/>{translate("Geçmiş")}</Button>
      {canAdmin&&<Button size="sm" variant="ghost" onClick={()=>setEditing({task,draft:draftOf(task)})} aria-label={translate("Düzenle")+": "+task.name}><Pencil className="size-4"/></Button>}
      {canAdmin&&<Button size="sm" variant="ghost" onClick={()=>setRemoving(task)} aria-label={translate("Sil")+": "+task.name}><Trash2 className="size-4"/></Button>}
     </div>
    </li>)}</ul>}
   </CardContent></Card>
  </div>
  {editing&&<TaskDialog key={editing.task?.id??"new"} task={editing.task} initial={editing.draft} devices={devices} onClose={()=>setEditing(null)} onSaved={async message=>{setEditing(null);setNotice(message);await load()}}/>}
  <Dialog open={!!removing} onOpenChange={open=>{if(!open&&!busy)setRemoving(null)}}><DialogContent>{removing&&<>
   <DialogTitle className="text-xl font-bold">{translate("Görev silinsin mi?")}</DialogTitle>
   <DialogDescription className="text-sm muted mt-2">{translate("Görev ve çalışma geçmişi kalıcı olarak silinir. Denetim kaydı korunur.")}</DialogDescription>
   <div className="mt-4 grid gap-1 text-sm"><strong>{removing.name}</strong><span className="muted">{targetText(removing)}</span><code className="approval-op">{removing.command}</code></div>
   <div className="flex justify-end gap-2 mt-6"><Button variant="outline" onClick={()=>setRemoving(null)} disabled={busy}>{translate("Vazgeç")}</Button><Button variant="danger" onClick={()=>void remove()} disabled={busy}>{busy?<Spinner label={translate("Siliniyor…")}/>:<><Trash2 className="size-4"/>{translate("Sil")}</>}</Button></div>
  </>}</DialogContent></Dialog>
  {history&&<RunsDialog task={history} title={targetText(history)} onClose={()=>setHistory(null)}/>}
 </DashboardShell>;
}

function Field({label,children,hint}:{label:string;children:ReactNode;hint?:string}){return <label className="grid gap-1 text-sm"><span className="font-semibold">{label}</span>{children}{hint&&<span className="text-xs muted">{hint}</span>}</label>}
const selectClass="h-11 rounded-xl border border-[var(--stroke)] bg-[var(--input)] px-3 text-sm";

function TaskDialog({task,initial,devices,onClose,onSaved}:{task:Task|null;initial:Draft;devices:Device[];onClose:()=>void;onSaved:(message:string)=>void|Promise<void>}){
 useLocale();
 const [draft,setDraft]=useState<Draft>(initial);
 const [step,setStep]=useState<"form"|"confirm">("form");
 const [preview,setPreview]=useState<{next:string[]}|{error:string}|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const ssh=task?.target.kind==="ssh";
 const set=(patch:Partial<Draft>)=>setDraft(d=>({...d,...patch}));
 const schedule=scheduleOf(draft);
 const scheduleKey=JSON.stringify(schedule)+draft.timezone;
 const zones=useMemo(zoneNames,[]);
 useEffect(()=>{
  if(!schedule){setPreview({error:translate("Geçerli bir tarih ve saat girin.")});return}
  let active=true;
  const timer=setTimeout(()=>{api<{next:string[]}>("/api/scheduled-tasks/preview",{method:"POST",body:JSON.stringify({schedule,timezone:draft.timezone})}).then(r=>{if(active)setPreview(r)}).catch(e=>{if(active)setPreview({error:(e as Error).message})})},350);
  return()=>{active=false;clearTimeout(timer)};
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[scheduleKey]);
 const device=devices.find(d=>d.id===draft.deviceId);
 const targetLabel=ssh&&task?.target.kind==="ssh"?task.target.hostLabel:device?.name??"";
 const valid=draft.name.trim()&&draft.command.trim()&&(ssh||draft.deviceId)&&schedule&&preview&&"next" in preview;
 async function save(){
  if(!schedule)return;
  setBusy(true);setError("");
  const body:Record<string,unknown>={name:draft.name.trim(),description:draft.description.trim(),schedule,timezone:draft.timezone,timeoutSec:Number(draft.timeoutSec),notify:draft.notify,enabled:draft.enabled};
  if(!ssh){body.command=draft.command;body.target={kind:"device",deviceId:draft.deviceId}}
  try{
   if(task)await api("/api/scheduled-tasks/"+task.id,{method:"PATCH",body:JSON.stringify(body)});
   else await api("/api/scheduled-tasks",{method:"POST",body:JSON.stringify(body)});
   await onSaved(task?translate("Görev güncellendi."):translate("Görev oluşturuldu."));
  }catch(e){setError((e as Error).message);setStep("form")}
  finally{setBusy(false)}
 }
 return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose()}}><DialogContent className="w-[min(94vw,640px)] max-h-[92vh] overflow-y-auto">
  <DialogTitle className="text-xl font-bold">{task?translate("Görevi düzenle"):translate("Yeni zamanlanmış görev")}</DialogTitle>
  <DialogDescription className="text-sm muted mt-1">{step==="form"?translate("Komut, hedef ve zamanı belirleyin. Kaydetmeden önce tam komutu ve hedefi onaylayacaksınız."):translate("Lütfen kontrol edin: bu komut, bu hedefte, bu zamanlarda onay beklemeden çalışacak.")}</DialogDescription>
  {error&&<Alert tone="danger" className="mt-4">{error}</Alert>}
  {step==="form"?<form className="mt-5 grid gap-4" onSubmit={e=>{e.preventDefault();if(valid)setStep("confirm")}}>
   <Field label={translate("Ad")}><Input value={draft.name} maxLength={80} required onChange={e=>set({name:e.target.value})}/></Field>
   <Field label={translate("Açıklama (isteğe bağlı)")}><Input value={draft.description} maxLength={500} onChange={e=>set({description:e.target.value})}/></Field>
   {ssh?<Field label={translate("Hedef")} hint={translate("SSH sunucusu ve komutu masaüstü uygulamasından değiştirilir.")}><Input value={"SSH · "+targetLabel} readOnly/></Field>
   :<Field label={translate("Hedef cihaz")}><select className={selectClass} value={draft.deviceId} required onChange={e=>set({deviceId:e.target.value})}>{devices.map(d=><option key={d.id} value={d.id}>{d.name}{d.online?"":" ("+translate("çevrimdışı")+")"}</option>)}</select></Field>}
   <Field label={translate("Komut")} hint={ssh?undefined:translate("Cihazın kabuğunda olduğu gibi çalışır (Windows'ta cmd, diğerlerinde sh). Cihazın kendi kısıtlamaları yine geçerlidir.")}><textarea className="min-h-24 w-full rounded-xl border border-[var(--stroke)] bg-[var(--input)] px-4 py-3 text-sm font-mono outline-none focus-visible:border-[var(--accent)]" value={draft.command} maxLength={4000} required readOnly={ssh} spellCheck={false} onChange={e=>set({command:e.target.value})}/></Field>
   <fieldset className="grid gap-2"><legend className="text-sm font-semibold mb-1">{translate("Zaman")}</legend>
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={translate("Zamanlama türü")}>{([["cron","Cron ifadesi"],["interval","Aralıkla"],["once","Bir kez"]] as const).map(([kind,label])=><Button key={kind} type="button" size="sm" role="radio" aria-checked={draft.kind===kind} variant={draft.kind===kind?"default":"outline"} onClick={()=>set({kind})}>{translate(label)}</Button>)}</div>
    {draft.kind==="cron"&&<><Input aria-label={translate("Cron ifadesi")} className="font-mono" value={draft.expr} onChange={e=>set({expr:e.target.value})} placeholder="m h dom mon dow"/>
     <div className="flex flex-wrap gap-1">{presets.map(p=><Button key={p.expr} type="button" size="sm" variant="ghost" onClick={()=>set({expr:p.expr})}>{translate(p.label)}</Button>)}</div>
     <span className="text-xs muted">{translate("5 alan: dakika saat gün ay haftanın-günü. Örnek: 30 2 * * 1-5 (hafta içi 02:30).")}</span></>}
    {draft.kind==="interval"&&<Field label={translate("Kaç dakikada bir")} hint={translate("5 dakika ile 7 gün (10080 dakika) arası.")}><Input type="number" min={5} max={10080} value={draft.minutes} onChange={e=>set({minutes:e.target.value})}/></Field>}
    {draft.kind==="once"&&<Field label={translate("Tarih ve saat")} hint={translate("Tarayıcınızın saatine göre.")}><Input type="datetime-local" value={draft.at} onChange={e=>set({at:e.target.value})}/></Field>}
   </fieldset>
   <Field label={translate("Saat dilimi")}><Input list="wc-zones" value={draft.timezone} onChange={e=>set({timezone:e.target.value})}/><datalist id="wc-zones">{zones.map(z=><option key={z} value={z}/>)}</datalist></Field>
   <div className="rounded-xl border border-[var(--stroke)] bg-[var(--subtle-surface)] p-3 text-sm" aria-live="polite"><p className="font-semibold">{translate("Sonraki 5 çalışma")}</p>
    {!preview?<Spinner/>:"error" in preview?<p className="text-[var(--danger)] mt-1">{preview.error}</p>:preview.next.length===0?<p className="muted mt-1">{translate("Bu zamanlama artık çalışmayacak.")}</p>:<ol className="mt-1 grid gap-0.5">{preview.next.map(n=><li key={n}>{inZone(n,draft.timezone)}</li>)}</ol>}
    {schedule&&<p className="text-xs muted mt-2">{scheduleText(schedule)} · {draft.timezone}</p>}</div>
   <div className="grid sm:grid-cols-2 gap-4">
    <Field label={translate("Zaman aşımı (saniye)")}><Input type="number" min={10} max={3600} value={draft.timeoutSec} onChange={e=>set({timeoutSec:e.target.value})}/></Field>
    <Field label={translate("Bildirim")}><select className={selectClass} value={draft.notify} onChange={e=>set({notify:e.target.value as Task["notify"]})}>{(["failure","always","never"] as const).map(n=><option key={n} value={n}>{translate(notifyText[n])}</option>)}</select></Field>
   </div>
   <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={e=>set({enabled:e.target.checked})}/>{translate("Etkin")}</label>
   <div className="flex justify-end gap-2 mt-2"><Button type="button" variant="outline" onClick={onClose}>{translate("Vazgeç")}</Button><Button type="submit" disabled={!valid}>{translate("Devam")}</Button></div>
  </form>
  :<div className="mt-5 grid gap-3 text-sm">
   <div><span className="muted">{translate("Hedef")}: </span><strong>{ssh?"SSH · ":""}{targetLabel}</strong></div>
   <div><span className="muted block">{translate("Çalışacak komut")}:</span><pre className="approval-json whitespace-pre-wrap break-all text-[var(--text)]">{draft.command}</pre></div>
   <div><span className="muted">{translate("Zaman")}: </span><strong>{schedule?scheduleText(schedule):""}</strong> · {draft.timezone}</div>
   {preview&&"next" in preview&&preview.next[0]&&<div><span className="muted">{translate("İlk çalışma")}: </span>{inZone(preview.next[0],draft.timezone)}</div>}
   <Alert tone="warning">{translate("Görevi oluşturmanız, her çalışmasının onayıdır. Çalışmalar denetim kaydına yazılır.")}</Alert>
   <div className="flex justify-end gap-2 mt-2"><Button variant="outline" onClick={()=>setStep("form")} disabled={busy}><ChevronLeft className="size-4"/>{translate("Geri")}</Button><Button onClick={()=>void save()} disabled={busy}>{busy?<Spinner label={translate("Kaydediliyor…")}/>:<><Check className="size-4"/>{translate("Onayla ve kaydet")}</>}</Button></div>
  </div>}
 </DialogContent></Dialog>;
}

function RunsDialog({task,title,onClose}:{task:Task;title:string;onClose:()=>void}){
 useLocale();
 const [runs,setRuns]=useState<Run[]|null>(null);
 const [error,setError]=useState("");
 const [open,setOpen]=useState<string|null>(null);
 const load=useCallback(()=>api<{items:Run[]}>("/api/scheduled-tasks/"+task.id+"/runs?limit=50").then(r=>{setRuns(r.items);setError("")}).catch(e=>setError((e as Error).message)),[task.id]);
 useEffect(()=>{void load();const timer=setInterval(()=>void load(),5000);return()=>clearInterval(timer)},[load]);
 return <Dialog open onOpenChange={o=>{if(!o)onClose()}}><DialogContent className="w-[min(94vw,760px)] max-h-[92vh] overflow-y-auto">
  <DialogTitle className="text-xl font-bold">{translate("Çalışma geçmişi")}: {task.name}</DialogTitle>
  <DialogDescription className="text-sm muted mt-1">{title} · {scheduleText(task.schedule)}</DialogDescription>
  {error&&<Alert tone="danger" className="mt-4">{error}</Alert>}
  {runs===null?<div className="mt-4"><Spinner/></div>:runs.length===0?<EmptyState className="mt-4" icon={History} title={translate("Henüz çalışma yok")}/>:
  <ul className="mt-4 grid gap-2">{runs.map(run=><li key={run.id} className="rounded-xl border border-[var(--stroke)] p-3">
   <button type="button" className="w-full text-left flex flex-wrap items-center gap-2 text-sm" aria-expanded={open===run.id} onClick={()=>setOpen(open===run.id?null:run.id)}>
    <StatusBadge status={run.status}/><span>{localizedDate(run.scheduledFor,{dateStyle:"medium",timeStyle:"short"})}</span>
    <span className="muted text-xs">{run.trigger==="manual"?translate("Elle"):translate("Zamanlı")} · {run.runner==="agent"?translate("Cihaz ajanı"):translate("Masaüstü uygulaması")}{run.exitCode!==undefined?" · "+fill(translate("çıkış kodu {code}"),{code:run.exitCode}):""}{duration(run)?" · "+duration(run):""}</span>
   </button>
   {run.error&&<p className="text-xs text-[var(--danger)] mt-1 break-all">{run.error}</p>}
   {open===run.id&&(run.output?<pre className="approval-json whitespace-pre-wrap break-all max-h-[360px] text-[var(--text)]">{run.output}</pre>:<p className="text-xs muted mt-2">{translate("Çıktı yok.")}</p>)}
  </li>)}</ul>}
  <div className="flex justify-end mt-4"><Button variant="outline" onClick={onClose}>{translate("Kapat")}</Button></div>
 </DialogContent></Dialog>;
}
