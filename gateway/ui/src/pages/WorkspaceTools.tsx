import {useCallback,useEffect,useRef,useState} from "react";
import {ArrowUp,File,Folder,FolderPlus,MoveRight,Play,RefreshCw,Save,Search,Square,Trash2,X} from "lucide-react";
import {t as translate} from "../i18n";
import {api} from "../api";
import {Alert,Badge,Button,Card,CardContent,CardDescription,CardHeader,CardTitle,EmptyState,Input,Spinner} from "../components/ui";

// Human workspace tools (v1.1 item 5e, part 2): files, tasks and an
// interactive terminal, moved from the legacy /advanced console. Every call
// goes through POST /api/device/request with the same role, device policy and
// audit as MCP. HIGH-risk actions (delete, task start/cancel, terminal
// start/stop) first get a single-use approval for that exact action from
// POST /api/approvals, which only admins and owners in a browser session can
// issue; others get the server's refusal message.
type Result=Record<string,any>;
export type Request=(action:Record<string,unknown>,high?:boolean)=>Promise<Result>;

export function useDeviceRequest(deviceId:string){
 return useCallback<Request>(async(action,high=false)=>{
  if(!deviceId)throw new Error(translate("Önce bir cihaz seçmelisiniz."));
  let approvalToken:string|undefined;
  if(high)approvalToken=(await api<{approvalToken:string}>("/api/approvals",{method:"POST",body:JSON.stringify({deviceId,action})})).approvalToken;
  const response=await api<{ok:boolean;data:Result}>("/api/device/request",{method:"POST",body:JSON.stringify({deviceId,action,...(approvalToken?{approvalToken}:{})})});
  return response.data;
 },[deviceId]);
}

const b64=(text:string)=>btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const join=(base:string,name:string)=>{const sep=base.includes("\\")&&!base.includes("/")?"\\":"/";return base.replace(/[\\/]+$/,"")+sep+name};
const parent=(p:string)=>{const trimmed=p.replace(/[\\/]+$/,"");const i=Math.max(trimmed.lastIndexOf("/"),trimmed.lastIndexOf("\\"));return i>0?trimmed.slice(0,i):i===0?trimmed.slice(0,1):trimmed};

type Entry={name:string;path:string;type:"file"|"directory"|string;size?:number};
export function FileBrowser({request,online}:{request:Request;online:boolean}){
 const [dir,setDir]=useState(".");
 const [entries,setEntries]=useState<Entry[]|null>(null);
 const [file,setFile]=useState<{path:string;content:string;original:string;text:boolean;size:number}|null>(null);
 const [query,setQuery]=useState("");
 const [found,setFound]=useState<string>("");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const run=async<T,>(fn:()=>Promise<T>)=>{setBusy(true);setError("");try{return await fn()}catch(e){setError((e as Error).message);return undefined}finally{setBusy(false)}};
 const list=(path=dir)=>run(async()=>{const d=await request({kind:"fs_list",path});setEntries((d.items as Entry[])||[]);setDir(String(d.path||path))});
 const open=(path:string)=>run(async()=>{const d=await request({kind:"fs_read",path});const text=d.encoding==="utf8";setFile({path,content:text?String(d.content):"",original:text?String(d.content):"",text,size:Number(d.size||0)})});
 const save=()=>file&&run(async()=>{if(!confirm(translate("Değişiklikler kaydedilsin mi?")+"\n"+file.path))return;await request({kind:"fs_write",path:file.path,contentBase64:b64(file.content),createParents:false});setFile({...file,original:file.content})});
 const mkdir=()=>run(async()=>{const name=prompt(translate("Yeni klasör adı"));if(!name)return;await request({kind:"fs_mkdir",path:join(dir,name),recursive:false});await list()});
 const move=()=>file&&run(async()=>{const destination=prompt(translate("Yeni yol (izinli klasörlerin içinde):"),file.path);if(!destination||destination===file.path)return;await request({kind:"fs_move",source:file.path,destination});setFile(null);await list()});
 const remove=()=>file&&run(async()=>{if(!confirm(translate("Bu dosya silinsin mi? Silme yüksek riskli bir işlemdir ve tek kullanımlık onayla yapılır.")+"\n"+file.path))return;await request({kind:"fs_delete",path:file.path,recursive:false},true);setFile(null);await list()});
 const search=(kind:"fs_search"|"text_search")=>run(async()=>{if(!query.trim())return;const d=await request({kind,path:dir,query:query.trim(),maxResults:200});setFound(JSON.stringify(d.items??d,null,2))});
 useEffect(()=>{if(online){setEntries(null);setFile(null);list(".")}},[request,online]);
 const dirty=!!file&&file.text&&file.content!==file.original;
 return <div className="grid lg:grid-cols-[minmax(0,.9fr)_minmax(0,1.1fr)] gap-5 mt-5">
  <Card><CardHeader><CardTitle>{translate("Gezgin")}</CardTitle><CardDescription>{translate("Klasöre girmek için tıkla; dosyayı açmak için seç.")}</CardDescription></CardHeader><CardContent className="grid gap-3">
   <form className="flex gap-2" onSubmit={e=>{e.preventDefault();list()}}><Button type="button" size="icon" variant="outline" aria-label={translate("Üst klasör")} disabled={busy||!online} onClick={()=>list(parent(dir))}><ArrowUp className="size-4"/></Button><Input aria-label={translate("Dizin yolu")} value={dir} onChange={e=>setDir(e.target.value)} className="font-mono"/><Button type="submit" size="icon" variant="outline" aria-label={translate("Yenile")} disabled={busy||!online}><RefreshCw className="size-4"/></Button><Button type="button" size="icon" variant="outline" aria-label={translate("Yeni klasör")} disabled={busy||!online} onClick={mkdir}><FolderPlus className="size-4"/></Button></form>
   {error&&<Alert tone="danger">{error}</Alert>}
   {!online?<EmptyState icon={Folder} title={translate("Cihaz çevrim dışı")}/>:entries===null?<Spinner/>:entries.length===0?<p className="text-sm muted">{translate("Klasör boş.")}</p>
   :<ul className="file-list" aria-label={translate("Dosyalar")}>{[...entries].sort((a,b)=>(a.type==="directory"?0:1)-(b.type==="directory"?0:1)||a.name.localeCompare(b.name)).map(e=><li key={e.path}><button type="button" className={file?.path===e.path?"active":""} onClick={()=>e.type==="directory"?list(e.path):open(e.path)}>{e.type==="directory"?<Folder className="size-4 text-[var(--accent)]" aria-hidden="true"/>:<File className="size-4 muted" aria-hidden="true"/>}<span className="truncate">{e.name}</span>{e.type!=="directory"&&typeof e.size==="number"&&<small className="ml-auto muted">{e.size.toLocaleString()} B</small>}</button></li>)}</ul>}
   <form className="flex gap-2 flex-wrap" onSubmit={e=>{e.preventDefault();search("fs_search")}}><Input className="flex-1 min-w-[160px]" aria-label={translate("Ara")} placeholder={translate("Dosya adı veya metin")} value={query} onChange={e=>setQuery(e.target.value)}/><Button type="submit" variant="outline" size="sm" disabled={busy||!online||!query.trim()}><Search className="size-4"/>{translate("Ad")}</Button><Button type="button" variant="outline" size="sm" disabled={busy||!online||!query.trim()} onClick={()=>search("text_search")}><Search className="size-4"/>{translate("İçerik")}</Button></form>
   {found&&<div className="relative"><pre className="approval-json !max-h-60">{found}</pre><Button size="icon" variant="ghost" className="absolute top-1 right-1" aria-label={translate("Kapat")} onClick={()=>setFound("")}><X className="size-4"/></Button></div>}
  </CardContent></Card>
  <Card><CardHeader className="flex flex-row items-start justify-between gap-3"><div className="min-w-0"><CardTitle className="truncate">{file?file.path.split(/[\\/]/).pop():translate("Dosya")}</CardTitle><CardDescription className={"truncate"+(file?" font-mono":"")}>{file?.path||translate("Soldan bir dosya seç.")}</CardDescription></div>{file&&<div className="flex gap-2 shrink-0"><Button size="sm" onClick={save} disabled={busy||!dirty}><Save className="size-4"/>{translate("Kaydet")}</Button><Button size="sm" variant="outline" onClick={move} disabled={busy}><MoveRight className="size-4"/>{translate("Taşı")}</Button><Button size="sm" variant="outline" onClick={remove} disabled={busy} aria-label={translate("Sil")}><Trash2 className="size-4"/></Button></div>}</CardHeader><CardContent>
   {!file?<EmptyState icon={File} title={translate("Açık dosya yok")}/>:!file.text?<p className="text-sm muted">{translate("İkili dosya, düzenlenemez.")} ({file.size.toLocaleString()} B)</p>
   :<textarea aria-label={translate("Dosya içeriği")} spellCheck={false} className="file-editor" value={file.content} onChange={e=>setFile({...file,content:e.target.value})}/>}
   {dirty&&<p className="text-xs text-[var(--warning)] mt-2">{translate("Kaydedilmemiş değişiklik var.")}</p>}
  </CardContent></Card>
 </div>;
}

type Task={taskId:string;status:string;createdAtMs?:string;finishedAtMs?:string|null};
export function TaskPanel({request,online}:{request:Request;online:boolean}){
 const [tasks,setTasks]=useState<Task[]|null>(null);
 const [command,setCommand]=useState("");
 const [cwd,setCwd]=useState("");
 const [detail,setDetail]=useState<Result|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const load=useCallback(async()=>{try{setTasks(((await request({kind:"task_list"})).items as Task[])||[])}catch(e){setError((e as Error).message)}},[request]);
 useEffect(()=>{if(online)load()},[online,load]);
 const start=async()=>{if(!command.trim())return;if(!confirm(translate("Bu görev cihazda arka planda çalıştırılacak. Görev başlatma yüksek riskli bir işlemdir ve tek kullanımlık onayla yapılır.")+"\n\n"+command))return;setBusy(true);setError("");try{const d=await request({kind:"task_start",command:command.trim(),timeoutMs:600000,...(cwd.trim()?{cwd:cwd.trim()}:{})},true);setCommand("");await load();await show(String(d.taskId))}catch(e){setError((e as Error).message)}finally{setBusy(false)}};
 const show=async(taskId:string)=>{try{setDetail(await request({kind:"task_status",taskId}))}catch(e){setError((e as Error).message)}};
 const cancel=async(taskId:string)=>{if(!confirm(translate("Görev iptal edilsin mi?")))return;try{await request({kind:"task_cancel",taskId},true);await load();await show(taskId)}catch(e){setError((e as Error).message)}};
 return <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5 mt-5">
  <Card><CardHeader><CardTitle>{translate("Yeni görev")}</CardTitle><CardDescription>{translate("Uzun süren komutlar arka planda çalışır ve bağlantı kopsa da devam eder.")}</CardDescription></CardHeader><CardContent className="grid gap-3">
   <form className="grid gap-3" onSubmit={e=>{e.preventDefault();start()}}><Input aria-label={translate("Komut")} placeholder="npm run build" className="font-mono" value={command} onChange={e=>setCommand(e.target.value)}/><Input aria-label={translate("Çalışma klasörü (isteğe bağlı)")} placeholder={translate("Çalışma klasörü (isteğe bağlı)")} className="font-mono" value={cwd} onChange={e=>setCwd(e.target.value)}/><Button type="submit" disabled={busy||!online||!command.trim()}><Play className="size-4"/>{busy?translate("Başlatılıyor…"):translate("Onayla ve başlat")}</Button></form>
   {error&&<Alert tone="danger">{error}</Alert>}
   <div className="flex items-center justify-between mt-2"><h3 className="text-sm font-semibold">{translate("Görevler")}</h3><Button size="sm" variant="ghost" onClick={load} disabled={!online}><RefreshCw className="size-4"/>{translate("Yenile")}</Button></div>
   {tasks===null?<Spinner/>:tasks.length===0?<p className="text-sm muted">{translate("Bu cihazda görev yok.")}</p>:<ul className="grid gap-2">{tasks.map(task=><li key={task.taskId} className="team-row"><button type="button" className="min-w-0 flex-1 text-left" onClick={()=>show(task.taskId)}><code className="text-xs">{task.taskId.slice(0,8)}…</code> <span className="text-xs muted">{task.createdAtMs?new Date(Number(task.createdAtMs)).toLocaleString():""}</span></button><Badge className={task.status==="completed"?"text-[var(--success)]":task.status==="running"?"text-[var(--accent)]":"text-[var(--danger)]"}>{task.status}</Badge>{task.status==="running"&&<Button size="sm" variant="ghost" aria-label={translate("İptal et")} onClick={()=>cancel(task.taskId)}><Square className="size-4"/></Button>}</li>)}</ul>}
  </CardContent></Card>
  <Card><CardHeader><CardTitle>{translate("Görev çıktısı")}</CardTitle></CardHeader><CardContent>{!detail?<EmptyState icon={Play} title={translate("Bir görev seç")}/>:<><p className="text-sm mb-2"><Badge>{String(detail.status)}</Badge>{detail.result&&<span className="muted ml-2">{translate("Çıkış kodu")}: {String(detail.result.exitCode)}</span>}</p><pre className="terminal-output">{String(detail.result?.stdout??"")}{detail.result?.stderr?"\n"+String(detail.result.stderr):""}{!detail.result&&translate("Görev çalışıyor…")}</pre></>}</CardContent></Card>
 </div>;
}

export function TerminalPanel({request,online}:{request:Request;online:boolean}){
 const [session,setSession]=useState("");
 const [output,setOutput]=useState("");
 const [line,setLine]=useState("");
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const box=useRef<HTMLPreElement>(null);
 useEffect(()=>{if(!session)return;let stop=false;const tick=async()=>{try{const d=await request({kind:"terminal_read",sessionId:session,maxBytes:65536});if(!stop&&d.text)setOutput(o=>(o+d.text).slice(-200_000))}catch(e){if(!stop){setError((e as Error).message);setSession("")}}};const timer=setInterval(tick,800);tick();return()=>{stop=true;clearInterval(timer)}},[session,request]);
 useEffect(()=>{box.current?.scrollTo({top:box.current.scrollHeight})},[output]);
 const start=async()=>{setBusy(true);setError("");try{const d=await request({kind:"terminal_start",cols:120,rows:30},true);setOutput("");setSession(String(d.sessionId))}catch(e){setError((e as Error).message)}finally{setBusy(false)}};
 const stop=async()=>{if(!session)return;setBusy(true);try{await request({kind:"terminal_stop",sessionId:session},true)}catch(e){setError((e as Error).message)}finally{setSession("");setBusy(false)}};
 const send=async(text:string)=>{if(!session)return;try{await request({kind:"terminal_input",sessionId:session,dataBase64:b64(text)})}catch(e){setError((e as Error).message)}};
 return <Card className="mt-5"><CardHeader className="flex flex-row items-start justify-between gap-3"><div><CardTitle>{translate("Etkileşimli terminal")}</CardTitle><CardDescription>{translate("Cihazda gerçek bir kabuk oturumu açar. Açma ve kapatma yüksek riskli işlemlerdir ve tek kullanımlık onayla yapılır.")}</CardDescription></div>{session?<Button variant="outline" size="sm" onClick={stop} disabled={busy}><Square className="size-4"/>{translate("Oturumu kapat")}</Button>:<Button size="sm" onClick={start} disabled={busy||!online}><Play className="size-4"/>{translate("Oturum aç")}</Button>}</CardHeader><CardContent className="grid gap-3">
  {error&&<Alert tone="danger">{error}</Alert>}
  <pre ref={box} className="terminal-output" aria-live="polite" aria-label={translate("Terminal çıktısı")}>{output||(session?translate("Bağlanıyor…"):translate("Oturum kapalı."))}</pre>
  <form className="flex gap-2" onSubmit={e=>{e.preventDefault();send(line+"\n");setLine("")}}><Input aria-label={translate("Terminal girdisi")} className="font-mono" placeholder={session?translate("Komut yaz ve Enter'a bas"):""} value={line} onChange={e=>setLine(e.target.value)} disabled={!session}/><Button type="submit" variant="outline" disabled={!session}>{translate("Gönder")}</Button><Button type="button" variant="ghost" disabled={!session} onClick={()=>send("\u0003")} title="Ctrl+C">^C</Button></form>
 </CardContent></Card>;
}
