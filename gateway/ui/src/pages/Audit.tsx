import {useCallback,useEffect,useMemo,useState} from "react";
import {ScrollText} from "lucide-react";
import {t as translate,useLocale,localizedDate} from "../i18n";
import {api,type Account,type Device} from "../api";
import {Alert,Badge,Button,Card,CardContent,EmptyState,Input,PageHeader,Skeleton} from "../components/ui";
import {DashboardShell} from "./Dashboard";
import type {Nav,Theme} from "../App";

// Workspace audit log (v1.1 item 5e), moved from the legacy /advanced console.
// The server returns the newest 200 entries for admins; filtering is local.
type Entry={id:string;actor:string;device_id:string|null;tool:string;risk:string;outcome:string;detail:string|null;created_at:string};
const riskTone:Record<string,string>={low:"",medium:"text-[var(--accent)]",high:"text-[var(--warning)]",critical:"text-[var(--danger)]"};
const outcomeTone=(o:string)=>/success|trusted|consumed/.test(o)?"text-[var(--success)]":/denied|error|refused/.test(o)?"text-[var(--danger)]":/pending/.test(o)?"text-[var(--warning)]":"";
const PAGE=25;

export function AuditPage({nav,account,checking,theme,toggle,logout}:{nav:Nav;account:Account|null;checking:boolean;theme:Theme;toggle:()=>void;logout:()=>void}){
 useLocale();
 const [items,setItems]=useState<Entry[]|null>(null);
 const [devices,setDevices]=useState<Device[]>([]);
 const [error,setError]=useState("");
 const [forbidden,setForbidden]=useState(false);
 const [query,setQuery]=useState("");
 const [risk,setRisk]=useState("all");
 const [page,setPage]=useState(0);
 const load=useCallback(async()=>{try{const [a,d]=await Promise.all([api<{items:Entry[]}>("/api/audit?limit=200"),api<{items:Device[]}>("/api/devices")]);setItems(a.items);setDevices(d.items);setError("")}catch(e){const m=(e as Error).message;if(/forbidden/i.test(m)){setForbidden(true);setItems([])}else setError(m)}},[]);
 useEffect(()=>{if(account)load()},[account,load]);
 const names=useMemo(()=>new Map(devices.map(d=>[d.id,d.name])),[devices]);
 const filtered=useMemo(()=>(items||[]).filter(x=>(risk==="all"||x.risk===risk)&&(!query||[x.actor,x.tool,x.outcome,x.detail,x.device_id&&names.get(x.device_id)].some(v=>String(v||"").toLowerCase().includes(query.toLowerCase())))),[items,risk,query,names]);
 useEffect(()=>setPage(0),[risk,query]);
 if(!checking&&!account){nav("/login");return null}
 const pages=Math.max(1,Math.ceil(filtered.length/PAGE));
 const shown=filtered.slice(page*PAGE,(page+1)*PAGE);
 return <DashboardShell nav={nav} path="/audit" account={account} theme={theme} toggle={toggle} logout={logout}>
  <PageHeader kicker={translate("ÇALIŞMA ALANI")} title={translate("Denetim kaydı")} description={translate("Yapay zekâ çağrıları, onaylar ve yönetim değişiklikleri: kim, hangi cihazda, ne yaptı. Dosya içerikleri kaydedilmez.")} actions={<Button size="sm" variant="outline" onClick={load}>{translate("Yenile")}</Button>}/>
  <div className="grid gap-5 mt-8">
   {error&&<Alert tone="danger" title={translate("İşlem tamamlanamadı")}>{error}</Alert>}
   {forbidden?<Alert tone="info" title={translate("Yönetici yetkisi gerekiyor")}>{translate("Denetim kaydını yalnızca çalışma alanı sahipleri ve yöneticileri görebilir.")}</Alert>:
   <Card><CardContent className="pt-6 grid gap-4">
    <div className="flex flex-wrap gap-3"><Input className="flex-1 min-w-[200px]" aria-label={translate("Kayıtlarda ara")} placeholder={translate("Kişi, araç, cihaz veya sonuç ara…")} value={query} onChange={e=>setQuery(e.target.value)}/>
     <select aria-label={translate("Risk")} className="h-11 rounded-xl border border-[var(--stroke)] bg-[var(--input)] px-3 text-sm" value={risk} onChange={e=>setRisk(e.target.value)}><option value="all">{translate("Tüm riskler")}</option><option value="low">{translate("Düşük")}</option><option value="medium">{translate("Orta")}</option><option value="high">{translate("Yüksek")}</option><option value="critical">{translate("Kritik")}</option></select></div>
    {items===null?<div className="grid gap-2" aria-busy="true"><Skeleton className="h-10"/><Skeleton className="h-10"/><Skeleton className="h-10"/></div>
    :filtered.length===0?<EmptyState icon={ScrollText} title={translate("Kayıt yok")} description={translate("Filtreye uyan bir kayıt bulunamadı.")}/>
    :<div className="overflow-x-auto rounded-xl border border-[var(--stroke)]"><table className="console-table w-full min-w-[760px] text-sm text-left"><thead><tr>{["Zaman","Kişi","Cihaz","Araç","Risk","Sonuç","Ayrıntı"].map(h=><th key={h} className="px-3 py-3 border-b border-[var(--stroke)] font-semibold">{translate(h)}</th>)}</tr></thead>
     <tbody>{shown.map(x=><tr key={x.id}><td data-label={translate("Zaman")} className="px-3 py-2 border-b border-[var(--stroke)] whitespace-nowrap">{localizedDate(x.created_at,{dateStyle:"short",timeStyle:"medium"})}</td><td data-label={translate("Kişi")} className="px-3 py-2 border-b border-[var(--stroke)]">{x.actor}</td><td data-label={translate("Cihaz")} className="px-3 py-2 border-b border-[var(--stroke)]">{x.device_id?(names.get(x.device_id)||x.device_id.slice(0,8)+"…"):"—"}</td><td data-label={translate("Araç")} className="px-3 py-2 border-b border-[var(--stroke)] font-mono">{x.tool}</td><td data-label={translate("Risk")} className={"px-3 py-2 border-b border-[var(--stroke)] font-semibold "+(riskTone[x.risk]||"")}>{x.risk}</td><td data-label={translate("Sonuç")} className="px-3 py-2 border-b border-[var(--stroke)]"><Badge className={outcomeTone(x.outcome)}>{x.outcome}</Badge></td><td data-label={translate("Ayrıntı")} className="px-3 py-2 border-b border-[var(--stroke)] max-w-[320px] truncate" title={x.detail||""}>{x.detail||"—"}</td></tr>)}</tbody></table></div>}
    {filtered.length>PAGE&&<div className="flex items-center justify-end gap-3 text-sm"><Button size="sm" variant="outline" disabled={page===0} onClick={()=>setPage(p=>p-1)}>{translate("Önceki")}</Button><span className="muted">{page+1} / {pages} · {filtered.length} {translate("kayıt")}</span><Button size="sm" variant="outline" disabled={page+1>=pages} onClick={()=>setPage(p=>p+1)}>{translate("Sonraki")}</Button></div>}
    <p className="text-xs muted">{translate("En yeni 200 kayıt gösterilir.")}</p>
   </CardContent></Card>}
  </div>
 </DashboardShell>;
}
