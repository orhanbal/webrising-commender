import {useEffect,useState}from"react";
import{ArrowRight,Copy,ExternalLink,FileText,KeyRound,LockKeyhole,Monitor,RefreshCw,Search,ShieldCheck,TerminalSquare,Workflow,Play,Info}from"lucide-react";
import{api,type Account,type Device}from"../api";
import{Button,Card,CardContent,CardDescription,CardHeader,CardTitle,Input}from"../components/ui";
import{DashboardShell}from"./Dashboard";
import type{Nav,Theme}from"../App";
type Tool="terminal"|"files"|"tasks"|"mcp";
type DeviceResult={ok:boolean;data:unknown};
type Token={id:string;name:string;role:string;created_at:string;last_used_at?:string|null;revoked_at?:string|null};
const pages={
 terminal:{title:"Terminal",description:"Komutları kontrollü çalıştır ve sonuçlarını takip et.",icon:TerminalSquare},
 files:{title:"Dosyalar",description:"Cihazdaki dosyaları ve dizinleri güvenle incele.",icon:FileText},
 tasks:{title:"Görevler",description:"Çalışan görevleri görüntüle ve takip et.",icon:Workflow},
 mcp:{title:"MCP Araçları",description:"Yapay zekâ araçlarını güvenli erişim anahtarlarıyla bağla.",icon:KeyRound}
};
export function WorkspacePage({nav,path,account,checking,theme,toggle,logout}:{nav:Nav;path:Tool;account:Account|null;checking:boolean;theme:Theme;toggle:()=>void;logout:()=>void}){
 const page=pages[path];
 const [devices,setDevices]=useState<Device[]>([]);
 const [deviceId,setDeviceId]=useState(new URLSearchParams(location.search).get("device")||"");
 const [pathValue,setPathValue]=useState(".");
 const [command,setCommand]=useState("");
 const [result,setResult]=useState("");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [tokens,setTokens]=useState<Token[]>([]);
 const [tokenName,setTokenName]=useState("MCP İstemcim");
 const [tokenRole,setTokenRole]=useState("operator");
 const [newToken,setNewToken]=useState("");
 const [copyStatus,setCopyStatus]=useState("");
 const canAdmin=["admin","owner"].includes(account?.role||"")||account?.global===true;
 async function fetchDevices(){
  if(!account)return;
  try{const response=await api<{items:Device[]}>("/api/devices");setDevices(response.items.filter(d=>!d.revoked_at));setDeviceId(old=>response.items.some(d=>d.id===old)?old:(response.items.find(d=>d.online)?.id||response.items[0]?.id||""))}
  catch(e){setError(e instanceof Error?e.message:"Cihaz listesi alınamadı.")}
 }
 async function fetchTokens(){
  if(!account||!canAdmin)return;
  try{const response=await api<{items:Token[]}>("/api/tokens");setTokens(response.items)}
  catch(e){setError(e instanceof Error?e.message:"MCP anahtarları alınamadı.")}
 }
 useEffect(()=>{void fetchDevices();if(path==="mcp")void fetchTokens();setResult("");setError("")},[path,account?.organizationId]);
 async function call(action:Record<string,unknown>){
  if(!deviceId)return setError("Önce bir cihaz seçmelisiniz.");
  setBusy(true);setError("");setResult("");
  try{const response=await api<DeviceResult>("/api/device/request",{method:"POST",body:JSON.stringify({deviceId,action})});setResult(JSON.stringify(response.data,null,2))}
  catch(e){setError(e instanceof Error?e.message:"Cihaz işlemi başarısız oldu.")}
  finally{setBusy(false)}
 }
 async function runCommand(){
  if(!command.trim()||!deviceId)return;
  if(!canAdmin)return setError("Komut çalıştırmak için yönetici onayı gerekir. Terminal sekmesindeki gelişmiş konsoldan işlem başlatabilirsiniz.");
  if(!confirm("Bu komut seçili uzak cihazda çalıştırılacak.\n\n"+command+"\n\nOnaylıyor musunuz?"))return;
  setBusy(true);setError("");setResult("");
  const action={kind:"process_exec",command:command.trim(),timeoutMs:30000};
  try{
   const approved=await api<{approvalToken:string}>("/api/approvals",{method:"POST",body:JSON.stringify({deviceId,action})});
   const response=await api<DeviceResult>("/api/device/request",{method:"POST",body:JSON.stringify({deviceId,action,approvalToken:approved.approvalToken})});
   setResult(JSON.stringify(response.data,null,2));
  }catch(e){setError(e instanceof Error?e.message:"Komut çalıştırılamadı.")}
  finally{setBusy(false)}
 }
 async function createToken(){
  if(!account||!canAdmin)return;
  setBusy(true);setError("");setNewToken("");
  try{
   const response=await api<{token:string}>("/api/tokens",{method:"POST",body:JSON.stringify({name:tokenName.trim(),role:tokenRole})});
   setNewToken(response.token);await fetchTokens();
  }catch(e){setError(e instanceof Error?e.message:"Anahtar oluşturulamadı.")}
  finally{setBusy(false)}
 }
 async function revokeToken(item:Token){
  if(!confirm(item.name+" adlı erişim anahtarı iptal edilsin mi?"))return;
  setBusy(true);setError("");
  try{await api("/api/tokens/"+item.id+"/revoke",{method:"POST",body:"{}"});await fetchTokens()}
  catch(e){setError(e instanceof Error?e.message:"Erişim iptal edilemedi.")}
  finally{setBusy(false)}
 }
 async function copy(text:string){try{await navigator.clipboard.writeText(text);setCopyStatus("Kopyalandı.")}catch{setCopyStatus("Kopyalama başarısız.")}}
 const selected=devices.find(d=>d.id===deviceId);
 return <DashboardShell nav={nav}path={"/"+path}account={account}theme={theme}toggle={toggle}logout={logout}>
  <div className="flex items-end justify-between gap-3 flex-wrap"><div><span className="dash-kicker">ARAÇLAR</span><h1 className="dash-title mt-2 flex gap-3 items-center"><page.icon className="text-[var(--accent)]"/> {page.title}</h1><p className="muted mt-2 text-sm">{page.description}</p></div><Button variant="outline" onClick={()=>window.location.assign("/advanced?view="+path)}>Gelişmiş Konsol <ExternalLink size={16}/></Button></div>
  {error&&<div role="alert" className="form-error mt-5">{error}</div>}
  {!account&&!checking&&<Card className="mt-7 p-6"><h2 className="font-semibold">Önce giriş yapın</h2><p className="muted mt-2 text-sm">Cihaz ve araçlar oturum açıldıktan sonra erişilebilir.</p><Button className="mt-4" onClick={()=>nav("/login")}>Giriş Yap <ArrowRight size={16}/></Button></Card>}
  {account&&path!=="mcp"&&<div className="grid lg:grid-cols-[1fr_.9fr] gap-5 mt-7">
   <Card><CardHeader className="flex flex-row justify-between items-center"><div><CardTitle>Çalışma Ortamı</CardTitle><CardDescription>Komutlar yalnızca seçilen cihazda çalışır.</CardDescription></div><Button variant="ghost" size="icon" onClick={()=>void fetchDevices()} aria-label="Cihazları yenile"><RefreshCw size={16}/></Button></CardHeader><CardContent><label className="field-label" htmlFor="wcSelectDevice">Cihaz seç</label><select id="wcSelectDevice" value={deviceId} onChange={e=>{setDeviceId(e.target.value);setResult("")}} className="w-full h-11 rounded-xl border border-[var(--stroke)] bg-[var(--input)] px-4 text-sm">{!devices.length&&<option value="">Bağlı cihaz bulunamadı</option>}{devices.map(d=><option key={d.id}value={d.id}>{d.name} {d.online?"●":"○"}</option>)}</select><div className="my-5 flex gap-3 items-center"><div className="size-10 rounded-xl bg-[var(--subtle-surface)] grid place-items-center text-[var(--accent)]"><Monitor size={20}/></div><div><strong className="text-sm">{selected?.name||"Cihaz seçilmedi"}</strong><p className="text-xs muted">{selected?.platform||"—"} · {selected?.online?"Çevrimiçi":"Çevrimdışı"}</p></div></div>
   {path==="terminal"&&<><label htmlFor="wcCommand" className="field-label">Komut satırı</label><Input id="wcCommand" placeholder="Örn. pwd" value={command} onChange={e=>setCommand(e.target.value)} maxLength={32000}/><p className="text-xs muted mt-3">Komut çalıştırma yüksek risklidir ve yönetici onayı gerektirir. Yetkisiz cihazlarda çalıştırılamaz.</p><Button className="w-full mt-6" onClick={()=>void runCommand()}disabled={!deviceId||!selected?.online||busy||!command.trim()}><Play size={17}/> {busy?"Çalıştırılıyor…":"Komutu Onayla ve Çalıştır"}</Button></>}
   {path==="files"&&<><label htmlFor="wcPath" className="field-label">Dizin yolu</label><Input id="wcPath" placeholder="Örn. /home/user" value={pathValue} onChange={e=>setPathValue(e.target.value)}/><div className="flex gap-3 mt-5 flex-wrap"><Button disabled={!deviceId||!selected?.online||busy||!pathValue.trim()} onClick={()=>void call({kind:"fs_list",path:pathValue})}><Search size={16}/> Dosyaları Listele</Button><Button disabled={!deviceId||!selected?.online||busy||!pathValue.trim()} variant="outline" onClick={()=>void call({kind:"fs_tree",path:pathValue,maxDepth:2,maxEntries:150})}>Klasör Ağacı</Button></div><p className="text-xs muted mt-4">Okuma işlemleri güvenlik ve agent yetkileri dahilinde gerçekleştirilir. Taşıma, değiştirme ve silme için gelişmiş konsolu kullanın.</p></>}
   {path==="tasks"&&<><div className="flex gap-3 flex-wrap"><Button onClick={()=>void call({kind:"task_list"})} disabled={!deviceId||!selected?.online||busy}><RefreshCw size={17}/> Aktif Görevleri Listele</Button><Button variant="outline" onClick={()=>void call({kind:"process_list"})} disabled={!deviceId||!selected?.online||busy}>Çalışan İşlemler</Button></div><p className="text-sm muted mt-5">Yeni görev başlatma ve sonlandırma işlemleri için kullanıcı onayı ve uygun rol gerekir.</p></>}
   </CardContent></Card>
   <Card><CardHeader><CardTitle>İşlem Çıktısı</CardTitle><CardDescription>Yalnızca sizin seçtiğiniz cihazdan gelen gerçek sonuçlar gösterilir.</CardDescription></CardHeader><CardContent><div className="rounded-xl border border-[var(--stroke)] bg-[#0c0c0c] text-[#ebebeb] min-h-[260px] max-h-[520px] overflow-auto p-5"><pre aria-live="polite" className="whitespace-pre-wrap break-all text-[12px] leading-6 font-mono">{busy?"Çalıştırılıyor…":result||"İşleminizi başlattığınızda sonuçlar burada görüntülenecek."}</pre></div></CardContent></Card>
  </div>}
  {account&&path==="mcp"&&<div className="grid lg:grid-cols-[1.06fr_.94fr] gap-5 mt-7">
   <Card><CardHeader><CardTitle>API Erişim Anahtarları</CardTitle><CardDescription>AI istemcilerinize yalnızca gerekli yetkileri verin.</CardDescription></CardHeader><CardContent>{!canAdmin?<p className="muted text-sm">Anahtarları yönetmek için yönetici yetkisi gerekiyor.</p>:<><div className="grid sm:grid-cols-[1fr_130px] gap-3"><label className="field-label">Anahtar adı<Input className="mt-2" value={tokenName} onChange={e=>setTokenName(e.target.value)} maxLength={120}/></label><label className="field-label">Rol<select className="w-full mt-2 h-11 rounded-xl border border-[var(--stroke)] bg-[var(--input)] px-3 text-sm" value={tokenRole} onChange={e=>setTokenRole(e.target.value)}>{["viewer","operator","admin","owner"].filter(r=>r==="viewer"||r==="operator"||account.role==="owner").map(r=><option key={r}value={r}>{r}</option>)}</select></label></div><Button className="mt-4"disabled={busy||tokenName.trim().length<2} onClick={()=>void createToken()}><KeyRound size={17}/> Erişim Anahtarı Oluştur</Button></>}
   {newToken&&<div className="mt-6 p-4 border border-[var(--accent)] rounded-xl"><p className="text-sm font-semibold mb-2">Anahtar yalnızca bir kez gösterilir</p><div className="flex gap-3"><code className="select-all break-all flex-1 text-xs">{newToken}</code><Button size="icon" variant="outline" onClick={()=>void copy(newToken)} aria-label="API anahtarını kopyala"><Copy size={16}/></Button></div><small className="muted mt-2 block">Bu anahtarı gizli saklayın. Başka kullanıcılarla paylaşmayın.</small></div>}
   {copyStatus&&<p className="text-sm text-[var(--accent)] mt-3">{copyStatus}</p>}
   <div className="mt-6 divide-y divide-[var(--stroke)]">{tokens.filter(t=>!t.revoked_at).map(t=><div className="py-4 flex items-center gap-3" key={t.id}><KeyRound size={19} className="text-[var(--accent)]"/><div className="flex-1"><strong className="text-sm">{t.name}</strong><small className="block muted">{t.role} · Son kullanım {t.last_used_at?new Date(t.last_used_at).toLocaleDateString("tr-TR"):"yok"}</small></div><Button size="sm" variant="danger" disabled={busy} onClick={()=>void revokeToken(t)}>İptal Et</Button></div>)}{!tokens.length&&<p className="muted text-sm py-4">Henüz erişim anahtarı yok.</p>}</div></CardContent></Card>
   <Card><CardHeader><CardTitle>Güvenli MCP Bağlantısı</CardTitle><CardDescription>AI araçları için kontrollü erişim</CardDescription></CardHeader><CardContent><div className="grid gap-4 text-sm muted"><div className="flex gap-3"><ShieldCheck size={20} className="text-[var(--accent)] shrink-0"/><span>Token izinlerini görev için gereken en düşük yetkide oluşturun.</span></div><div className="flex gap-3"><LockKeyhole size={20} className="text-[var(--accent)] shrink-0"/><span>İstemcinizi WECOMMANDER’ın MCP uç noktasına bağlayın. Token yalnızca oluştururken gösterilir.</span></div><div className="flex gap-3"><Info size={20} className="text-[var(--accent)] shrink-0"/><span>Yüksek riskli cihaz aksiyonlarında kullanıcı onayı gerekir; işlem kayıtları tutulur.</span></div></div><div className="mt-6 p-4 bg-[var(--subtle-surface)] rounded-xl border border-[var(--stroke)]"><p className="text-xs muted mb-2">MCP sunucu adresi</p><code className="text-xs break-all">{location.origin+"/mcp"}</code><Button className="mt-3 w-full" size="sm" variant="outline" onClick={()=>void copy(location.origin+"/mcp")}><Copy size={15}/> Adresi Kopyala</Button></div></CardContent></Card>
  </div>}
 </DashboardShell>;
}
