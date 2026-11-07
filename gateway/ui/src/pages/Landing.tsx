import {useEffect,useRef,useState} from "react";
import { t as translate,useLocale } from "../i18n";
import {ArrowRight,ArrowUpRight,Check,CheckCheck,ChevronRight,ClipboardCheck,Copy,Database,FileText,KeyRound,LockKeyhole,Monitor,MousePointerClick,Plug2,ShieldCheck,Sparkles,TerminalSquare,Zap} from "lucide-react";
import type{Nav}from"../App";import type{Pricing}from"../api";
import{Button,Card,Badge}from"../components/ui";
import {api} from "../api";import{Brand,NavLink}from"../App";

// Every literal below is a CMS key (see landing-copy-sections.ts) and has an
// English entry in i18n-marketing.ts.
const features=[
{icon:Monitor,title:"Tek MCP adresi, tüm cihazlar",text:"Sunucularını ve bilgisayarlarını tek uç noktaya bağla; yapay zekân istediği makinede çalışır. Gelen bağlantı portu açman gerekmez."},
{icon:ShieldCheck,title:"Sunucu tarafında onay",text:"Yüksek riskli işlemler tek kullanımlık onay ister. Cihaz başına Sıkı, Standart veya Tam güven seviyesi ve izinli komut listesi seç."},
{icon:LockKeyhole,title:"Root olmayan agent",text:"Agent ayrı bir servis kullanıcısıyla, yalnızca izin verdiğin klasörlerde çalışır. Yazma ve komut yetkileri cihazda ayrıca açılır."},
{icon:FileText,title:"Dosyalarda cerrahi düzenleme",text:"edit_block, SHA-256 korumalı yazma, sürümler ve geri alma. PDF, DOCX ve XLSX okuma dahil."},
{icon:TerminalSquare,title:"Gerçek terminal ve görevler",text:"Etkileşimli terminal oturumları, uzun süren görevler, süreç listesi ve süreç ağacı temizliği."},
{icon:Database,title:"Eksiksiz denetim kaydı",text:"Kim, hangi yapay zekâyla, hangi cihazda ne yaptı: her çağrı rol ve sonuçla birlikte kaydedilir."}
];
const steps=[
{num:"01 / KUR",title:"Tek satırla kur",desc:"Cihazda kurulum komutunu çalıştır. Paket, yayınlanan SHA-256 özetiyle doğrulanır.",icon:TerminalSquare},
{num:"02 / ONAYLA",title:"Tarayıcıda onayla",desc:"Terminalde çıkan bağlantıyı aç, hesabınla giriş yap ve cihazı çalışma alanına ekle.",icon:KeyRound},
{num:"03 / BAĞLA",title:"Yapay zekâna ekle",desc:"MCP adresini Claude, ChatGPT veya başka bir istemciye ekle ve OAuth ile izin ver.",icon:Plug2}
];
const comparison:[string,string,string][]=[
["Çalıştığı istemciler","Yerel masaüstü istemcileri","claude.ai web, ChatGPT, mobil ve her MCP istemcisi"],
["Uzak sunucular","Her makinede ayrı kurulum ve bağlantı","Tek uç nokta, açık port yok"],
["Yetki","Kullanıcının tüm yetkileri","Root olmayan servis kullanıcısı, izinli klasörler"],
["Onay","İstemci tarafında","Sunucu tarafında, tek kullanımlık"],
["Denetim","Yerel","Merkezi, rol ve sonuçla"],
["Geri alma","Yok","Sürümler ve geri alma"]
];
const clients=["Claude","ChatGPT","Cursor","VS Code","Claude Desktop"];
const faq:[string,string][]=[
["Hangi yapay zekâ istemcileriyle çalışır?","Uzak MCP destekleyen her istemciyle: claude.ai ve Claude Desktop, ChatGPT, Cursor, VS Code ve diğerleri. Bağlantı OAuth ile kurulur."],
["Sunucumda port açmam gerekir mi?","Hayır. Agent WECOMMANDER'a dışarıya doğru güvenli bir bağlantı kurar; gelen bağlantı portu gerekmez."],
["Yapay zekâ onaysız ne yapabilir?","Okuma işlemleri onaysız çalışır. Komut çalıştırma, silme ve terminal gibi yüksek riskli işlemler cihazın güven seviyesine göre onay ister; izinli komut listesindekiler onaysız çalışır."],
["Hangi işletim sistemleri destekleniyor?","Windows 10/11, macOS (Apple Silicon ve Intel) ve Linux (Ubuntu/Debian, amd64)."],
["Paket ücretini nerede ödeyeceğim?","Bulut aboneliği etkinleştirildiyse ödeme Paddle tarafından sunulan güvenli checkout ekranında tamamlanır."],
["Self-hosted sürümü kullanabilir miyim?","Evet, kendi altyapınızda çalıştırma için dağıtım modu destekleniyor. Kurulum ve işletim sorumluluğu size ait olabilir."]
];
export function Landing({nav,pricing,signupEnabled}:{nav:Nav;pricing:Pricing|null;signupEnabled:boolean|null}){
 const [siteCopy,setSiteCopy]=useState<{hero_title:string;hero_subtitle:string;overrides:Record<string,string>;seo_title:string;seo_description:string}|null>(null);
 const [copied,setCopied]=useState(false);
 const copy=(source:string)=>siteCopy?.overrides?.[source]||translate(source);
 const language=useLocale();
 const installLine=`curl -fsSL ${location.origin}/install.sh | sh`;
 useEffect(()=>{
  const previousTitle=document.title;
  const description=document.querySelector<HTMLMetaElement>('meta[name="description"]');
  const previousDescription=description?.content;
  if(siteCopy?.seo_title)document.title=siteCopy.seo_title;
  if(siteCopy?.seo_description&&description)description.content=siteCopy.seo_description;
  return()=>{document.title=previousTitle;if(description&&previousDescription!==undefined)description.content=previousDescription};
 },[siteCopy]);
 useEffect(()=>{let mounted=true;api<{item:{hero_title:string;hero_subtitle:string;overrides:Record<string,string>;seo_title:string;seo_description:string}|null}>("/api/public/site-content?locale="+language).then(r=>{if(mounted)setSiteCopy(r.item)}).catch(()=>{if(mounted)setSiteCopy(null)});return()=>{mounted=false}},[language]);
 const progress=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const nodes=document.querySelectorAll("[data-reveal]");const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(reduced){nodes.forEach(el=>el.classList.add("visible"));return}
  const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add("visible");observer.unobserve(entry.target)}}),{rootMargin:"0px 0px -50px 0px",threshold:.07});
  nodes.forEach(el=>observer.observe(el));return()=>observer.disconnect();
 },[]);
 useEffect(()=>{
  const update=()=>{const max=document.documentElement.scrollHeight-innerHeight;if(progress.current)progress.current.style.width=(max>0?Math.round(scrollY/max*100):0)+"%"};
  window.addEventListener("scroll",update,{passive:true});update();return()=>window.removeEventListener("scroll",update);
 },[]);
 const copyInstall=async()=>{try{await navigator.clipboard.writeText(installLine);setCopied(true);setTimeout(()=>setCopied(false),1800)}catch{setCopied(false)}};
 const start=()=>nav(signupEnabled===false?"/login":"/register");
 return <div>
  <div className="scroll-progress" ref={progress} aria-hidden="true"/>
  <section className="hero-modern">
   <div className="container-w hero-grid">
    <div className="hero-copy">
     <div className="hero-badge"><i/> {copy("Uzak MCP · Claude, ChatGPT ve her MCP istemcisi için")}</div>
     <h1 className="h1">{siteCopy?.hero_title||<>{copy("Yapay zekân,")}<br/><span className="text-gradient">{copy("tüm makinelerinde.")}</span></>}</h1>
     <p>{siteCopy?.hero_subtitle||copy("WECOMMANDER, kullandığın yapay zekâyı tek bir MCP adresiyle Windows, macOS ve Linux makinelerine bağlar. Terminal, dosya ve görevler; sunucu tarafı onaylar, root olmayan agent ve eksiksiz denetim kaydıyla.")}</p>
     <div className="hero-actions"><Button size="lg" onClick={start}>{signupEnabled===false?copy("Giriş Yap"):copy("Ücretsiz başla")} <ArrowRight size={19}/></Button><Button size="lg" variant="outline" onClick={()=>nav("/install")}>{copy("Kurulum rehberi")} <ArrowUpRight size={18}/></Button></div>
     <div className="hero-install"><span className="hero-install-label">{copy("Tek satırda kur")}</span><code>{installLine}</code><button type="button" onClick={copyInstall} aria-label={copy("Kurulum komutunu kopyala")}>{copied?<ClipboardCheck size={16}/>:<Copy size={16}/>}</button><span className="sr-only" role="status">{copied?copy("Kopyalandı"):""}</span></div>
     <div className="hero-proof"><span><Check/> {copy("Açık port gerekmez")}</span><span><Check/> {copy("Root olmayan agent")}</span><span><Check/> {copy("Self-host seçeneği")}</span></div>
    </div>
    <figure className="session-preview" aria-labelledby="session-caption">
     <figcaption id="session-caption" className="sr-only">{copy("Örnek MCP oturumu: yapay zekâ bir sunucuda komut çalıştırıyor, yüksek riskli komut onay bekliyor.")}</figcaption>
     <div className="session-window" aria-hidden="true">
      <div className="window-top"><span className="window-dot"/><span className="window-dot"/><span className="window-dot"/><span className="window-title">Claude · WECOMMANDER</span></div>
      <div className="session-body">
       <div className="session-user">{copy("ubuntu-prod'da disk doluluğunu kontrol et ve 7 günden eski logları temizle.")}</div>
       <div className="session-call"><div className="session-call-head"><TerminalSquare size={14}/><code>process_exec</code><span>ubuntu-prod</span><em className="ok"><Check size={12}/> {copy("İzinli komut")}</em></div><code className="session-cmd">df -h /var</code><pre className="session-out">{"Filesystem  Size  Used Avail Use%\n/dev/sda1    80G   61G   19G  77%"}</pre></div>
       <div className="session-call"><div className="session-call-head"><TerminalSquare size={14}/><code>process_exec</code><span>ubuntu-prod</span><em className="wait"><MousePointerClick size={12}/> {copy("Onay bekliyor")}</em></div><code className="session-cmd">find /var/log/app -mtime +7 -delete</code><div className="session-approve"><span>{copy("Onayla")}</span><span>{copy("Reddet")}</span></div></div>
       <div className="session-foot"><ShieldCheck size={14}/> {copy("Her çağrı denetim kaydına yazılır.")}</div>
      </div>
     </div>
    </figure>
   </div>
  </section>
  <div className="marquee-strip" aria-label={copy("Desteklenen yapay zekâ istemcileri")}><div className="marquee-inner">{clients.map(c=><span key={c} className="flex gap-2 items-center"><Sparkles aria-hidden="true"/> {c}</span>)}<span className="flex gap-2 items-center"><Plug2 aria-hidden="true"/> {copy("Her MCP istemcisi")}</span></div></div>
  <section id="features" className="section-modern"><div className="container-w">
   <div className="section-heading" data-reveal><span className="eyebrow">{copy("YETENEKLER")}</span><h2 className="h2 mt-4">{copy("Yapay zekâya gerçek yetki.")}<br/><span className="text-gradient">{copy("Sınırları sen çiz.")}</span></h2><p>{copy("Terminal ve dosyalara tam erişim; her adımda kimin, neyi, nerede yaptığı belli.")}</p></div>
   <div className="features-grid">{features.map((f,i)=><Card key={f.title} className="feature-card" data-reveal style={{transitionDelay:((i%3)*85)+"ms"}}>{typeof siteCopy?.overrides?.["media:feature:"+i]==="string"&&/^[0-9a-f-]{36}$/i.test(siteCopy.overrides["media:feature:"+i])&&
  <img loading="lazy" className="w-full h-32 object-cover rounded-xl mb-5" src={"/api/public/media/"+siteCopy.overrides["media:feature:"+i]} alt={copy(f.title)}/>}
  <div className="feature-icon"><f.icon size={24} aria-hidden="true"/></div><h3>{copy(f.title)}</h3><p>{copy(f.text)}</p></Card>)}</div>
  </div></section>
  <section id="how-it-works" className="section-modern alt"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">{copy("3 ADIMDA BAŞLA")}</span><h2 className="h2 mt-4">{copy("İki dakikada hazır.")}<br/>{copy("İki işlemle bağlı.")}</h2><p>{copy("Bir komut çalıştır, tarayıcıda onayla, MCP adresini yapay zekâna ekle.")}</p></div><div className="steps-grid">{steps.map(step=><div className="step" data-reveal key={step.num}><div className="flex items-center justify-between"><span className="number">{copy(step.num)}</span><step.icon size={23} color="var(--accent)" aria-hidden="true"/></div><h3>{copy(step.title)}</h3><p>{copy(step.desc)}</p></div>)}</div><div className="flex justify-center mt-10" data-reveal><Button variant="outline" onClick={()=>nav("/install")}>{copy("Kurulum rehberi")} <ArrowRight size={16}/></Button></div></div></section>
  <section id="compare" className="section-modern"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">{copy("KARŞILAŞTIRMA")}</span><h2 className="h2 mt-4">{copy("Yerel MCP araçlarının ötesinde.")}</h2><p>{copy("Masaüstü MCP araçları tek makinede, kullanıcının tüm yetkileriyle çalışır. WECOMMANDER aynı gücü tüm makinelerine güvenlik katmanlarıyla taşır.")}</p></div>
   <div className="compare-wrap" data-reveal><table className="compare-table"><caption className="sr-only">{copy("Yerel masaüstü MCP araçları ile WECOMMANDER karşılaştırması")}</caption><thead><tr><th scope="col"><span className="sr-only">{copy("Özellik")}</span></th><th scope="col">{copy("Yerel masaüstü MCP araçları")}</th><th scope="col">WECOMMANDER</th></tr></thead><tbody>{comparison.map(([row,local,ours])=><tr key={row}><th scope="row">{copy(row)}</th><td data-label={copy("Yerel masaüstü MCP araçları")}>{copy(local)}</td><td data-label="WECOMMANDER"><CheckCheck size={16} aria-hidden="true"/> {copy(ours)}</td></tr>)}</tbody></table></div>
  </div></section>
  <section className="section-modern alt"><div className="container-w"><div className="dark-spotlight" data-reveal><div><Badge><ShieldCheck size={14}/> {copy("ÖNCE GÜVENLİK")}</Badge><h2 className="mt-6">{copy("Yapay zekâya erişim ver.")}<br/>{copy("Kontrolü bırakma.")}</h2><p>{copy("Her komutun, her cihazın ve her yetkinin hesabı belli olsun. Bağlantı kurmak kadar güvenli yönetmek de önemli.")}</p><Button variant="outline" onClick={start}>{copy("Çalışma alanını oluştur")} <ChevronRight size={17}/></Button></div><div className="security-list"><span><KeyRound/> {copy("Tek kullanımlık, imzalı onaylar")}</span><span><ShieldCheck/> {copy("Cihaz başına güven seviyesi ve izinli komutlar")}</span><span><LockKeyhole/> {copy("OAuth ile bağlanan yapay zekâ istemcileri")}</span><span><Zap/> {copy("Denetim kaydı ve e-posta bildirimleri")}</span><span><Database/> {copy("Self-hosted çalışma seçeneği")}</span></div></div></div></section>
  <section className="section-modern" id="pricing"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">{copy("PAKETLER")}</span><h2 className="h2 mt-4">{copy("İhtiyacın kadar kullan.")}<br/>{copy("Şeffaf şekilde büyü.")}</h2><p>{pricing?.mode==="self_hosted"?copy("Kendi altyapınızda çalıştırma seçeneğini keşfedin."):copy("Paket ve ödeme bilgileri Paddle üzerinden güvenle yönetilir.")}</p></div><div className="grid max-w-[720px] mx-auto grid-cols-1 md:grid-cols-2 gap-5" data-reveal><Card className="p-7"><Badge>{copy("Kontrol sizde")}</Badge><h3 className="text-2xl font-bold mt-5">Self-hosted</h3><p className="muted mt-3 text-sm">{copy("Mevcut altyapınızda, kendi sunucunuzda yönetim.")}</p><ul className="grid gap-3 mt-7 mb-8 text-sm text-[var(--muted)]"><li className="flex gap-2"><CheckCheck size={17} color="var(--success)"/> {copy("Kendi sunucunuz")}</li><li className="flex gap-2"><CheckCheck size={17} color="var(--success)"/> {copy("Cihaz ve MCP yönetimi")}</li><li className="flex gap-2"><CheckCheck size={17} color="var(--success)"/> {copy("Yetki ve denetim")}</li></ul><Button variant="outline" className="w-full" onClick={()=>nav("/pricing")}>{copy("Seçenekleri incele")}</Button></Card><Card className="p-7 relative overflow-hidden"><div className="absolute -right-7 -top-10 size-36 rounded-full opacity-10" style={{background:"var(--accent)",filter:"blur(35px)"}}/><Badge>{copy("Bulutta çalışın")}</Badge><h3 className="text-2xl font-bold mt-5">WECOMMANDER Cloud</h3><p className="muted mt-3 text-sm">{copy("Bireysel ve ekip kullanımı için abonelik seçenekleri.")}</p><ul className="grid gap-3 mt-7 mb-8 text-sm text-[var(--muted)]"><li className="flex gap-2"><CheckCheck size={17} color="var(--success)"/> {copy("Merkezi kontrol paneli")}</li><li className="flex gap-2"><CheckCheck size={17} color="var(--success)"/> {copy("Plan bazlı kaynak limitleri")}</li><li className="flex gap-2"><CheckCheck size={17} color="var(--success)"/> {copy("Paddle ile faturalama")}</li></ul><Button className="w-full" onClick={()=>nav("/pricing")}>{copy("Paketleri görüntüle")} <ArrowRight size={16}/></Button></Card></div></div></section>
  <section className="section-modern alt" id="faq"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">{copy("SIK SORULANLAR")}</span><h2 className="h2 mt-4">{copy("Merak ettiklerin.")}</h2></div><div className="faq-list" data-reveal>{faq.map(([q,a])=><details key={q}><summary>{copy(q)}</summary><p>{copy(a)}</p></details>)}</div></div></section>
  <section className="section-modern"><div className="container-w"><div className="closing-cta" data-reveal><Sparkles className="mx-auto mb-5 text-[var(--accent)]" size={27} aria-hidden="true"/><h2 className="h2">{copy("Cihazların hazır.")}<br/>{copy("Sıra sende.")}</h2><p className="muted mt-5 mb-7">{copy("İlk sunucunu iki dakikada bağla ve yapay zekânla çalışmaya başla.")}</p><Button size="lg" onClick={start}>{signupEnabled===false?copy("Giriş Yap"):copy("Ücretsiz başla")} <ArrowRight size={18}/></Button></div></div></section>
  <footer className="site-footer"><div className="container-w"><div className="footer-grid"><div><Brand onClick={()=>nav("/")} subtitle/><p className="max-w-[260px]">{copy("Yapay zekân için tüm makinelerinde güvenli terminal ve dosya erişimi.")}</p></div><div><strong>{copy("Ürün")}</strong><NavLink to="/features" nav={nav}>{copy("Özellikler")}</NavLink><NavLink to="/pricing" nav={nav}>{copy("Paketler")}</NavLink><NavLink to="/install" nav={nav}>{copy("Kurulum")}</NavLink><NavLink to="/dashboard" nav={nav}>{copy("Uygulama")}</NavLink></div><div><strong>{copy("Hesap")}</strong><NavLink to="/login" nav={nav}>{copy("Giriş Yap")}</NavLink><NavLink to="/register" nav={nav}>{copy("Kayıt Ol")}</NavLink><NavLink to="/forgot-password" nav={nav}>{copy("Şifre Sıfırla")}</NavLink></div><div><strong>{copy("Kaynaklar")}</strong><NavLink to="/docs" nav={nav}>{copy("Dokümantasyon")}</NavLink><NavLink to="/faq" nav={nav}>{copy("Sık sorulanlar")}</NavLink><NavLink to="/alternatives" nav={nav}>{copy("Alternatifler")}</NavLink><NavLink to="/security" nav={nav}>{copy("Güvenlik")}</NavLink></div><div><strong>{copy("Yasal")}</strong><NavLink to="/privacy" nav={nav}>{copy("Gizlilik")}</NavLink><NavLink to="/terms" nav={nav}>{copy("Kullanım Koşulları")}</NavLink><a href="https://github.com/orhanbal/webrising-commender" target="_blank" rel="noopener noreferrer">GitHub</a><a href="/health" target="_blank" rel="noopener noreferrer">{copy("Sistem durumu")}</a></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} WECOMMANDER</span><span>{copy("Uzak MCP · Root olmayan agent · Sunucu tarafı onaylar")}</span></div></div></footer>
 </div>;
}
