import {useEffect,useState,type ReactNode} from "react";
import {ExternalLink} from "../components/icons";
import {api} from "../api";
import {useLocale} from "../i18n";
import {consoleText} from "../console-text";
import {AdminTable,Panel,Pill,When,fieldClass,smallButton,type Column,type Tone} from "./ConsoleParts";
import {cn} from "../lib";

/**
 * Console > Growth (Büyüme). Every number here comes from daily aggregate
 * counters: no cookies, no visitor identifiers, no third-party scripts.
 */
export const growthPages:Record<string,string>={
 "Growth overview":"overview","Traffic & sources":"traffic","AI crawlers":"crawlers","AI connections":"connections",
 Downloads:"downloads","Usage & retention":"usage",Feedback:"feedback",Directories:"directories",
};

type Any=Record<string,any>;
type KeyCount={key:string;count:number};

function useText(){
 const locale:"en"|"tr"=useLocale()==="tr"?"tr":"en";
 const ui=(source:string)=>consoleText(source,locale);
 const tag=locale==="tr"?"tr-TR":"en-US";
 const n=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?v.toLocaleString(tag):"—";
 const day=(d:string)=>new Date(d+"T00:00:00Z").toLocaleDateString(tag,{day:"numeric",month:"short",timeZone:"UTC"});
 return {ui,locale,tag,n,day};
}

/** Tiny line chart for KPI cards. */
export function Sparkline({values,className}:{values:number[];className?:string}){
 if(values.length<2)return null;
 const w=120,h=32,max=Math.max(1,...values);
 const points=values.map((v,i)=>`${(i/(values.length-1))*w},${h-2-(v/max)*(h-4)}`).join(" ");
 return <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" className={cn("block h-8 w-full text-[var(--accent)]",className)}>
  <polygon points={`0,${h} ${points} ${w},${h}`} fill="currentColor" opacity=".12"/>
  <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round"/>
 </svg>;
}

/** Daily column chart; each column has a tooltip with the day and the count. */
function DailyBars({values,days,label}:{values:number[];days:string[];label:string}){
 const {n,day,ui}=useText();
 const max=Math.max(1,...values);
 if(values.length===0)return null;
 return <figure className="m-0">
  <div className="flex h-36 items-end gap-[2px]" role="img" aria-label={label}>
   {values.map((v,i)=><div key={i} title={`${day(days[i]??"")}: ${n(v)}`} className="flex-1 min-w-0 rounded-t-sm bg-[var(--accent)]" style={{height:`${Math.max(v>0?3:1,(v/max)*100)}%`,opacity:v>0?1:.25}}/>)}
  </div>
  <figcaption className="mt-2 flex justify-between text-xs text-[var(--muted)]"><span>{day(days[0]??"")}</span><span className="tabular-nums">{ui("max")} {n(max)}</span><span>{day(days[days.length-1]??"")}</span></figcaption>
 </figure>;
}

/** Ranked horizontal bars (label, bar, count); wraps safely on phones. */
function BarList({rows,label,empty,format}:{rows:Array<{key:string;count:number}>;label:(k:string)=>ReactNode;empty:string;format?:(row:{key:string;count:number})=>ReactNode}){
 const {n}=useText();
 if(rows.length===0)return <p className="text-sm text-[var(--muted)]">{empty}</p>;
 const max=Math.max(1,...rows.map(r=>r.count));
 return <ul className="grid gap-2">{rows.map(r=><li key={r.key} className="min-w-0">
  <div className="flex items-baseline justify-between gap-3 text-sm"><span className="min-w-0 truncate" title={r.key}>{label(r.key)}</span><span className="shrink-0 tabular-nums text-[var(--muted)]">{format?format(r):n(r.count)}</span></div>
  <div className="mt-1 h-1.5 rounded-full bg-[var(--subtle-surface)]"><div className="h-1.5 rounded-full bg-[var(--accent)]" style={{width:`${(r.count/max)*100}%`}}/></div>
 </li>)}</ul>;
}

function Kpi({label,value,hint,spark,tone="accent"}:{label:string;value:ReactNode;hint?:ReactNode;spark?:number[];tone?:Tone}){
 return <section className="min-w-0 rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-5">
  <div className="text-sm text-[var(--muted)]">{label}</div>
  <div className={cn("mt-2 text-3xl font-bold tracking-tight tabular-nums break-words",tone==="success"&&"text-[var(--success)]",tone==="warning"&&"text-[var(--warning)]",tone==="danger"&&"text-[var(--danger)]")}>{value}</div>
  {hint&&<div className="mt-1 text-xs text-[var(--muted)]">{hint}</div>}
  {spark&&<div className="mt-3"><Sparkline values={spark}/></div>}
 </section>;
}

const clientNames:Record<string,string>={claude:"Claude",chatgpt:"ChatGPT",cursor:"Cursor",vscode:"VS Code / Copilot",windsurf:"Windsurf",api_token:"API token",web:"Web",app:"App",other:"Other"};
const platformNames:Record<string,string>={windows:"Windows",macos:"macOS",linux:"Linux",unknown:"—"};
const platformLabel=(k:string)=>{const [p,f]=k.split(":");return (platformNames[p??""]??p)+(f?` · ${f}`:"")};

export function Growth({page}:{page:string}){
 const {ui,n,locale}=useText();
 const endpoint=growthPages[page]??"overview";
 const [days,setDays]=useState(7);
 const [data,setData]=useState<Any|null>(null);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(true);
 const [reload,setReload]=useState(0);
 useEffect(()=>{
  let active=true;setBusy(true);setError("");
  api<Any>(`/api/console/growth/${endpoint}?days=${days}`).then(d=>{if(active)setData(d)}).catch(e=>{if(active){setError(String(e));setData(null)}}).finally(()=>{if(active)setBusy(false)});
  return()=>{active=false};
 },[endpoint,days,reload]);
 const bucketName=(k:string)=>ui(({ai:"AI assistants",search:"Search engines",social:"Social",direct:"Direct",other:"Other websites"} as Record<string,string>)[k]??k);
 const empty=ui("No data in this period yet.");
 const range=endpoint!=="directories"&&<div className="flex flex-wrap items-center gap-2" role="group" aria-label={ui("Date range")}>
  {[7,30,90].map(d=><button key={d} type="button" aria-pressed={days===d} onClick={()=>setDays(d)} className={cn(smallButton,days===d&&"border-[var(--accent)] text-[var(--accent)]")}>{d} {ui("days")}</button>)}
 </div>;
 let body:ReactNode=null;
 if(data){
  const r=data.range as string[]|undefined??[];
  if(endpoint==="overview")body=<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
   <Kpi label={ui("Visits")} value={n(data.visits.total)} hint={`${n(data.pageViews)} ${ui("page views")}`} spark={data.visits.series}/>
   <Kpi label={ui("AI-referred visits")} value={n(data.aiVisits.total)} hint={data.visits.total?`${Math.round(data.aiVisits.total/data.visits.total*100)}% ${ui("of visits")}`:undefined} spark={data.aiVisits.series}/>
   <Kpi label={ui("Downloads")} value={n(data.downloads.total)} hint={`${n(data.downloads.allTime)} ${ui("all time")}`} spark={data.downloads.series}/>
   <Kpi label={ui("Sign-ups")} value={n(data.signups.total)} spark={data.signups.series}/>
   <Kpi label={ui("Active users (day / week / month)")} value={`${n(data.active.dau)} / ${n(data.active.wau)} / ${n(data.active.mau)}`} hint={ui("Sign-ins, web sessions and app contact")}/>
   <Kpi label={ui("Active devices")} value={n(data.devices.online)} hint={`${n(data.devices.active7d)} ${ui("in the last 7 days")}`}/>
   <Kpi label="NPS" value={data.nps.score===null?"—":String(data.nps.score)} hint={`${n(data.nps.responses)} ${ui("responses")}`} tone={data.nps.score===null?"accent":data.nps.score>=30?"success":data.nps.score>=0?"warning":"danger"}/>
  </div>;
  if(endpoint==="traffic")body=<div className="grid gap-5">
   <Panel title={ui("Visits per day")} description={ui("Visits are arrivals from outside the site; page views include moving between pages.")}><DailyBars values={data.visits.series} days={r} label={ui("Visits per day")}/></Panel>
   <div className="grid gap-5 lg:grid-cols-2">
    <Panel title={ui("Where visits come from")}><BarList rows={data.buckets} label={bucketName} empty={empty}/></Panel>
    <Panel title={ui("AI assistants")} description={ui("Visits sent by AI assistants (referrer or utm_source).")}><BarList rows={data.ai} label={k=>k} empty={empty}/><div className="mt-4"><Sparkline values={data.aiSeries}/></div></Panel>
   </div>
   <Panel flush title={ui("Sources")}>
    {data.sources.length===0?<p className="px-5 pb-5 text-sm text-[var(--muted)]">{empty}</p>:<AdminTable rows={data.sources as Any[]} rowKey={x=>x.bucket+x.source} columns={[
     {key:"source",label:ui("Source"),render:x=><span className="break-all">{x.source}</span>},
     {key:"bucket",label:ui("Type"),render:x=><Pill tone={x.bucket==="ai"?"accent":"neutral"}>{bucketName(x.bucket)}</Pill>},
     {key:"count",label:ui("Visits"),className:"text-right tabular-nums",render:x=>n(x.count)},
    ]}/>}
   </Panel>
   <div className="grid gap-5 lg:grid-cols-2">
    <Panel title={ui("Most viewed pages")}><BarList rows={data.pages} label={k=><code className="font-mono text-xs">{k}</code>} empty={empty}/></Panel>
    <Panel title={ui("Landing pages")}><BarList rows={data.landings} label={k=><code className="font-mono text-xs">{k}</code>} empty={empty}/></Panel>
   </div>
   <div className="grid gap-5 lg:grid-cols-3">
    <Panel title="utm_source"><BarList rows={data.utmSource} label={k=>k} empty={empty}/></Panel>
    <Panel title="utm_medium"><BarList rows={data.utmMedium} label={k=>k} empty={empty}/></Panel>
    <Panel title="utm_campaign"><BarList rows={data.utmCampaign} label={k=>k} empty={empty}/></Panel>
   </div>
  </div>;
  if(endpoint==="crawlers")body=<div className="grid gap-5">
   <Panel title={ui("Crawler requests per day")} description={`${n(data.total)} ${ui("requests")}`}><DailyBars values={data.series} days={r} label={ui("Crawler requests per day")}/></Panel>
   <div className="grid gap-5 lg:grid-cols-2">
    <Panel flush title={ui("Crawlers")}>
     {data.crawlers.length===0?<p className="px-5 pb-5 text-sm text-[var(--muted)]">{empty}</p>:<AdminTable rows={data.crawlers as Any[]} rowKey={x=>x.key} columns={[
      {key:"name",label:ui("Crawler"),render:x=><span className="font-medium">{x.key}</span>},
      {key:"trend",label:ui("Trend"),render:x=><div className="w-28"><Sparkline values={x.series}/></div>},
      {key:"count",label:ui("Requests"),className:"text-right tabular-nums",render:x=>n(x.count)},
     ]}/>}
    </Panel>
    <Panel title={ui("What they read")} description={ui("llms.txt, sitemap, robots.txt, public pages and the MCP endpoint.")}><BarList rows={data.paths} label={k=><code className="font-mono text-xs">{k}</code>} empty={empty}/></Panel>
   </div>
   <Panel flush title={ui("Crawler and page")}>
    {data.detail.length===0?<p className="px-5 pb-5 text-sm text-[var(--muted)]">{empty}</p>:<AdminTable rows={data.detail as Any[]} rowKey={x=>x.crawler+x.path} columns={[
     {key:"crawler",label:ui("Crawler"),render:x=>x.crawler},
     {key:"path",label:ui("Path"),render:x=><code className="font-mono text-xs break-all">{x.path}</code>},
     {key:"count",label:ui("Requests"),className:"text-right tabular-nums",render:x=>n(x.count)},
    ]}/>}
   </Panel>
  </div>;
  if(endpoint==="connections")body=<div className="grid gap-5">
   <Panel flush title={ui("Connected AI clients")} description={ui("People and workspaces with a valid OAuth connection, per AI client (from the client's redirect address).")}>
    {data.clients.length===0?<p className="px-5 pb-5 text-sm text-[var(--muted)]">{empty}</p>:<AdminTable rows={data.clients as Any[]} rowKey={x=>x.kind} columns={[
     {key:"kind",label:ui("AI client"),render:x=><span className="font-medium">{clientNames[x.kind]?ui(clientNames[x.kind]!):x.kind}</span>},
     {key:"users",label:ui("Users"),className:"text-right tabular-nums",render:x=>n(x.users)},
     {key:"workspaces",label:ui("Workspaces"),className:"text-right tabular-nums",render:x=>n(x.workspaces)},
     {key:"new",label:ui("New in period"),className:"text-right tabular-nums",render:x=>n(x.newUsers)},
     {key:"last",label:ui("Last connected"),render:x=><When value={x.lastConnected} locale={locale} empty="—"/>},
    ]}/>}
   </Panel>
   <div className="grid gap-5 lg:grid-cols-2">
    <Panel title={ui("MCP tool calls per day")}><DailyBars values={data.callSeries} days={r} label={ui("MCP tool calls per day")}/></Panel>
    <Panel title={ui("Tool calls by client")}><BarList rows={data.calls} label={k=>clientNames[k]?ui(clientNames[k]!):k} empty={empty}/></Panel>
   </div>
  </div>;
  if(endpoint==="downloads"){
   const live=data.live as Any|null;
   const toRows=(o:Record<string,number>|undefined):KeyCount[]=>Object.entries(o??{}).map(([key,count])=>({key,count})).sort((a,b)=>b.count-a.count);
   body=<div className="grid gap-5">
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
     <Kpi label={ui("Downloads in period")} value={n(data.daily.total)} spark={data.daily.series}/>
     <Kpi label={ui("All-time downloads")} value={live?n(live.total):"—"} hint={live?ui("GitHub release assets"):ui("GitHub is not reachable right now.")}/>
     <Kpi label={ui("Install script fetches")} value={n(data.installs.total)} spark={data.installs.series}/>
    </div>
    <Panel title={ui("Downloads per day")} description={ui("From a daily snapshot of the GitHub release download counts.")}><DailyBars values={data.daily.series} days={r} label={ui("Downloads per day")}/></Panel>
    <div className="grid gap-5 lg:grid-cols-3">
     <Panel title={ui("By platform (all time)")}><BarList rows={toRows(live?.byPlatform)} label={platformLabel} empty={empty}/></Panel>
     <Panel title={ui("By package (all time)")}><BarList rows={toRows(live?.byFormat)} label={platformLabel} empty={empty}/></Panel>
     <Panel title={ui("By platform (period)")}><BarList rows={data.daily.byPlatform} label={platformLabel} empty={empty}/></Panel>
    </div>
    <div className="grid gap-5 lg:grid-cols-2">
     <Panel flush title={ui("By version")}>
      {!live||live.byVersion.length===0?<p className="px-5 pb-5 text-sm text-[var(--muted)]">{empty}</p>:<AdminTable rows={(live.byVersion as Any[]).slice(0,20)} rowKey={x=>x.tag} columns={[
       {key:"tag",label:ui("Version"),render:x=><code className="font-mono text-xs">{x.tag}</code>},
       {key:"date",label:ui("Published"),render:x=><When value={x.publishedAt} locale={locale} empty="—"/>},
       {key:"count",label:ui("Downloads"),className:"text-right tabular-nums",render:x=>n(x.total)},
      ]}/>}
     </Panel>
     <Panel title={ui("Install scripts")}><BarList rows={data.installs.byScript} label={k=><code className="font-mono text-xs">{k}</code>} empty={empty}/></Panel>
    </div>
   </div>;
  }
  if(endpoint==="usage"){
   const funnelNames:Record<string,string>={visits:"Visits",downloads:"Downloads",signups:"Sign-ups",first_device:"First device",paid:"Paid"};
   const funnel=data.funnel as Array<{step:string;count:number}>;
   body=<div className="grid gap-5">
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
     <Kpi label={ui("Daily active users")} value={n(data.active.dau)}/>
     <Kpi label={ui("Weekly active users")} value={n(data.active.wau)}/>
     <Kpi label={ui("Monthly active users")} value={n(data.active.mau)}/>
    </div>
    <div className="grid gap-5 lg:grid-cols-2">
     <Panel title={ui("Sign-ups per day")} description={`${n(data.signups.total)} ${ui("in period")}`}><DailyBars values={data.signups.series} days={r} label={ui("Sign-ups per day")}/></Panel>
     <Panel title={ui("Desktop apps active per day")}><DailyBars values={data.appsDaily} days={r} label={ui("Desktop apps active per day")}/></Panel>
    </div>
    <Panel title={ui("Funnel")} description={ui("Visits and downloads in the period; sign-ups in the period and how many of them added a device or pay.")}>
     <BarList rows={funnel.map(f=>({key:f.step,count:f.count}))} label={k=>ui(funnelNames[k]??k)} empty={empty}
      format={row=>{const i=funnel.findIndex(f=>f.step===row.key);const prev=i>0?funnel[i-1]!.count:0;return <>{n(row.count)}{i>0&&prev>0?<span className="ml-2 text-xs">({Math.round(row.count/prev*100)}%)</span>:null}</>}}/>
    </Panel>
    <div className="grid gap-5 lg:grid-cols-3">
     <Panel title={ui("Apps by platform")}><BarList rows={data.appsByPlatform} label={k=>platformNames[k]??k} empty={empty}/></Panel>
     <Panel title={ui("Apps by version")}><BarList rows={data.appsByVersion} label={k=>k} empty={empty}/></Panel>
     <Panel title={ui("Apps by language")}><BarList rows={data.appsByLanguage} label={k=>k} empty={empty}/></Panel>
    </div>
    <Panel flush title={ui("Devices by platform")}>
     {data.devices.length===0?<p className="px-5 pb-5 text-sm text-[var(--muted)]">{empty}</p>:<AdminTable rows={data.devices as Any[]} rowKey={x=>x.platform} columns={[
      {key:"platform",label:ui("Platform"),render:x=><Pill>{platformNames[x.platform]??x.platform}</Pill>},
      {key:"online",label:ui("Online"),className:"text-right tabular-nums",render:x=>n(x.online)},
      {key:"active",label:ui("Active 7 days"),className:"text-right tabular-nums",render:x=>n(x.active7d)},
      {key:"total",label:ui("Registered"),className:"text-right tabular-nums",render:x=>n(x.total)},
     ]}/>}
    </Panel>
    <Panel flush title={ui("Retention by sign-up week")} description={ui("Share of each week's sign-ups that were active 7 and 30 days after signing up (only accounts old enough are counted).")}>
     {data.retention.length===0?<p className="px-5 pb-5 text-sm text-[var(--muted)]">{empty}</p>:<AdminTable rows={data.retention as Any[]} rowKey={x=>x.week} columns={[
      {key:"week",label:ui("Week of"),render:x=>x.week},
      {key:"signups",label:ui("Sign-ups"),className:"text-right tabular-nums",render:x=>n(x.signups)},
      {key:"d7",label:ui("Day 7"),className:"text-right tabular-nums",render:x=>x.d7Rate===null?"—":`${x.d7Rate}% (${n(x.d7)}/${n(x.d7Eligible)})`},
      {key:"d30",label:ui("Day 30"),className:"text-right tabular-nums",render:x=>x.d30Rate===null?"—":`${x.d30Rate}% (${n(x.d30)}/${n(x.d30Eligible)})`},
     ]}/>}
    </Panel>
   </div>;
  }
  if(endpoint==="feedback")body=<div className="grid gap-5">
   <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
    <Kpi label="NPS" value={data.nps.score===null?"—":String(data.nps.score)} hint={`${n(data.nps.responses)} ${ui("responses")}`}/>
    <Kpi label={ui("Satisfaction (1–5)")} value={data.csat.average===null?"—":String(data.csat.average)} hint={`${n(data.csat.responses)} ${ui("responses")}`}/>
    <Kpi label={ui("App error reports")} value={n((data.errors as Any[]).reduce((s,e)=>s+e.total,0))}/>
   </div>
   <div className="grid gap-5 lg:grid-cols-2">
    <Panel title={ui("NPS by week")}><BarList rows={(data.nps.trend as Any[]).map(t=>({key:t.week,count:Math.max(0,(t.score??0)+100)}))} label={k=>k} empty={empty}
     format={row=>{const t=(data.nps.trend as Any[]).find(x=>x.week===row.key);return t?`${t.score} · ${n(t.responses)}`:""}}/></Panel>
    <Panel title={ui("NPS score distribution")}><BarList rows={(data.nps.distribution as Any[]).map(d=>({key:String(d.score),count:d.n}))} label={k=>k} empty={empty}/></Panel>
   </div>
   <Panel flush title={ui("Comments")}>
    {data.comments.length===0?<p className="px-5 pb-5 text-sm text-[var(--muted)]">{empty}</p>:<ul className="divide-y divide-[var(--stroke)] border-t border-[var(--stroke)]">{(data.comments as Any[]).map((c,i)=><li key={i} className="px-5 py-3">
     <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]"><Pill tone={c.kind==="nps"?"accent":"info"}>{c.kind==="nps"?"NPS":"CSAT"} {c.score??"—"}</Pill><span>{platformNames[c.platform]??c.platform}</span><When value={c.updatedAt} locale={locale} empty="—"/></div>
     <p className="mt-1 text-sm whitespace-pre-wrap break-words">{c.comment}</p>
     <p className="mt-1 text-xs text-[var(--faint)] truncate">{c.title}</p>
    </li>)}</ul>}
   </Panel>
   <Panel flush title={ui("App error reports")} description={ui("Grouped by message, most frequent first.")}>
    {data.errors.length===0?<p className="px-5 pb-5 text-sm text-[var(--muted)]">{empty}</p>:<AdminTable rows={data.errors as Any[]} rowKey={x=>x.message} columns={[
     {key:"message",label:ui("Message"),render:x=><span className="break-words text-sm">{x.message}</span>},
     {key:"where",label:ui("Platform / build"),render:x=><div className="flex flex-wrap gap-1">{(x.breakdown as Any[]).slice(0,6).map(b=><Pill key={b.platform+b.build}>{(platformNames[b.platform]??b.platform)+" "+b.build+" · "+n(b.count)}</Pill>)}</div>},
     {key:"count",label:ui("Reports"),className:"text-right tabular-nums",render:x=>n(x.total)},
     {key:"last",label:ui("Last seen"),render:x=><When value={x.lastAt} locale={locale} empty="—"/>},
    ]}/>}
   </Panel>
  </div>;
  if(endpoint==="directories")body=<Directories data={data} onSaved={()=>setReload(v=>v+1)}/>;
 }
 return <div className="grid gap-5 min-w-0">
  {range}
  {busy&&!data&&<p className="text-sm text-[var(--muted)]">{ui("Loading records…")}</p>}
  {error&&<p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
  {body}
  <p className="text-xs text-[var(--faint)]">{ui("Privacy: daily totals only. No cookies, no IP addresses, no visitor identifiers. Days are in UTC.")}</p>
 </div>;
}

const statusTone:Record<string,Tone>={not_submitted:"neutral",submitted:"info",listed:"success",rejected:"danger"};
const statusLabel:Record<string,string>={not_submitted:"Not submitted",submitted:"Submitted",listed:"Listed",rejected:"Rejected"};

function Directories({data,onSaved}:{data:Any;onSaved:()=>void}){
 const {ui,locale}=useText();
 const [edit,setEdit]=useState<{key:string;name:string;status:string;submittedAt:string;listingUrl:string;note:string}|null>(null);
 const [saving,setSaving]=useState(false);
 const [message,setMessage]=useState("");
 const registry=data.registry as Any;
 const save=async()=>{
  if(!edit)return;setSaving(true);setMessage("");
  try{
   await api("/api/console/growth/directories",{method:"POST",body:JSON.stringify({key:edit.key,status:edit.status,
    submittedAt:edit.status==="not_submitted"||!edit.submittedAt?null:edit.submittedAt,listingUrl:edit.status==="listed"&&edit.listingUrl.trim()?edit.listingUrl.trim():null,note:edit.note})});
   setEdit(null);onSaved();
  }catch(e){setMessage(String(e))}finally{setSaving(false)}
 };
 const columns:Column<Any>[]=[
  {key:"name",label:ui("Directory"),render:x=><a href={x.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium hover:underline">{x.name}<ExternalLink size={13}/></a>},
  {key:"status",label:ui("Status"),render:x=><Pill tone={statusTone[x.status]??"neutral"} dot>{ui(statusLabel[x.status]??x.status)}</Pill>},
  {key:"date",label:ui("Submitted"),render:x=>x.submittedAt??"—"},
  {key:"listing",label:ui("Listing"),render:x=>x.listingUrl?<a href={x.listingUrl} target="_blank" rel="noreferrer" className="break-all text-[var(--accent)] hover:underline">{ui("Open listing")}</a>:"—"},
  {key:"note",label:ui("Note"),render:x=><span className="break-words text-sm text-[var(--muted)]">{x.note||"—"}</span>},
  {key:"actions",label:ui("Actions"),className:"console-actions",render:x=><button type="button" className={smallButton} onClick={()=>{setMessage("");setEdit({key:x.key,name:x.name,status:x.status,submittedAt:x.submittedAt??"",listingUrl:x.listingUrl??"",note:x.note??""})}}>{ui("Edit")}</button>},
 ];
 return <div className="grid gap-5">
  <Panel title={ui("Official MCP Registry (live)")} description={ui("Checked against the registry API, refreshed at most once an hour.")}>
   <div className="flex flex-wrap items-center gap-3 text-sm">
    {registry.error?<Pill tone="warning" dot>{ui("Registry not reachable")}</Pill>:registry.listed?<Pill tone="success" dot>{ui("Listed")}</Pill>:<Pill tone="danger" dot>{ui("Not listed")}</Pill>}
    <code className="font-mono text-xs">app.wecommander/wecommander</code>
    {registry.version&&<span>{ui("Version")} <strong>{registry.version}</strong></span>}
    {registry.status&&<Pill>{registry.status}</Pill>}
    {registry.publishedAt&&<span className="text-[var(--muted)]">{ui("Published")} <When value={registry.publishedAt} locale={locale} empty="—"/></span>}
    <span className="text-[var(--muted)]">{ui("Checked")} <When value={registry.checkedAt} locale={locale} empty="—"/></span>
   </div>
  </Panel>
  <Panel flush title={ui("AI app and plugin directories")} actions={<a href={data.kitUrl} target="_blank" rel="noreferrer" className={smallButton}><ExternalLink size={14}/>{ui("Submission kit")}</a>}>
   <AdminTable columns={columns} rows={data.items as Any[]} rowKey={x=>x.key}/>
  </Panel>
  {edit&&<Panel title={edit.name} description={ui("Status changes are written to the platform audit log.")}>
   <div className="grid gap-4 sm:grid-cols-2">
    <label className="grid gap-1 text-sm font-semibold">{ui("Status")}<select className={fieldClass} value={edit.status} onChange={e=>setEdit({...edit,status:e.target.value})}>{Object.keys(statusLabel).map(s=><option key={s} value={s}>{ui(statusLabel[s]!)}</option>)}</select></label>
    <label className="grid gap-1 text-sm font-semibold">{ui("Submitted on")}<input type="date" className={fieldClass} disabled={edit.status==="not_submitted"} value={edit.submittedAt} onChange={e=>setEdit({...edit,submittedAt:e.target.value})}/></label>
    <label className="grid gap-1 text-sm font-semibold sm:col-span-2">{ui("Listing URL (https)")}<input type="url" className={fieldClass} disabled={edit.status!=="listed"} value={edit.listingUrl} onChange={e=>setEdit({...edit,listingUrl:e.target.value})}/></label>
    <label className="grid gap-1 text-sm font-semibold sm:col-span-2">{ui("Note")}<textarea maxLength={500} rows={3} className="rounded-xl border border-[var(--stroke)] bg-[var(--input)] p-3 text-sm" value={edit.note} onChange={e=>setEdit({...edit,note:e.target.value})}/></label>
   </div>
   {message&&<p role="alert" className="mt-3 text-sm text-[var(--danger)]">{message}</p>}
   <div className="mt-4 flex flex-wrap justify-end gap-2"><button type="button" className={smallButton} onClick={()=>setEdit(null)}>{ui("Cancel")}</button><button type="button" disabled={saving} className="inline-flex h-8 items-center rounded-lg bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-ink)] disabled:opacity-50" onClick={()=>void save()}>{ui("Save")}</button></div>
  </Panel>}
  {data.kit&&<details className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-5"><summary className="cursor-pointer font-semibold">{ui("Submission kit (docs/DIRECTORY_SUBMISSIONS.md)")}</summary><pre className="mt-4 max-h-[480px] overflow-auto whitespace-pre-wrap break-words text-xs">{data.kit}</pre></details>}
 </div>;
}
