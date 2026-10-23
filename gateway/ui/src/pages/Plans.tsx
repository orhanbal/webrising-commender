import {useEffect,useState} from "react";
import { t as translate,useLocale } from "../i18n";
import {ArrowLeft,ArrowRight,Check,CheckCheck,CreditCard,ExternalLink,KeyRound,LockKeyhole,Server,ShieldCheck,Sparkles} from "lucide-react";
import{Button,Card,Badge}from"../components/ui";
import{api,type Account,type Plan,type Pricing}from"../api";import type{Nav,Theme}from"../App";import{NavLink}from"../App";import{loadPaddle}from"../paddle";
function features(plan:Plan){return plan.features.length?plan.features:[
  plan.maxDevices===null?translate("Sınırsız cihaz"):plan.maxDevices+translate(" cihaz"),
  plan.maxMembers===null?translate("Sınırsız ekip üyesi"):plan.maxMembers+translate(" ekip üyesi"),
  plan.maxApiTokens===null?translate("Sınırsız API erişimi"):plan.maxApiTokens+translate(" API anahtarı"),
  translate("Güvenli MCP erişimi"),"Denetim ve yetkilendirme"
]}
export function PlansPage({nav,pricing,account,checkoutMode=false,theme="dark",signupEnabled}:{nav:Nav;pricing:Pricing|null;account:Account|null;checkoutMode?:boolean;theme?:Theme;signupEnabled:boolean|null}){
 useLocale();
 const [data,setData]=useState<Pricing|null>(pricing);
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState("");
 const selected=new URLSearchParams(location.search).get("plan")||"";
 const plan=data?.plans.find(x=>x.key===selected);
 useEffect(()=>{if(pricing)setData(pricing);else api<Pricing>("/api/public/plans").then(setData).catch(()=>setMessage(translate("Paket listesi alınamadı.")))},[pricing]);
 function pick(key:string){if(!account){sessionStorage.setItem("wc-selected-plan",key);nav(signupEnabled===false?"/login":"/register");return}nav("/checkout?plan="+encodeURIComponent(key))}
 async function checkout(){
  setMessage("");if(!account){if(plan)pick(plan.key);else nav("/login");return}
  if(!data?.paddle.checkoutEnabled||!data.paddle.clientToken||!plan?.priceId){setMessage(translate("Bu paketin Paddle ödemesi henüz yapılandırılmamış."));return}
  setBusy(true);
  try{
   const transaction=await api<{transactionId:string}>("/api/billing/paddle/checkout",{method:"POST",body:JSON.stringify({planKey:plan.key})});
   const paddle=await loadPaddle(data.paddle.clientToken,data.paddle.environment,()=>{
    // Never grant entitlement based on a browser event. Wait for signed Paddle webhook.
    nav("/billing?pending=1");
   });
   paddle.Checkout.open({transactionId:transaction.transactionId,settings:{displayMode:"overlay",theme,locale:"tr"}});
  }catch(e){setMessage(e instanceof Error?e.message:translate("Ödeme ekranı açılamadı."))}
  finally{setBusy(false)}
 }
 return <div className="min-h-[calc(100vh-76px)] pb-28">
  {!checkoutMode?<><section className="pricing-head container-w"><Badge><Sparkles size={14}/> WECOMMANDER Plans</Badge><h1 className="h2 mt-6">{translate("İhtiyacına göre")} <span className="text-gradient">{translate("doğru paket.")}</span></h1><p className="muted text-base max-w-2xl mx-auto mt-5">{translate("Paket özellikleri ve fiyatlar sistemde tanımlanan güncel bilgilere dayanır. Ödemeler Paddle tarafından güvenli biçimde işlenir.")}</p></section>
  <div className="container-w"><div className="pricing-grid max-w-[1040px] mx-auto">
   <Card className="price-modern"><Badge><Server size={13}/> {translate("Kendi altyapında")}</Badge><h3 className="mt-6">Self-hosted</h3><p className="meta mt-3">{translate("Sunucu ve verilerin sizin kontrolünüzde.")}</p><div className="price-value">{translate("Kendi sunucun")}</div><ul>{[translate("Kendi sunucunda çalıştırma"),translate("Cihaz ve uzaktan erişim yönetimi"),translate("MCP istemci bağlantısı"),translate("Yönetim ve denetim araçları")].map(x=><li key={x}><Check size={16}/>{x}</li>)}</ul><Button variant="outline" onClick={()=>nav("/register")}>{translate("Çalışma alanı oluştur")} <ArrowRight size={15}/></Button></Card>
   {(data?.plans||[]).map(p=><Card key={p.key} className={"price-modern "+(p.featured?"featured":"")}><Badge>{p.featured?<Sparkles size={13}/>:<ShieldCheck size={13}/>} {p.featured?"Öne Çıkan":"Cloud Plan"}</Badge><h3 className="mt-6">{p.name}</h3><p className="meta mt-3">{p.description||translate("WECOMMANDER bulut çalışma alanı")}</p><div className="price-value">{p.priceLabel||translate("Fiyat bilgisi için iletişime geçin")}</div><ul>{features(p).map(x=><li key={x}><Check size={16}/>{x}</li>)}</ul><Button variant={p.featured?"default":"outline"} onClick={()=>pick(p.key)} disabled={!p.priceId||!data?.paddle.checkoutEnabled}>{p.priceId&&data?.paddle.checkoutEnabled?translate("Paketi seç"):translate("Ödeme henüz açık değil")}<ArrowRight size={15}/></Button></Card>)}
   {data?.mode==="saas"&&data.plans.length===0&&<Card className="price-modern"><Badge>{translate("Henüz hazır değil")}</Badge><h3 className="mt-6">{translate("Cloud paketleri")}</h3><p className="muted mt-4 text-sm">{translate("Yönetici tarafından aktif abonelik paketleri tanımlandığında burada görünecek. Henüz fiyat veya ödeme bilgisi uydurulmuyor.")}</p><div className="mt-auto pt-6"><Button variant="outline" onClick={()=>nav("/register")}>{translate("Hesap oluştur")}</Button></div></Card>}
  </div><div className="mt-9 mx-auto max-w-[900px] text-sm muted flex items-center justify-center flex-wrap gap-3"><ShieldCheck size={16}/> {translate("Güvenli ödeme Paddle ile işlenir")} <span className="text-[var(--faint)]">·</span><LockKeyhole size={16}/> {translate("Kart bilgileri uygulama sunucusunda tutulmaz")}</div></div></>:
  <section className="container-w pt-16"><button className="text-sm muted inline-flex gap-2 items-center hover:text-[var(--text)]" onClick={()=>nav("/pricing")}><ArrowLeft size={16}/> {translate("Paketlere dön")}</button>
   <div className="max-w-[980px] mx-auto grid md:grid-cols-2 gap-9 mt-9">
    <div><Badge><CreditCard size={14}/> Paddle Checkout</Badge><h1 className="h2 mt-5">{translate("Ödeme adımına")} <span className="text-gradient">{translate("hoş geldin.")}</span></h1><p className="muted mt-5 text-base">{translate("Ödeme ekranı, uluslararası ödeme sağlayıcısı Paddle tarafından güvenle açılır. Kart bilgileri WECOMMANDER uygulamasına aktarılmaz.")}</p><div className="mt-8 grid gap-4"><div className="flex items-start gap-3"><ShieldCheck className="text-[var(--accent)]"/><div><strong className="text-sm">{translate("Güvenli checkout")}</strong><p className="muted text-xs mt-1">{translate("Paddle üzerinden şifreli ödeme akışı")}</p></div></div><div className="flex items-start gap-3"><KeyRound className="text-[var(--accent)]"/><div><strong className="text-sm">{translate("Sunucu tarafında doğrulama")}</strong><p className="muted text-xs mt-1">{translate("Abonelik yalnızca doğrulanmış ödeme bildirimiyle etkinleşir.")}</p></div></div></div></div>
    <Card className="p-8 h-fit"><Badge>{data?.paddle.environment==="sandbox"?translate("Test ortamı"):translate("Paket özeti")}</Badge><h2 className="text-2xl font-bold mt-5">{plan?.name||translate("Paket seçilmedi")}</h2><p className="muted mt-2 text-sm">{plan?.description||translate("Devam etmek için geçerli bir paket seçin.")}</p><p className="text-3xl font-extrabold my-8">{plan?.priceLabel||translate("Fiyat tanımlanmadı")}</p><div className="grid gap-3 border-t border-[var(--stroke)] pt-6 mb-7">{(plan?features(plan):[]).map(x=><div className="flex gap-2 text-sm muted" key={x}><CheckCheck size={17} className="text-[var(--success)]"/>{x}</div>)}</div>
     {message&&<div role="alert" className="form-error mb-5">{message}</div>}
     <Button className="w-full" size="lg" onClick={checkout} disabled={!plan?.priceId||!data?.paddle.checkoutEnabled||busy}>{busy?"Ödeme hazırlanıyor…":translate("Paddle ile güvenli ödeme")}<ExternalLink size={17}/></Button>
     {!account&&<p className="text-sm mt-4 muted">{translate("Devam etmek için")} <NavLink to="/login" nav={nav} className="text-[var(--accent)] font-semibold">{translate("giriş yapın")}</NavLink>.</p>}
     <p className="text-xs muted mt-5">{translate("Satın alma öncesinde fiyat, vergi ve dönem bilgilerini Paddle checkout ekranında kontrol edin. İade ve iptal koşulları ödeme sayfasında gösterilmelidir.")}</p>
    </Card>
   </div>
  </section>}
 </div>;
}
