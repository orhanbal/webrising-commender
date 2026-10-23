import {useEffect,useRef,useState} from "react";import type{ReactNode}from"react";
import { t as translate,useLocale,locale,LanguageSwitcher } from "../i18n";
import {Activity,ArrowRight,ArrowUpRight,Bell,ChevronDown,Clock3,Command,CreditCard,FileText,HardDrive,LayoutDashboard,LockKeyhole,LogOut,Menu,Monitor,Plus,Search,Server,Settings2,ShieldCheck,TerminalSquare,Users,Workflow,Zap}from"lucide-react";
import{Button,Card,CardContent,CardDescription,CardHeader,CardTitle,Badge}from"../components/ui";
import{api,type Account,type Device,type Usage,type Billing}from"../api";
import{dateText,formatCount}from"../lib";
import{Brand,ThemeToggle}from"../App";import type{Nav,Theme}from"../App";

const pages=[
{title:"Genel Bakış",href:"/dashboard",icon:LayoutDashboard},
{title:"Cihazlar",href:"/devices",icon:Monitor},
{title:"Terminal",href:"/terminal",icon:TerminalSquare},
{title:"Dosyalar",href:"/files",icon:FileText},
{title:"Görevler",href:"/tasks",icon:Workflow},
{title:"MCP Araçları",href:"/mcp",icon:Command},
{title:"Kullanım",href:"/usage",icon:Activity},
{title:"Paket ve Ödemeler",href:"/billing",icon:CreditCard}
];
export function DashboardShell({nav,path,account,theme,toggle,logout,children}:{nav:Nav;path:string;account:Account|null;theme:Theme;toggle:()=>void;logout:()=>void;children:ReactNode}){
 useLocale();
 const [mobile,setMobile]=useState(false);
 const [search,setSearch]=useState("");
 const [profileOpen,setProfileOpen]=useState(false);
 const profileRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(!profileOpen)return;const close=(event:PointerEvent)=>{if(profileRef.current&&!profileRef.current.contains(event.target as Node))setProfileOpen(false)};const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")setProfileOpen(false)};document.addEventListener("pointerdown",close);document.addEventListener("keydown",escape);return()=>{document.removeEventListener("pointerdown",close);document.removeEventListener("keydown",escape)}},[profileOpen]);
 const navTo=(url:string)=>{setMobile(false);setProfileOpen(false);nav(url)};
 return <div className="dashboard-layout">
  {mobile&&<div className="fixed inset-0 bg-black/60 z-[92] md:hidden" onClick={()=>setMobile(false)}/>}
  <aside className={"dashboard-sidebar "+(mobile?"open":"")} aria-label="Uygulama menüsü">
   <div className="px-3 pt-2"><Brand subtitle onClick={()=>navTo("/")}/></div>
   <nav className="dash-nav">{pages.map(p=><button key={p.title} onClick={()=>navTo(p.href)} className={"dash-link text-left "+(p.href===path?"active":"")}><p.icon/>{translate(p.title)}{p.href===path&&<span className="ml-auto w-1.5 h-1.5 rounded-full bg-[var(--accent)]"/>}</button>)}</nav>
   <div className="dash-sidebar-bottom"><Badge><ShieldCheck size={13}/> {translate("Güvenli çalışma alanı")}</Badge><p className="text-sm font-semibold mt-3">WECOMMANDER</p><p className="muted text-xs mt-1">{translate("Yetkilendirilmiş erişim ve iş akışları.")}</p><Button className="w-full mt-4" variant="outline" size="sm" onClick={()=>navTo("/pricing")}>{translate("Paketleri Gör")} <ArrowUpRight className="size-3.5"/></Button></div>
  </aside>
  <div className="dash-main">
   <div className="dash-topbar">
    <div className="flex items-center gap-3 flex-1 min-w-0"><button className="mobile-dash-open size-9 place-items-center rounded-lg border border-[var(--stroke)]" onClick={()=>setMobile(true)} aria-label={translate("Menüyü aç")}><Menu size={18}/></button><div className="text-sm muted hidden sm:block">{translate("Çalışma Alanım")} <span className="mx-2">/</span> <span className="text-[var(--text)]">{path==="/dashboard"?translate("Genel Bakış"):path==="/billing"?translate("Faturalama"):translate("Hesabım")}</span></div></div>
    <div className="dash-toolbar"><div className="relative hidden lg:block"><Search size={16} className="absolute left-3 top-2.5 text-[var(--muted)]"/><input value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&search.trim())navTo("/devices?search="+encodeURIComponent(search))}} placeholder={translate("Cihazları ve araçları ara…")} className="h-10 w-[270px] rounded-xl border border-[var(--stroke)] bg-[var(--surface)] pl-10 pr-3 text-sm outline-none focus-visible:border-[var(--accent)]"/></div><ThemeToggle theme={theme} onToggle={toggle}/><LanguageSwitcher compact/><Button size="icon" variant="outline" title="Son aktiviteler" aria-label="Son aktiviteler" onClick={()=>navTo("/devices")}><Bell size={18}/></Button><div ref={profileRef} className="relative">
     <button type="button" onClick={()=>setProfileOpen(value=>!value)} aria-label={translate("Hesap menüsü")} aria-haspopup="menu" aria-expanded={profileOpen} className="flex items-center gap-2 rounded-xl p-1 pr-3 border border-[var(--stroke)] hover:bg-[var(--hover)]"><span className="size-9 rounded-lg bg-[var(--subtle-surface)] text-[var(--accent)] grid place-items-center font-bold">{(account?.email||"WC").slice(0,2).toUpperCase()}</span><span className="hidden sm:block text-sm max-w-[125px] truncate">{account?.email?.split("@")[0]||translate("Misafir")}</span><ChevronDown className={"size-3.5 muted transition-transform "+(profileOpen?"rotate-180":"")}/></button>
     {profileOpen&&<div role="menu" aria-label={translate("Hesap menüsü")} className="absolute right-0 top-[calc(100%+9px)] z-[120] w-[265px] rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-2 shadow-2xl">
       <div className="border-b border-[var(--stroke)] px-3 py-3 mb-1"><div className="font-semibold text-sm truncate">{account?.email||translate("Misafir")}</div><div className="text-xs muted mt-1">{translate("Çalışma Alanım")}</div></div>
       <button type="button" role="menuitem" onClick={()=>navTo("/account")} className="flex items-center gap-3 w-full rounded-lg px-3 py-3 text-sm text-left hover:bg-[var(--hover)]"><Settings2 size={17}/>{translate("Hesap Ayarları")}</button>
       <button type="button" role="menuitem" onClick={()=>navTo("/account")} className="flex items-center gap-3 w-full rounded-lg px-3 py-3 text-sm text-left hover:bg-[var(--hover)]"><Users size={17}/>{translate("Çalışma Alanları")}</button>
       <div className="border-t border-[var(--stroke)] my-1"/>
       <button type="button" role="menuitem" onClick={()=>{setProfileOpen(false);logout()}} className="flex items-center gap-3 w-full rounded-lg px-3 py-3 text-sm text-left hover:bg-[var(--hover)]"><LogOut size={17}/>{translate("Çıkış Yap")}</button>
     </div>}
    </div></div>
   </div>
   <main className="dash-content">{children}</main>
   <div className="border-t border-[var(--stroke)] mt-12 pt-5 pb-5 flex justify-between items-center gap-5 flex-wrap text-xs muted"><span>{translate("WECOMMANDER · Güvenli MCP Platformu")}</span><div className="flex gap-4"><button onClick={()=>navTo("/pricing")}>{translate("Planlar")}</button><button onClick={logout} className="inline-flex items-center gap-1"><LogOut size={12}/> {translate("Çıkış")}</button></div></div>
  </div>
 </div>
}
export function DashboardPage({nav,path,account,checking,logout,theme,toggle}:{nav:Nav;path:string;account:Account|null;checking:boolean;refresh:()=>Promise<Account|null>;logout:()=>void;theme:Theme;toggle:()=>void}){
 useLocale();
 const [devices,setDevices]=useState<Device[]>([]);
 const [usage,setUsage]=useState<Usage|null>(null);
 const [bill,setBill]=useState<Billing|null>(null);
 const [activity,setActivity]=useState<Array<{tool:string;outcome:string;created_at:string;device_name?:string}>>([]);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 useEffect(()=>{if(!account){setLoading(false);return}let active=true;Promise.allSettled([
  api<{items:Device[]}>("/api/devices"),api<Usage>("/api/usage"),api<{items:typeof activity}>("/api/activity?limit=6"),api<Billing>("/api/billing")
 ]).then(values=>{if(!active)return;const [d,u,a,b]=values;if(d.status==="fulfilled")setDevices(d.value.items);if(u.status==="fulfilled")setUsage(u.value);if(a.status==="fulfilled")setActivity(a.value.items);if(b.status==="fulfilled")setBill(b.value);if(values.every(x=>x.status==="rejected"))setError(translate("Veriler yüklenemedi. Bağlantınızı kontrol edin."));setLoading(false)});return()=>{active=false}},[account]);
 const online=devices.filter(d=>d.online).length;
 const max=Math.max(1,...(usage?.daily||[]).map(x=>x.calls));
 const work=(view:string)=>nav("/"+(view==="settings"?"account":view));
 return <DashboardShell nav={nav} path={path} account={account} theme={theme} toggle={toggle} logout={logout}>
  {path==="/account"?<><span className="dash-kicker">AYARLAR</span><h1 className="dash-title mt-2">{translate("Hesabım")}</h1><p className="muted text-sm mt-2 mb-8">{translate("Hesap, çalışma alanı ve güvenlik seçeneklerini yönetin.")}</p><div className="max-w-3xl grid gap-4"><Card><CardHeader><CardTitle>{translate("Hesap Bilgileri")}</CardTitle><CardDescription>{translate("Mevcut oturumunuz")}</CardDescription></CardHeader><CardContent><div className="data-row"><LockKeyhole size={20}/><div><b>E-posta</b><small>{account?.email||translate("Giriş yapılmadı")}</small></div></div><div className="data-row"><Server size={20}/><div><b>{translate("Rol")}</b><small>{account?.role||"—"}</small></div></div><div className="data-row"><ShieldCheck size={20}/><div><b>{translate("Organizasyon")}</b><small>{account?.organizationId||"—"}</small></div></div><div className="flex gap-3 mt-6 flex-wrap"><Button variant="outline" onClick={()=>work("settings")}>{translate("Hesap ayarları")} <ArrowRight size={15}/></Button><Button variant="outline" onClick={()=>nav("/billing")}>{translate("Abonelik yönetimi")} <ArrowRight size={15}/></Button><Button variant="danger" onClick={logout}>{translate("Çıkış yap")} <LogOut size={15}/></Button></div></CardContent></Card></div></>:
  <>
   <div className="flex justify-between items-end gap-4 flex-wrap"><div><span className="dash-kicker">{translate("GENEL BAKIŞ")}</span><h1 className="dash-title mt-2">{translate("Tekrar hoş geldin")}<span className="text-[var(--accent)]">.</span></h1><p className="muted text-sm mt-2">{translate("Cihazların ve çalışma alanın tek ekranda, kontrol sende.")}</p></div><div className="flex gap-2"><Button variant="outline" onClick={()=>work("devices")}><Plus size={17}/> {translate("Cihaz Ekle")}</Button><Button onClick={()=>work("tasks")}><Zap size={17}/> {translate("Hızlı Görev")}</Button></div></div>
   {!account&&!checking&&<Card className="p-5 mt-6 flex flex-wrap items-center justify-between gap-3 border-[var(--accent)]"><div><h3 className="font-semibold">{translate("Panelini kişiselleştirmek için giriş yap")}</h3><p className="muted text-sm mt-1">{translate("Gerçek cihaz, görev ve abonelik bilgilerine güvenli oturumla erişilir.")}</p></div><Button onClick={()=>nav("/login")}>{translate("Giriş Yap")} <ArrowRight size={17}/></Button></Card>}
   {error&&<div className="form-error mt-5">{error}</div>}
   <div className="stat-grid-modern">
    {[{title:translate("Toplam Cihaz"),value:account?formatCount(devices.length):"—",hint:account?online+translate(" çevrimiçi"):translate("Giriş gerekli"),icon:Monitor},{title:translate("Bu Ay İşlem"),value:account?formatCount(usage?.monthCalls):"—",hint:usage?.limit==null?translate("Kullanım verisi"):usage.monthCalls+" / "+usage.limit,icon:Zap},{title:translate("Depolama"),value:"—",hint:translate("Telemetri verisi henüz yok"),icon:HardDrive},{title:"Uptime",value:"—",hint:translate("Geçmiş uptime ölçümü yok"),icon:Clock3}].map(s=><Card className="stat-modern" key={s.title}><div className="icon"><s.icon size={20}/></div><p className="text-[13px] muted mt-4">{s.title}</p><strong>{loading&&account?"…":s.value}</strong><small>{s.hint}</small></Card>)}
   </div>
   <div className="dash-columns">
    <Card><CardHeader className="flex flex-row items-center justify-between"><div><CardTitle>{translate("Cihazlarım")}</CardTitle><CardDescription>{translate("Bağlı cihazlar ve durumları")}</CardDescription></div><Button variant="link" size="sm" onClick={()=>work("devices")}>{translate("Tümü")} <ArrowRight size={15}/></Button></CardHeader><CardContent>{!devices.length?<p className="muted text-sm py-10">{account?translate("Henüz kayıtlı cihaz bulunmuyor."):translate("Cihazları görmek için giriş yapın.")}</p>:devices.slice(0,5).map(d=><div className="data-row" key={d.id}><div className="size-10 rounded-xl bg-[var(--subtle-surface)] grid place-items-center"><Monitor size={19}/></div><div className="flex-1 min-w-0"><b className="truncate block">{d.name}</b><small>{d.platform||translate("Bilinmeyen işletim sistemi")} · {d.last_seen_at?dateText(d.last_seen_at):translate("Henüz görülmedi")}</small></div><Badge className={d.online?"text-[var(--success)]":""}>● {d.online?translate("Çevrimiçi"):translate("Çevrimdışı")}</Badge><Button variant="outline" size="sm" onClick={()=>work("devices")}>{translate("Aç")}</Button></div>)}</CardContent></Card>
    <Card><CardHeader><CardTitle>{translate("Son Aktiviteler")}</CardTitle><CardDescription>{translate("Güncel işlem kayıtları")}</CardDescription></CardHeader><CardContent>{!activity.length?<p className="muted text-sm py-10">{translate("Görüntülenecek aktivite yok.")}</p>:activity.map((item,i)=><div className="data-row" key={i}><div className="size-9 rounded-lg bg-[var(--subtle-surface)] grid place-items-center"><Activity size={18}/></div><div className="flex-1"><b>{item.tool}</b><small>{item.device_name||translate("Çalışma alanı")} · {dateText(item.created_at)}</small></div><span className="text-xs muted">{item.outcome}</span></div>)}</CardContent></Card>
   </div>
   <div className="grid lg:grid-cols-[1.35fr_.65fr] gap-4 mt-4">
    <Card><CardHeader><CardTitle>{translate("Son 7 Günlük Kullanım")}</CardTitle><CardDescription>{translate("Gerçek API işlem sayıları")}</CardDescription></CardHeader><CardContent>{usage?.daily?.length?<div className="h-[160px] grid grid-cols-7 gap-4 items-end pt-4">{usage.daily.map(day=><div className="flex flex-col h-full items-center justify-end gap-2" key={day.day}><div className="w-full rounded-t-md bg-[var(--accent)] transition-[height] min-h-[3px]" style={{height:Math.max(2,Math.round(day.calls/max*135))+"px"}} title={day.calls+translate(" işlem")}/><small className="text-[10px] muted">{new Date(day.day).toLocaleDateString(locale()==="tr"?"tr-TR":"en-US",{weekday:"short"})}</small></div>)}</div>:<p className="py-10 muted text-sm">{translate("Henüz grafik verisi bulunmuyor.")}</p>}</CardContent></Card>
    <Card><CardHeader><CardTitle>{translate("Paket Bilgisi")}</CardTitle><CardDescription>{translate("Abonelik ve kaynak limitleri")}</CardDescription></CardHeader><CardContent><div className="flex gap-3 items-center mb-4"><div className="size-11 rounded-xl bg-[var(--subtle-surface)] text-[var(--accent)] grid place-items-center"><CreditCard size={22}/></div><div><b>{bill?.plan?.name||translate("Paket bilgisi yok")}</b><small className="block muted">{bill?.subscription?.status||translate("Giriş yaparak görüntüle")}</small></div></div><Button className="w-full" variant="outline" onClick={()=>nav("/billing")}>{translate("Aboneliği yönet")} <ArrowRight size={16}/></Button></CardContent></Card>
   </div>
  </>}
 </DashboardShell>;
}
