import {useEffect,useState} from "react";
import{ArrowRight,CalendarDays,CheckCircle2,CreditCard,ExternalLink,LockKeyhole,ReceiptText,RefreshCw,ShieldCheck}from"lucide-react";
import{Button,Card,CardContent,CardDescription,CardHeader,CardTitle,Badge}from"../components/ui";
import{api,type Account,type Billing,type Pricing}from"../api";import{dateText}from"../lib";
import{DashboardShell}from"./Dashboard";import type{Nav,Theme}from"../App";
export function BillingPage({nav,account,checking,theme,toggle,logout,pricing}:{nav:Nav;account:Account|null;checking:boolean;theme:Theme;toggle:()=>void;logout:()=>void;pricing:Pricing|null}){
 const [state,setState]=useState<Billing|null>(null);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const [portalBusy,setPortalBusy]=useState(false);
 const pending=new URLSearchParams(location.search).has("pending");
 async function refresh(){try{const item=await api<Billing>("/api/billing");setState(item);setError("");return item}catch(e){setError(e instanceof Error?e.message:"Abonelik alınamadı");return null}finally{setLoading(false)}}
 useEffect(()=>{if(!account){setLoading(false);return}void refresh()},[account]);
 useEffect(()=>{if(!pending||!account)return;let count=0;const timer=setInterval(async()=>{count++;const item=await refresh();if((item?.entitled&&item.subscription?.provider==="paddle")||count>=12)clearInterval(timer)},5000);return()=>clearInterval(timer)},[pending,account]);
 async function openPortal(){setError("");setPortalBusy(true);try{const portal=await api<{url:string}>("/api/billing/paddle/portal",{method:"POST"});const url=new URL(portal.url);if(!url.hostname.endsWith(".paddle.com")||url.protocol!=="https:")throw new Error("Güvenli Paddle bağlantısı alınamadı.");window.open(url.toString(),"_blank","noopener,noreferrer")}catch(e){setError(e instanceof Error?e.message:"Portal açılamadı")}finally{setPortalBusy(false)}}
 return <DashboardShell nav={nav} path="/billing" account={account} logout={logout} theme={theme} toggle={toggle}>
  <span className="dash-kicker">ABONELİK</span><h1 className="dash-title mt-2">Paket ve Faturalama</h1><p className="muted text-sm mt-2">Paketiniz, faturalandırma ve ödeme işlemleriniz bir arada.</p>
  {pending&&<div className="mt-6 rounded-xl border border-[var(--accent)] bg-[var(--subtle-surface)] p-4 flex gap-3 items-center"><RefreshCw className="size-5 text-[var(--accent)]" /><div><strong className="text-sm">Ödeme sonrası doğrulama</strong><p className="muted text-xs mt-1">Abonelik Paddle'ın güvenli sunucu bildiriminden sonra etkinleşir; bu ekran güncel durumu kontrol ediyor.</p></div></div>}
  {error&&<div role="alert" className="form-error mt-5">{error}</div>}
  {!account&&!checking?<Card className="p-7 mt-8"><h2 className="text-lg font-semibold">Aboneliğinizi görüntülemek için giriş yapın.</h2><p className="muted mt-2 text-sm">Ödeme, fatura ve paket bilgileri yalnızca hesap sahibi tarafından görülebilir.</p><Button className="mt-5" onClick={()=>nav("/login")}>Giriş Yap <ArrowRight size={16}/></Button></Card>:
  <div className="grid lg:grid-cols-[1.1fr_.9fr] gap-5 mt-8">
   <Card><CardHeader><div className="flex gap-3 items-center justify-between"><CardTitle>Mevcut Abonelik</CardTitle><Badge>{loading?"Kontrol ediliyor":state?.subscription?.status||"Aktif paket yok"}</Badge></div><CardDescription>Sunucudan alınan gerçek paket durumu</CardDescription></CardHeader><CardContent>
    <div className="p-5 border border-[var(--stroke)] rounded-xl bg-[var(--subtle-surface)]"><div className="flex items-center gap-3"><span className="size-12 grid place-items-center rounded-xl bg-[var(--surface)] text-[var(--accent)]"><CreditCard size={24}/></span><div><h3 className="text-xl font-bold">{state?.plan?.name||"Paket bulunamadı"}</h3><p className="muted text-xs mt-1">{state?.entitled?"Kullanım hakkınız aktif":"Aktif bir aboneliğiniz görünmüyor"}</p></div></div><div className="mt-6 grid gap-3 text-sm"><div className="flex justify-between gap-3"><span className="muted">Ödeme sağlayıcısı</span><strong>{state?.subscription?.provider||"—"}</strong></div><div className="flex justify-between gap-3"><span className="muted">Dönem sonu</span><strong>{dateText(state?.subscription?.currentPeriodEnd)}</strong></div><div className="flex justify-between gap-3"><span className="muted">Dönem sonunda iptal</span><strong>{state?.subscription?.cancelAtPeriodEnd?"Evet":"Hayır"}</strong></div></div></div>
    <div className="flex flex-wrap gap-3 mt-6"><Button onClick={()=>nav("/pricing")}>Paketleri Gör <ArrowRight size={16}/></Button><Button variant="outline" onClick={openPortal} disabled={!state||state.subscription?.provider!=="paddle"||portalBusy}>{portalBusy?"Açılıyor…":"Aboneliği Paddle'da yönet"} <ExternalLink size={16}/></Button></div>
   </CardContent></Card>
   <div className="grid gap-5">
    <Card><CardHeader><CardTitle>Ödeme Güvenliği</CardTitle><CardDescription>Ödemeleriniz Paddle tarafından işlenir.</CardDescription></CardHeader><CardContent><div className="grid gap-4 text-sm muted"><div className="flex gap-3"><ShieldCheck size={20} className="text-[var(--accent)] shrink-0"/><span>Ücretlendirme, vergi ve ödeme bilgileri Paddle checkout ekranında gösterilir.</span></div><div className="flex gap-3"><LockKeyhole size={20} className="text-[var(--accent)] shrink-0"/><span>WECOMMANDER sunucularında ödeme kartı numarası saklanmaz.</span></div><div className="flex gap-3"><CheckCircle2 size={20} className="text-[var(--accent)] shrink-0"/><span>Abonelik hakları yalnızca doğrulanmış sağlayıcı bildirimleriyle güncellenir.</span></div></div></CardContent></Card>
    <Card><CardHeader><CardTitle>Faturalar ve İptaller</CardTitle><CardDescription>Makbuz, fatura, ödeme yöntemi ve iptal seçenekleri.</CardDescription></CardHeader><CardContent><div className="flex items-start gap-3 mb-5 text-sm muted"><ReceiptText size={20} className="text-[var(--accent)] shrink-0"/>Faturalarınızı Paddle müşteri portalından görüntüleyebilir, ödeme yönteminizi güncelleyebilir ve aboneliğinizi yönetebilirsiniz.</div><Button variant="outline" className="w-full" onClick={openPortal} disabled={!state||state.subscription?.provider!=="paddle"||portalBusy}>Müşteri portalına git <ExternalLink size={16}/></Button></CardContent></Card>
   </div>
  </div>}
  {pricing?.paddle.environment==="sandbox"&&<div className="text-xs muted mt-8 flex gap-2 items-center"><CalendarDays size={15}/> Paddle test ortamı etkin: gerçek para tahsil edilmez.</div>}
 </DashboardShell>;
}
