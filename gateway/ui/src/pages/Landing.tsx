import {useEffect,useRef,useState} from "react";
import { t as translate,useLocale } from "../i18n";
import {Activity,ArrowRight,ArrowUpRight,Check,CheckCheck,ChevronRight,ClipboardCheck,Copy,Database,Download,HardDrive,KeyRound,LockKeyhole,MousePointerClick,Plug2,RefreshCw,ShieldCheck,Sparkles,TerminalSquare,Zap} from "lucide-react";
import type{Nav}from"../App";import type{Pricing}from"../api";
import{Button,Card,Badge}from"../components/ui";
import {api} from "../api";import{Brand,NavLink}from"../App";import{planText}from"./Plans";

// Every literal below is a CMS key (see landing-copy-sections.ts) and has an
// English entry in i18n-marketing.ts.
const features=[
{icon:TerminalSquare,title:"SSH, SFTP ve tüneller",text:"Kayıtlı sunucular, gruplar ve etiketler; sekmeli ve bölünmüş terminaller; sürükle-bırak SFTP; yerel, uzak ve SOCKS tüneller, jump host. Telnet, seri port ve Mosh da dahil."},
{icon:HardDrive,title:"Sunucu yönetimi",text:"Diski ne dolduruyor gör, güvenle temizle: eski loglar, paket önbelleği, Docker build önbelleği ve kullanılmayan imajlar (rootless Docker dahil). Süreçler ve zombi düzeltme. Sunucuya hiçbir şey kurmadan."},
{icon:Activity,title:"Canlı sunucu izleme",text:"Masaüstünün sol alt köşesinde CPU, bellek ve disk için akan çizgi grafikler. Tıkla, tüm sunucuların paneli açılsın; bir değer yükselince renk değiştirsin."},
{icon:Sparkles,title:"Yapay zekâ için tek MCP adresi",text:"Claude, ChatGPT ve Cursor'ı tek MCP adresiyle tüm makinelerine bağla: terminal, dosya, görevler ve sunucu yönetimi araçları. Gelen bağlantı portu açman gerekmez."},
{icon:ShieldCheck,title:"Her riskli adım senin onayınla",text:"Komut, silme ve servis yeniden başlatma gibi işlemler tek kullanımlık onay ister: web panelinden, e-postadan ya da masaüstü uygulamasının bildiriminden. İzinli komutlar ve süreli otonom mod da var."},
{icon:RefreshCw,title:"Uçtan uca şifreli senkronizasyon",text:"Sunucuların, anahtarların ve parçacıkların tüm cihazlarında eşitlenir; şifrelemeyi senin cihazın yapar, sunucumuz okuyamaz. Ekip kitaplığı ve canlı paylaşılan terminaller."},
{icon:Zap,title:"Parçacıklar ve akıllı terminal",text:"Sık kullandığın komutlar tek tıkla; geçmişten otomatik tamamlama; tüm sekmelere aynı anda yazma; oturum kayıtları ve terminal temaları."},
{icon:LockKeyhole,title:"Root olmayan agent",text:"Agent ayrı bir servis kullanıcısıyla, yalnızca izin verdiğin klasörlerde çalışır. Yazma ve komut yetkileri cihazda ayrıca açılır; çıktıdaki parola ve anahtarlar maskelenir."},
{icon:Database,title:"Eksiksiz denetim kaydı ve geri alma",text:"Kim, hangi yapay zekâyla, hangi cihazda ne yaptı: her çağrı kaydedilir. Dosya düzenlemelerinin sürümleri tutulur, tek tıkla geri alınır."}
];
const steps=[
{num:"01 / İNDİR",title:"Uygulamayı kur",desc:"Windows ve macOS için masaüstü uygulamasını indir. Paket, yayınlanan SHA-256 özetiyle doğrulanır ve kendini güncel tutar.",icon:Download},
{num:"02 / BAĞLAN",title:"Sunucularını ekle",desc:"Sunucu ekle ya da ~/.ssh/config dosyandan içe aktar. Terminal, SFTP, tüneller ve sunucu yönetimi hemen hazır.",icon:TerminalSquare},
{num:"03 / YAPAY ZEKÂ",title:"İstersen yapay zekânı bağla",desc:"MCP adresini Claude, ChatGPT veya başka bir istemciye ekle. Riskli her işlem senin onayına düşer.",icon:Plug2}
];
const comparison:[string,string,string][]=[
["Terminal, SFTP ve tüneller","Ayrı ayrı araçlarda","Tek uygulamada, sekmeli ve bölünmüş"],
["Sunucu bakımı","Komutları elle yazmak","Disk analizi, güvenli temizlik, zombi düzeltme"],
["Yapay zekâ","Yok ya da tek makinede, kullanıcının tüm yetkileriyle","Tüm makinelerde, tek MCP adresi, root olmayan agent"],
["Onay","İstemci tarafında ya da hiç","Sunucu tarafında, tek kullanımlık"],
["Senkronizasyon","Sunucuda okunabilir ya da hiç","Uçtan uca şifreli"],
["Denetim ve geri alma","Yerel ya da yok","Merkezi kayıt, sürümler ve geri alma"]
];
const clients=["Claude","ChatGPT","Cursor","VS Code","Claude Desktop"];
const faq:[string,string][]=[
["Yapay zekâ kullanmadan, sadece SSH istemcisi olarak kullanabilir miyim?","Evet. Masaüstü uygulaması tek başına tam bir SSH istemcisidir: terminal, SFTP, tüneller, parçacıklar ve sunucu yönetimi yapay zekâ olmadan çalışır. MCP bağlantısı isteğe bağlıdır."],
["Parolalarım ve anahtarlarım nerede saklanır?","Bilgisayarının işletim sistemi kasasında (Windows Kimlik Bilgileri, macOS Anahtar Zinciri). Senkronizasyonu açarsan veriler cihazında şifrelenip öyle gönderilir; sunucumuz içeriği okuyamaz."],
["Hangi yapay zekâ istemcileriyle çalışır?","Uzak MCP destekleyen her istemciyle: claude.ai ve Claude Desktop, ChatGPT, Cursor, VS Code ve diğerleri. Bağlantı OAuth ile kurulur."],
["Sunucumda port açmam gerekir mi?","Hayır. SSH için zaten açık olan bağlantıyı kullanırsın; yapay zekâ erişimi için agent WECOMMANDER'a dışarıya doğru güvenli bir bağlantı kurar."],
["Yapay zekâ onaysız ne yapabilir?","Okuma işlemleri onaysız çalışır. Komut çalıştırma, silme, temizlik ve servis yeniden başlatma gibi işlemler cihazın güven seviyesine göre onay ister; izinli komut listesindekiler onaysız çalışır."],
["Hangi işletim sistemleri destekleniyor?","Masaüstü uygulaması: Windows 10/11 ve macOS (Apple Silicon ve Intel); Linux için önizleme sürümü. Agent: Windows, macOS ve Linux (Ubuntu/Debian)."],
["Ödeme ve iade nasıl işliyor?","Ödemeler resmi satıcımız Paddle üzerinden güvenle alınır. Aboneliğini istediğin zaman iptal edebilirsin; ilk ödemeden sonraki 14 gün içinde koşulsuz iade alırsın."],
];
export function Landing({nav,pricing,signupEnabled}:{nav:Nav;pricing:Pricing|null;signupEnabled:boolean|null}){
 const [siteCopy,setSiteCopy]=useState<{hero_title:string;hero_subtitle:string;overrides:Record<string,string>;seo_title:string;seo_description:string}|null>(null);
 const [copied,setCopied]=useState(false);
 const copy=(source:string)=>siteCopy?.overrides?.[source]||translate(source);
 const language=useLocale();
 // The visitor's own system: PowerShell on Windows, sh elsewhere (the same commands as the Download page).
 const installLine=/Windows/i.test(navigator.userAgent)?`irm ${location.origin}/install.ps1 | iex`:`curl -fsSL ${location.origin}/install.sh | sh`;
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
     <div className="hero-badge"><i/> {copy("SSH istemcisi · Sunucu yönetimi · Yapay zekâ için MCP")}</div>
     <h1 className="h1">{siteCopy?.hero_title||<>{copy("Sunucuların, terminalin ve yapay zekân,")}<br/><span className="text-gradient">{copy("tek uygulamada.")}</span></>}</h1>
     <p>{siteCopy?.hero_subtitle||copy("WECOMMANDER; SSH, SFTP ve tünellerle sunucularını yönettiğin, diskini temizleyip canlı izlediğin bir masaüstü uygulaması. Aynı zamanda Claude ve ChatGPT'yi tek MCP adresiyle makinelerine bağlar: riskli her adım senin onayınla, her işlem denetim kaydında.")}</p>
     <div className="hero-actions"><Button size="lg" onClick={start}>{signupEnabled===false?copy("Giriş Yap"):copy("Ücretsiz başla")} <ArrowRight size={19}/></Button><Button size="lg" variant="outline" onClick={()=>nav("/download")}>{copy("Uygulamayı indir")} <Download size={18}/></Button></div>
     <div className="hero-install"><span className="hero-install-label">{copy("Tek satırda kur")}</span><code>{installLine}</code><button type="button" onClick={copyInstall} aria-label={copy("Kurulum komutunu kopyala")}>{copied?<ClipboardCheck size={16}/>:<Copy size={16}/>}</button><span className="sr-only" role="status">{copied?copy("Kopyalandı"):""}</span></div>
     <div className="hero-proof"><span><Check/> {copy("Windows ve macOS")}</span><span><Check/> {copy("Uçtan uca şifreli senkronizasyon")}</span><span><Check/> {copy("Açık port gerekmez")}</span></div>
    </div>
    <figure className="session-preview" aria-labelledby="session-caption">
     <figcaption id="session-caption" className="sr-only">{copy("Örnek MCP oturumu: yapay zekâ sunucunun diskini inceliyor, temizlik onay bekliyor.")}</figcaption>
     <div className="session-window" aria-hidden="true">
      <div className="window-top"><span className="window-dot"/><span className="window-dot"/><span className="window-dot"/><span className="window-title">Claude · WECOMMANDER</span></div>
      <div className="session-body">
       <div className="session-user">{copy("ubuntu-prod'un diski dolmak üzere. Neyin doldurduğunu bul ve güvenle temizle.")}</div>
       <div className="session-call"><div className="session-call-head"><HardDrive size={14}/><code>server_cleanup_scan</code><span>ubuntu-prod</span><em className="ok"><Check size={12}/> {copy("Salt okunur")}</em></div><pre className="session-out">{"Disk /           %91\nDocker build cache   33.8 GB\nUnused images        13.9 GB\nOld logs              1.2 GB"}</pre></div>
       <div className="session-call"><div className="session-call-head"><TerminalSquare size={14}/><code>server_cleanup_run</code><span>ubuntu-prod</span><em className="wait"><MousePointerClick size={12}/> {copy("Onay bekliyor")}</em></div><code className="session-cmd">docker builder prune -af</code><div className="session-approve"><span>{copy("Onayla")}</span><span>{copy("Reddet")}</span></div></div>
       <div className="session-foot"><ShieldCheck size={14}/> {copy("Her çağrı denetim kaydına yazılır.")}</div>
      </div>
     </div>
    </figure>
   </div>
  </section>
  <div className="marquee-strip" aria-label={copy("Desteklenen yapay zekâ istemcileri")}><div className="marquee-inner">{clients.map(c=><span key={c} className="flex gap-2 items-center"><Sparkles aria-hidden="true"/> {c}</span>)}<span className="flex gap-2 items-center"><Plug2 aria-hidden="true"/> {copy("Her MCP istemcisi")}</span></div></div>
  <section id="features" className="section-modern"><div className="container-w">
   <div className="section-heading" data-reveal><span className="eyebrow">{copy("YETENEKLER")}</span><h2 className="h2 mt-4">{copy("Sunucu işlerinin hepsi.")}<br/><span className="text-gradient">{copy("Yanında yapay zekâ.")}</span></h2><p>{copy("Bir SSH istemcisinden beklediğin her şey, sunucu bakımını kolaylaştıran araçlar ve sınırlarını senin çizdiğin bir yapay zekâ.")}</p></div>
   <div className="features-grid">{features.map((f,i)=><Card key={f.title} className="feature-card" data-reveal style={{transitionDelay:((i%3)*85)+"ms"}}>{typeof siteCopy?.overrides?.["media:feature:"+i]==="string"&&/^[0-9a-f-]{36}$/i.test(siteCopy.overrides["media:feature:"+i])&&
  <img loading="lazy" className="w-full h-32 object-cover rounded-xl mb-5" src={"/api/public/media/"+siteCopy.overrides["media:feature:"+i]} alt={copy(f.title)}/>}
  <div className="feature-icon"><f.icon size={24} aria-hidden="true"/></div><h3>{copy(f.title)}</h3><p>{copy(f.text)}</p></Card>)}</div>
  </div></section>
  <section id="how-it-works" className="section-modern alt"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">{copy("3 ADIMDA BAŞLA")}</span><h2 className="h2 mt-4">{copy("İki dakikada hazır.")}<br/>{copy("Yapay zekâ ise isteğe bağlı.")}</h2><p>{copy("Uygulamayı kur, sunucularını ekle; istersen yapay zekânı da bağla.")}</p></div><div className="steps-grid">{steps.map(step=><div className="step" data-reveal key={step.num}><div className="flex items-center justify-between"><span className="number">{copy(step.num)}</span><step.icon size={23} color="var(--accent)" aria-hidden="true"/></div><h3>{copy(step.title)}</h3><p>{copy(step.desc)}</p></div>)}</div><div className="flex justify-center mt-10" data-reveal><Button variant="outline" onClick={()=>nav("/download")}>{copy("Uygulamayı indir")} <ArrowRight size={16}/></Button><Button variant="outline" onClick={()=>nav("/install")}>{copy("Kurulum rehberi")} <ArrowUpRight size={16}/></Button></div></div></section>
  <section id="compare" className="section-modern"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">{copy("KARŞILAŞTIRMA")}</span><h2 className="h2 mt-4">{copy("Klasik araçların ötesinde.")}</h2><p>{copy("SSH istemcileri yalnızca bağlanır, yerel MCP araçları tek makinede tüm yetkilerle çalışır. WECOMMANDER ikisini tek uygulamada, güvenlik katmanlarıyla birleştirir.")}</p></div>
   <div className="compare-wrap" data-reveal><table className="compare-table"><caption className="sr-only">{copy("Klasik SSH istemcileri ve yerel MCP araçları ile WECOMMANDER karşılaştırması")}</caption><thead><tr><th scope="col"><span className="sr-only">{copy("Özellik")}</span></th><th scope="col">{copy("Klasik SSH istemcileri ve yerel MCP araçları")}</th><th scope="col">WECOMMANDER</th></tr></thead><tbody>{comparison.map(([row,local,ours])=><tr key={row}><th scope="row">{copy(row)}</th><td data-label={copy("Klasik SSH istemcileri ve yerel MCP araçları")}>{copy(local)}</td><td data-label="WECOMMANDER"><CheckCheck size={16} aria-hidden="true"/> {copy(ours)}</td></tr>)}</tbody></table></div>
  </div></section>
  <section className="section-modern alt"><div className="container-w"><div className="dark-spotlight" data-reveal><div><Badge><ShieldCheck size={14}/> {copy("ÖNCE GÜVENLİK")}</Badge><h2 className="mt-6">{copy("Yapay zekâya erişim ver.")}<br/>{copy("Kontrolü bırakma.")}</h2><p>{copy("Her komutun, her cihazın ve her yetkinin hesabı belli olsun. Bağlantı kurmak kadar güvenli yönetmek de önemli.")}</p><Button variant="outline" onClick={start}>{copy("Çalışma alanını oluştur")} <ChevronRight size={17}/></Button></div><div className="security-list"><span><KeyRound/> {copy("Tek kullanımlık, imzalı onaylar")}</span><span><ShieldCheck/> {copy("Cihaz başına güven seviyesi ve izinli komutlar")}</span><span><LockKeyhole/> {copy("OAuth ile bağlanan yapay zekâ istemcileri")}</span><span><Zap/> {copy("Denetim kaydı ve e-posta bildirimleri")}</span><span><Database/> {copy("Self-hosted çalışma seçeneği")}</span></div></div></div></section>
  <section className="section-modern" id="pricing"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">{copy("PAKETLER")}</span><h2 className="h2 mt-4">{copy("İhtiyacın kadar kullan.")}<br/>{copy("Şeffaf şekilde büyü.")}</h2><p>{copy("Paket ve ödeme bilgileri Paddle üzerinden güvenle yönetilir.")}</p></div><div className="grid max-w-[1040px] mx-auto grid-cols-1 md:grid-cols-3 gap-5" data-reveal>{(pricing?.plans||[]).slice(0,3).map(p=><Card key={p.key} className={"p-7 flex flex-col"+(p.featured?" relative overflow-hidden":"")}>{p.featured&&<div className="absolute -right-7 -top-10 size-36 rounded-full opacity-10" style={{background:"var(--accent)",filter:"blur(35px)"}}/>}<Badge>{p.featured?<Sparkles size={13}/>:<ShieldCheck size={13}/>} {p.free?copy("Ücretsiz"):p.featured?copy("Öne Çıkan"):"WECOMMANDER"}</Badge><h3 className="text-2xl font-bold mt-5">{p.name}</h3><p className="muted mt-3 text-sm">{planText(p.description,language)}</p><div className="text-2xl font-bold mt-5">{planText(p.priceLabel,language)}</div><div className="mt-auto pt-7"><Button variant={p.featured?"default":"outline"} className="w-full" onClick={()=>nav("/pricing")}>{copy("Paketleri görüntüle")} <ArrowRight size={16}/></Button></div></Card>)}{!(pricing?.plans||[]).length&&<Card className="p-7 md:col-span-3 text-center"><h3 className="text-2xl font-bold">WECOMMANDER</h3><p className="muted mt-3 text-sm">{copy("Bireysel ve ekip kullanımı için abonelik seçenekleri.")}</p><Button className="mt-6" onClick={()=>nav("/pricing")}>{copy("Paketleri görüntüle")} <ArrowRight size={16}/></Button></Card>}</div></div></section>
  <section className="section-modern alt" id="faq"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">{copy("SIK SORULANLAR")}</span><h2 className="h2 mt-4">{copy("Merak ettiklerin.")}</h2></div><div className="faq-list" data-reveal>{faq.map(([q,a])=><details key={q}><summary>{copy(q)}</summary><p>{copy(a)}</p></details>)}</div></div></section>
  <section className="section-modern"><div className="container-w"><div className="closing-cta" data-reveal><Sparkles className="mx-auto mb-5 text-[var(--accent)]" size={27} aria-hidden="true"/><h2 className="h2">{copy("Cihazların hazır.")}<br/>{copy("Sıra sende.")}</h2><p className="muted mt-5 mb-7">{copy("Uygulamayı indir, ilk sunucunu iki dakikada bağla. Ücretsiz planla başla, istediğin zaman iptal et.")}</p><Button size="lg" onClick={start}>{signupEnabled===false?copy("Giriş Yap"):copy("Ücretsiz başla")} <ArrowRight size={18}/></Button></div></div></section>
  <footer className="site-footer"><div className="container-w"><div className="footer-grid"><div><Brand onClick={()=>nav("/")} subtitle/><p className="max-w-[260px]">{copy("SSH istemcisi, sunucu yönetimi ve yapay zekâ için güvenli MCP; tek uygulamada.")}</p></div><div><strong>{copy("Ürün")}</strong><NavLink to="/features" nav={nav}>{copy("Özellikler")}</NavLink><NavLink to="/pricing" nav={nav}>{copy("Paketler")}</NavLink><NavLink to="/download" nav={nav}>{copy("İndir")}</NavLink><NavLink to="/install" nav={nav}>{copy("Kurulum")}</NavLink><NavLink to="/dashboard" nav={nav}>{copy("Uygulama")}</NavLink></div><div><strong>{copy("Hesap")}</strong><NavLink to="/login" nav={nav}>{copy("Giriş Yap")}</NavLink><NavLink to="/register" nav={nav}>{copy("Kayıt Ol")}</NavLink><NavLink to="/forgot-password" nav={nav}>{copy("Şifre Sıfırla")}</NavLink></div><div><strong>{copy("Kaynaklar")}</strong><NavLink to="/docs" nav={nav}>{copy("Dokümantasyon")}</NavLink><NavLink to="/faq" nav={nav}>{copy("Sık sorulanlar")}</NavLink><NavLink to="/alternatives" nav={nav}>{copy("Alternatifler")}</NavLink><NavLink to="/security" nav={nav}>{copy("Güvenlik")}</NavLink></div><div><strong>{copy("Yasal")}</strong><NavLink to="/privacy" nav={nav}>{copy("Gizlilik")}</NavLink><NavLink to="/terms" nav={nav}>{copy("Kullanım Koşulları")}</NavLink><NavLink to="/refund" nav={nav}>{copy("İade ve İptal")}</NavLink><a href="https://github.com/orhanbal/webrising-commender" target="_blank" rel="noopener noreferrer">GitHub</a><a href="/health" target="_blank" rel="noopener noreferrer">{copy("Sistem durumu")}</a></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} WECOMMANDER</span><span>{copy("SSH · SFTP · Sunucu yönetimi · Uzak MCP · Sunucu tarafı onaylar")}</span></div></div></footer>
 </div>;
}
