import {useEffect,useState} from "react";
import {Activity,ArrowRight,BarChart3,CalendarDays,Clock3,RefreshCw,Zap}from"lucide-react";
import{api,type Account,type Usage}from"../api";
import{formatCount}from"../lib";
import{Badge,Button,Card,CardContent,CardDescription,CardHeader,CardTitle}from"../components/ui";
import{DashboardShell}from"./Dashboard";import type{Nav,Theme}from"../App";
export function UsagePage({nav,account,checking,theme,toggle,logout}:{nav:Nav;account:Account|null;checking:boolean;theme:Theme;toggle:()=>void;logout:()=>void}){
 const [data,setData]=useState<Usage|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 async function refresh(){
  if(!account)return;
  setBusy(true);setError("");
  try{const r=await api<Usage>("/api/usage");setData(r)}
  catch(e){setError(e instanceof Error?e.message:"Kullanım bilgisi alınamadı.")}
  finally{setBusy(false)}
 }
 useEffect(()=>{void refresh()},[account?.organizationId]);
 const monthlyMax=Math.max(1,...(data?.months||[]).map(x=>x.calls));
 const dailyMax=Math.max(1,...(data?.daily||[]).map(x=>x.calls));
 const percent=data?.limit==null?null:data.limit===0?100:Math.min(100,Math.round(data.monthCalls/data.limit*100));
 return <DashboardShell nav={nav}path="/usage"account={account}theme={theme}toggle={toggle}logout={logout}>
  <div className="flex justify-between items-end flex-wrap gap-4"><div><span className="dash-kicker">ANALİTİK</span><h1 className="dash-title mt-2">Kullanım ve Raporlar</h1><p className="muted text-sm mt-2">Gerçek işlem ve araç kullanımınızın görünümü.</p></div><Button variant="outline" onClick={()=>void refresh()} disabled={busy||!account}><RefreshCw size={17} className={busy?"animate-spin":""}/> Yenile</Button></div>
  {error&&<div className="form-error mt-5" role="alert">{error}</div>}
  {!account&&!checking&&<Card className="p-6 mt-6"><h2 className="font-semibold">Kullanım bilgileri için giriş yapın</h2><Button className="mt-3" onClick={()=>nav("/login")}>Giriş Yap <ArrowRight size={17}/></Button></Card>}
  <div className="grid sm:grid-cols-3 gap-4 mt-7">{[{title:"Bu Ay İşlem",v:formatCount(data?.monthCalls),icon:Zap,hint:"Toplam işlem"},{title:"Günlük Ortalama",v:formatCount(data?.dailyAverage),icon:Activity,hint:"Bu ay"},{title:"Aylık Kota",v:data?.limit==null?"Sınırsız":formatCount(data.limit),icon:CalendarDays,hint:percent==null?"Sınır uygulanmıyor":"%"+percent+" kullanıldı"}].map(x=><Card className="p-6" key={x.title}><x.icon size={22} className="text-[var(--accent)]"/><p className="muted text-sm mt-4">{x.title}</p><strong className="text-3xl block mt-1">{account?x.v:"—"}</strong><p className="muted text-xs mt-2">{x.hint}</p></Card>)}</div>
  {account&&data&&<><Card className="mt-5"><CardHeader><CardTitle>Kota Kullanımı</CardTitle><CardDescription>Bu ayki işlem kotası ve dönem durumu</CardDescription></CardHeader><CardContent><div className="flex justify-between items-center gap-3 text-sm font-semibold mb-3"><span>{data.monthCalls} işlem</span><span>{data.limit==null?"Sınırsız":data.limit+" sınır"}</span></div><div className="meter-track"><div className="meter-fill" style={{width:(percent??0)+"%"}}/></div><p className="muted text-xs mt-3">Kullanım dönemi sıfırlanma tarihi: {data.resetAt?new Date(data.resetAt).toLocaleDateString("tr-TR"):"—"}</p></CardContent></Card>
  <div className="grid lg:grid-cols-2 gap-5 mt-5"><Card><CardHeader><CardTitle>Son 7 Gün</CardTitle><CardDescription>Günlük işlem dağılımı</CardDescription></CardHeader><CardContent><div className="flex h-52 gap-4 justify-around items-end pt-5">{data.daily.map(d=><div className="flex-1 h-full flex flex-col items-center justify-end gap-2" key={d.day}><div className="w-full max-w-[48px] bg-[var(--accent)] rounded-t-md min-h-[3px]" style={{height:Math.max(3,d.calls/dailyMax*165)+"px"}} title={d.calls+" işlem"}/><small className="muted text-[10px]">{new Date(d.day).toLocaleDateString("tr-TR",{weekday:"short"})}</small></div>)}</div></CardContent></Card><Card><CardHeader><CardTitle>Son 6 Ay</CardTitle><CardDescription>Aylık kullanım geçmişi</CardDescription></CardHeader><CardContent><div className="flex h-52 gap-5 justify-around items-end pt-5">{data.months.map(d=><div className="flex-1 h-full flex flex-col items-center justify-end gap-2" key={d.month}><div className="w-full max-w-[48px] bg-[var(--accent)] rounded-t-md min-h-[3px]" style={{height:Math.max(3,d.calls/monthlyMax*165)+"px"}} title={d.calls+" işlem"}/><small className="muted text-[10px]">{d.month.slice(5)}</small></div>)}</div></CardContent></Card></div>
  <Card className="mt-5"><CardHeader><CardTitle>En Çok Kullanılan Araçlar</CardTitle><CardDescription>Bu ayki çağrılara göre sıralama</CardDescription></CardHeader><CardContent>{!data.topTools.length?<p className="muted text-sm py-5">Henüz araç kullanım kaydı bulunmuyor.</p>:data.topTools.slice(0,12).map(x=><div className="flex items-center gap-3 py-3 border-b border-[var(--stroke)] last:border-0" key={x.tool}><BarChart3 size={17} className="text-[var(--accent)]"/><span className="text-sm flex-1 break-all">{x.tool}</span><Badge>{formatCount(x.calls)} çağrı</Badge></div>)}</CardContent></Card></>}
 </DashboardShell>;
}
