import {useEffect,useRef} from "react";
import {ArrowRight,ArrowUpRight,Bot,Check,CheckCheck,ChevronRight,Command,Database,Globe2,HardDrive,KeyRound,LockKeyhole,Monitor,MousePointerClick,ShieldCheck,Sparkles,TerminalSquare,Workflow,Zap} from "lucide-react";
import type{Nav}from"../App";import type{Pricing}from"../api";
import{Button,Card,Badge}from"../components/ui";import{Brand,NavLink}from"../App";

const features=[
{icon:Monitor,title:"Tek panelden bütün cihazlar",text:"Windows, macOS ve Linux makinelerini aynı çalışma alanında izleyin. Bağlantı durumlarını görün, cihazlar arasında geçiş yapın."},
{icon:TerminalSquare,title:"Güvenli uzaktan terminal",text:"Komutları kontrollü çalıştırın, oturum geçmişini takip edin ve kritik işlemleri açık onay adımlarıyla yönetin."},
{icon:HardDrive,title:"Dosya ve klasör yönetimi",text:"Bağlı cihazlardaki dosyalarla çalışın. Yetkilendirilmiş aktarım ve dosya işlemlerini tek yerden başlatın."},
{icon:Bot,title:"MCP ile AI araçlarına bağlanın",text:"Uyumlu yapay zekâ istemcilerinize güvenli bir cihaz bağlantısı sağlayın; AI araçlarınız kontrol altında kalsın."},
{icon:ShieldCheck,title:"Kontrol sizde kalsın",text:"Rol tabanlı erişim, işlem kayıtları, cihaz kimlik doğrulaması ve yüksek riskli işlemler için onay akışları."},
{icon:Workflow,title:"Tekrarlanabilir operasyonlar",text:"Cihazlar, araçlar ve görev akışları arasında tutarlı, izlenebilir çalışma düzeni oluşturun."}
];
const steps=[
{num:"01 / BAĞLAN",title:"Cihazını ekle",desc:"Windows, Linux veya macOS makinenize agent kurulumunu tamamlayın; bağlantıyı güvenle oluşturun.",icon:Monitor},
{num:"02 / YETKİLENDİR",title:"Erişimleri belirle",desc:"Çalışma alanını oluşturun, cihazları yönetin ve hangi işlemlere kimlerin erişeceğine karar verin.",icon:KeyRound},
{num:"03 / YÖNET",title:"İstediğiniz yerden çalışın",desc:"Paneli veya desteklenen MCP istemcilerini kullanarak terminal, dosya ve görev operasyonlarınızı yürütün.",icon:Zap}
];
export function Landing({nav,pricing,signupEnabled}:{nav:Nav;pricing:Pricing|null;signupEnabled:boolean|null}){
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
 return <div>
  <div className="scroll-progress" ref={progress} aria-hidden="true"/>
  <section className="hero-modern">
   <div className="container-w hero-grid">
    <div className="hero-copy">
     <div className="hero-badge"><i/> WECOMMANDER · Yapay zekâ için uzak çalışma alanı <ArrowUpRight size={13}/></div>
     <h1 className="h1">Tüm cihazların.<br/><span className="text-gradient">Tek komuta.</span></h1>
     <p>Windows, macOS ve Linux cihazlarını güvenle bağla. Terminal, dosya ve görevlerini modern bir panelden veya MCP destekli yapay zekâ araçlarınla yönet.</p>
     <div className="hero-actions"><Button size="lg" onClick={()=>nav(signupEnabled===false?"/login":"/register")}>{signupEnabled===false?"Giriş Yap":"Hesap oluştur"} <ArrowRight size={19}/></Button><Button size="lg" variant="outline" onClick={()=>nav("/dashboard")}>Paneli keşfet <ArrowUpRight size={18}/></Button></div>
     <div className="hero-proof"><span><Check/> Güvenli erişim</span><span><Check/> Tek çalışma alanı</span><span><Check/> Windows · macOS · Linux</span></div>
    </div>
    <div className="preview-outer" aria-label="WECOMMANDER örnek arayüzü">
     <div className="window-preview">
      <div className="window-top"><span className="window-dot"/><span className="window-dot"/><span className="window-dot"/><span className="window-title">WECOMMANDER · Örnek arayüz</span></div>
      <div className="window-main"><div className="window-side"><span className="active"/><span/><span style={{width:"80%"}}/><span style={{width:"90%"}}/><span style={{width:"65%"}}/></div><div className="window-content"><div className="window-heading"><span>Çalışma alanım</span><span className="status-chip">Bağlantı hazır</span></div><div className="window-cards"><div className="window-card"><small>Cihazlar</small><strong>03</strong></div><div className="window-card"><small>Görevler</small><strong>12</strong></div><div className="window-card"><small>Güvenlik</small><strong><ShieldCheck size={22} color="var(--success)"/></strong></div></div><div className="window-lines"><div className="window-row"><div className="indicator"><Monitor size={15}/></div><div className="label"><strong>Windows Desktop</strong><small>Örnek cihaz</small></div><span className="online">● Aktif</span></div><div className="window-row"><div className="indicator"><TerminalSquare size={15}/></div><div className="label"><strong>Linux Server</strong><small>Örnek cihaz</small></div><span className="online">● Aktif</span></div><div className="window-row"><div className="indicator"><HardDrive size={15}/></div><div className="label"><strong>Mac Workstation</strong><small>Örnek cihaz</small></div><span className="text-[var(--muted)]">● Beklemede</span></div></div></div></div>
     </div><div className="floating-pill"><ShieldCheck size={18}/> Uçtan uca kontrol</div>
    </div>
   </div>
  </section>
  <div className="marquee-strip"><div className="marquee-inner"><span className="flex gap-2 items-center"><Monitor/> Windows</span><span className="flex gap-2 items-center"><Command/> macOS</span><span className="flex gap-2 items-center"><TerminalSquare/> Linux</span><span className="flex gap-2 items-center"><Bot/> AI / MCP</span><span className="flex gap-2 items-center"><LockKeyhole/> Yetkilendirilmiş erişim</span></div></div>
  <section id="features" className="section-modern"><div className="container-w">
   <div className="section-heading" data-reveal><span className="eyebrow">YETENEKLER</span><h2 className="h2 mt-4">Cihaz yönetiminde<br/><span className="text-gradient">yeni çalışma standardı.</span></h2><p>Tek bir uygulama. Dağınık araçlar yerine planlı, kontrollü ve kesintisiz iş akışı.</p></div>
   <div className="features-grid">{features.map((f,i)=><Card key={f.title} className="feature-card" data-reveal style={{transitionDelay:((i%3)*85)+"ms"}}><div className="feature-icon"><f.icon size={24}/></div><h3>{f.title}</h3><p>{f.text}</p><div className="flex items-center gap-1 text-sm mt-6 text-[var(--accent)] font-semibold">Detayları panelde keşfet <ArrowUpRight size={15}/></div></Card>)}</div>
  </div></section>
  <section id="how-it-works" className="section-modern alt"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">3 ADIMDA BAŞLA</span><h2 className="h2 mt-4">Karmaşıklığı kaldır.<br/>Kontrolü eline al.</h2><p>Cihazlarını bağlamaktan akıllı iş akışlarına kadar her şey aynı çalışma alanında.</p></div><div className="steps-grid">{steps.map(step=><div className="step" data-reveal key={step.num}><div className="flex items-center justify-between"><span className="number">{step.num}</span><step.icon size={23} color="var(--accent)"/></div><h3>{step.title}</h3><p>{step.desc}</p></div>)}</div></div></section>
  <section className="section-modern"><div className="container-w"><div className="dark-spotlight" data-reveal><div><Badge><ShieldCheck size={14}/> SECURITY FIRST</Badge><h2 className="mt-6">Yapay zekâya erişim ver.<br/>Kontrolü bırakma.</h2><p>Her komutun, her cihazın ve her yetkinin hesabı belli olsun. Bağlantı kurmak kadar güvenli yönetmek de önemli.</p><Button variant="outline" onClick={()=>nav(signupEnabled===false?"/login":"/register")}>Çalışma alanını oluştur <ChevronRight size={17}/></Button></div><div className="security-list"><span><ShieldCheck/> Denetlenebilir işlemler ve denetim kayıtları</span><span><LockKeyhole/> Korumalı oturumlar ve roller</span><span><MousePointerClick/> Kritik aksiyonlarda kullanıcı onayı</span><span><Database/> Self-hosted çalışma seçeneği</span><span><Globe2/> Uzak bağlantı üzerinden merkezi yönetim</span></div></div></div></section>
  <section className="section-modern alt" id="pricing"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">PAKETLER</span><h2 className="h2 mt-4">İhtiyacın kadar kullan.<br/>Şeffaf şekilde büyü.</h2><p>{pricing?.mode==="self_hosted"?"Kendi altyapınızda çalıştırma seçeneğini keşfedin.":"Paket ve ödeme bilgileri Paddle üzerinden güvenle yönetilir."}</p></div><div className="grid max-w-[720px] mx-auto grid-cols-1 md:grid-cols-2 gap-5" data-reveal><Card className="p-7"><Badge>Kontrol sizde</Badge><h3 className="text-2xl font-bold mt-5">Self-hosted</h3><p className="muted mt-3 text-sm">Mevcut altyapınızda, kendi sunucunuzda yönetim.</p><ul className="grid gap-3 mt-7 mb-8 text-sm text-[var(--muted)]"><li className="flex gap-2"><CheckCheck size={17} color="var(--success)"/> Kendi sunucunuz</li><li className="flex gap-2"><CheckCheck size={17} color="var(--success)"/> Cihaz ve MCP yönetimi</li><li className="flex gap-2"><CheckCheck size={17} color="var(--success)"/> Yetki ve denetim</li></ul><Button variant="outline" className="w-full" onClick={()=>nav("/pricing")}>Seçenekleri incele</Button></Card><Card className="p-7 relative overflow-hidden"><div className="absolute -right-7 -top-10 size-36 rounded-full opacity-10" style={{background:"var(--accent)",filter:"blur(35px)"}}/><Badge>Bulutta çalışın</Badge><h3 className="text-2xl font-bold mt-5">WECOMMANDER Cloud</h3><p className="muted mt-3 text-sm">Bireysel ve ekip kullanımı için abonelik seçenekleri.</p><ul className="grid gap-3 mt-7 mb-8 text-sm text-[var(--muted)]"><li className="flex gap-2"><CheckCheck size={17} color="var(--success)"/> Merkezi kontrol paneli</li><li className="flex gap-2"><CheckCheck size={17} color="var(--success)"/> Plan bazlı kaynak limitleri</li><li className="flex gap-2"><CheckCheck size={17} color="var(--success)"/> Paddle ile faturalama</li></ul><Button className="w-full" onClick={()=>nav("/pricing")}>Paketleri görüntüle <ArrowRight size={16}/></Button></Card></div></div></section>
  <section className="section-modern" id="faq"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">SIK SORULANLAR</span><h2 className="h2 mt-4">Merak ettiklerin.</h2></div><div className="faq-list" data-reveal>{[
    ["Hangi işletim sistemleri destekleniyor?","Windows, macOS ve Linux için agent altyapısı bulunuyor. Özellik kapsamı işletim sistemine ve agent sürümüne göre değişebilir."],
    ["WECOMMANDER nasıl güvenli çalışıyor?","Cihaz kimliği, hesap rolleri, oturum kontrolleri ve yüksek riskli işlemler için onay mekanizmaları kullanılıyor."],
    ["AI araçlarıma bağlayabilir miyim?","MCP protokolü üzerinden uyumlu yapay zekâ istemcileriyle bağlantı oluşturabilirsiniz."],
    ["Paket ücretini nerede ödeyeceğim?","Bulut aboneliği etkinleştirildiyse ödeme Paddle tarafından sunulan güvenli checkout ekranında tamamlanır."],
    ["Self-hosted sürümü kullanabilir miyim?","Evet, kendi altyapınızda çalıştırma için dağıtım modu destekleniyor. Kurulum ve işletim sorumluluğu size ait olabilir."]
  ].map(([q,a])=><details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div></div></section>
  <section className="section-modern pt-0"><div className="container-w"><div className="closing-cta" data-reveal><Sparkles className="mx-auto mb-5 text-[var(--accent)]" size={27}/><h2 className="h2">Cihazların hazır.<br/>Sıra sende.</h2><p className="muted mt-5 mb-7">Daha akıllı bir çalışma alanı oluşturmak için şimdi başla.</p><Button size="lg" onClick={()=>nav(signupEnabled===false?"/login":"/register")}>{signupEnabled===false?"Giriş Yap":"Hesap oluştur"} <ArrowRight size={18}/></Button></div></div></section>
  <footer className="site-footer"><div className="container-w"><div className="footer-grid"><div><Brand onClick={()=>nav("/")} subtitle/><p className="max-w-[260px]">Güvenli cihaz yönetimi ve yapay zekâ araçları için tek çalışma alanı.</p></div><div><strong>Ürün</strong><NavLink to="/features" nav={nav}>Özellikler</NavLink><NavLink to="/pricing" nav={nav}>Paketler</NavLink><NavLink to="/dashboard" nav={nav}>Uygulama</NavLink></div><div><strong>Hesap</strong><NavLink to="/login" nav={nav}>Giriş Yap</NavLink><NavLink to="/register" nav={nav}>Kayıt Ol</NavLink><NavLink to="/forgot-password" nav={nav}>Şifre Sıfırla</NavLink></div><div><strong>Belgeler</strong><NavLink to="/privacy" nav={nav}>Gizlilik</NavLink><NavLink to="/terms" nav={nav}>Kullanım Koşulları</NavLink><a href="/health" target="_blank" rel="noopener noreferrer">Sistem durumu</a></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} WECOMMANDER</span><span>Windows 11 Fluent tasarım yaklaşımı · Güvenli MCP kontrolü</span></div></div></footer>
 </div>;
}
