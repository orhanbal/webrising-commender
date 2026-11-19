import {useEffect,useRef,useState} from "react";
import { t as translate,useLocale } from "../i18n";
import {Activity,ArrowRight,CalendarClock,ArrowUpRight,Check,CheckCheck,ChevronRight,ClipboardCheck,Copy,Database,Download,EyeOff,HardDrive,Info,KeyRound,LockKeyhole,MousePointerClick,Plug2,RefreshCw,Server,ShieldCheck,Sparkles,TerminalSquare,Zap,iconVariant} from "../components/icons";
import type{Nav}from"../App";import type{Pricing}from"../api";
import{Button,Card,Badge}from"../components/ui";
import {api} from "../api";import{Brand,NavLink}from"../App";import{planText}from"./Plans";import{clientLogos}from"../components/ClientLogos";

// Every literal below is a CMS key (see landing-copy-sections.ts) and has an
// English entry in i18n-marketing.ts.
const features=[
{icon:TerminalSquare,tone:"sky",title:"SSH, SFTP ve tüneller",text:"Kayıtlı sunucular ve gruplar; sekmeli ve bölünmüş terminaller; sürükle-bırak SFTP; yerel, uzak ve SOCKS tüneller, jump host. SSH agent ve FIDO2 donanım anahtarlarıyla giriş. Telnet, seri port ve Mosh da dahil. Parçacıklar, otomatik tamamlama, oturum kayıtları, terminal temaları ve yedek dışa/içe aktarma."},
{icon:HardDrive,tone:"amber",title:"Sunucu yönetimi",text:"Diski ne dolduruyor gör, güvenle temizle: eski loglar, paket önbelleği, Docker build önbelleği ve kullanılmayan imajlar (rootless Docker dahil). Süreçler ve zombi düzeltme. Sunucuya hiçbir şey kurmadan."},
{icon:Activity,tone:"green",title:"Canlı izleme ve Dock",text:"Windows'ta WECOMMANDER Dock, görev çubuğu gibi ekranın kenarında durur: sunucunun CPU, bellek ve disk grafikleri; Görev Yöneticisi, Görevler, Terminal ve onaylar Dock'tan açılan panellerde. Dock istemezsen Klasik modda uygulama pencerelerle çalışır. macOS'ta canlı izleme menü çubuğunda."},
{icon:Sparkles,tone:"violet",title:"Yapay zekâ için tek MCP adresi",text:"Claude, ChatGPT ve Cursor'ı tek MCP adresiyle tüm makinelerine bağla: terminal, dosya, zamanlanmış görevler, Docker container'ları ve sunucu yönetimi araçları. Hibrit Erişim ile agent kurmadığın SSH sunucuları da bilgisayarındaki Windows uygulaması üzerinden bağlanır; temizlik, zamanlayıcılar ve Docker araçları dahil. Anahtarların bilgisayarından çıkmaz, gelen bağlantı portu açman gerekmez."},
{icon:ShieldCheck,tone:"green",title:"Her riskli adım senin onayınla",text:"Komut, silme, servis ya da container yeniden başlatma ve zamanlanmış görev değişiklikleri tek kullanımlık onay ister: web panelinden, e-postadan ya da masaüstü uygulamasının bildiriminden. İzinli komutlar da var; güvendiğin cihazı süreli ya da süresiz tam güvene alabilirsin."},
{icon:RefreshCw,tone:"sky",title:"Uçtan uca şifreli senkronizasyon",text:"Sunucuların, anahtarların ve parçacıkların tüm cihazlarında eşitlenir; şifrelemeyi senin cihazın yapar, sunucumuz okuyamaz. Ekip kitaplığı ve canlı paylaşılan terminaller."},
{icon:CalendarClock,tone:"amber",title:"Zamanlanmış görevler",text:"Komutun her gece 03:00'te ya da her 15 dakikada bir çalışsın: zamanı gelince WECOMMANDER onu cihazdaki ajana gönderir, bilgisayarın kapalıyken bile; kayıtlı SSH sunucularında uygulaman çalıştırır. Sunucudaki systemd zamanlayıcıları, cron ve Windows görevleri de uygulamada. Sonuç ve çıktı geçmişte; başarısız olursa e-posta gelir. Yapay zekâ da görevleri yönetebilir: değişiklikler onayınla, tam güvendeki cihazlarda onaysız."},
{icon:LockKeyhole,tone:"violet",title:"Cihaz başına yapay zekâ yetkileri",text:"Agent varsayılan olarak ayrı bir servis kullanıcısıyla, yalnızca izin verdiğin klasörlerde çalışır. Güven seviyesini ve süresini cihaz başına sen seçersin; Linux'ta root iki anahtarla açılır. Güvenlik ağı geri dönüşü olmayan komutları root'ta bile engeller; çıktıdaki parolalar maskelenir."},
{icon:Database,tone:"rose",title:"Eksiksiz denetim kaydı ve geri alma",text:"Kim, hangi yapay zekâyla, hangi cihazda ne yaptı: her çağrı kaydedilir. Dosya düzenlemelerinin sürümleri tutulur, tek tıkla geri alınır."}
];
const steps=[
{num:"01 / İNDİR",title:"Uygulamayı kur",desc:"Windows ve macOS için masaüstü uygulamasını indir. Paket, yayınlanan SHA-256 özetiyle doğrulanır ve kendini güncel tutar.",icon:Download},
{num:"02 / BAĞLAN",title:"Sunucularını ekle",desc:"Sunucu ekle ya da ~/.ssh/config dosyandan içe aktar. Terminal, SFTP, tüneller ve sunucu yönetimi hemen hazır.",icon:TerminalSquare},
{num:"03 / YAPAY ZEKÂ",title:"İstersen yapay zekânı bağla",desc:"MCP adresini Claude, ChatGPT veya başka bir istemciye ekle. Riskli her işlem senin onayına düşer.",icon:Plug2}
];
// The two ways a server reaches the AI (agent, or Hybrid Access over SSH).
const connectWays:{icon:typeof Server;title:string;desc:string;points:string[]}[]=[
{icon:Server,title:"Ajan ile",desc:"Makineye küçük bir ajan kurulur: Windows, macOS ya da Linux.",points:["Tek giden şifreli bağlantı; gelen port ya da VPN gerekmez","Bilgisayarın kapalıyken de çalışır; zamanlanmış görevler cihazda koşar","Tüm araçlar: terminal, dosyalar, arka plan görevleri, sunucu ve Docker araçları","Cihaz başına yetkiler; tam güvende onaysız da çalışabilir","Linux'ta iki anahtarla root"]},
{icon:KeyRound,title:"SSH ile, kurulum yok",desc:"Sunucuya hiçbir şey kurulmaz; bağlantıyı bilgisayarındaki WECOMMANDER kurar: Windows, macOS ya da Linux.",points:["SSH anahtarların bilgisayarından çıkmaz","Bilgisayarın ve uygulama açık olmalı","Komutlar, dosyalar (SFTP), genel durum, disk, süreçler ve sinyaller, temizlik, zamanlayıcılar, Docker","Ajanla aynı yetkiler: sunucu başına güven seviyesi, izinli komutlar, tam güvende onaysız","Root iki anahtarla: bilgisayarındaki sudo izni ve web'den şifrenle; güvenlik ağı burada da geçerli"]}
];
const comparison:[string,string,string][]=[
["Terminal, SFTP ve tüneller","Ayrı ayrı araçlarda","Tek uygulamada, sekmeli ve bölünmüş"],
["Sunucu bakımı","Komutları elle yazmak","Disk analizi, güvenli temizlik, zombi düzeltme"],
["Yapay zekâ","Yok ya da tek makinede, kullanıcının tüm yetkileriyle","Tüm makinelerde, tek MCP adresi, cihaz başına yetkiler"],
["Onay","İstemci tarafında ya da hiç","Sunucu tarafında, tek kullanımlık"],
["Senkronizasyon","Sunucuda okunabilir ya da hiç","Uçtan uca şifreli"],
["Denetim ve geri alma","Yerel ya da yok","Merkezi kayıt, sürümler ve geri alma"]
];
const faq:[string,string][]=[
["Yapay zekâ kullanmadan, sadece SSH istemcisi olarak kullanabilir miyim?","Evet. Masaüstü uygulaması tek başına tam bir SSH istemcisidir: terminal, SFTP, tüneller, parçacıklar ve sunucu yönetimi yapay zekâ olmadan çalışır. MCP bağlantısı isteğe bağlıdır."],
["Parolalarım ve anahtarlarım nerede saklanır?","Bilgisayarının işletim sistemi kasasında (Windows Kimlik Bilgileri, macOS Anahtar Zinciri). Senkronizasyonu açarsan veriler cihazında şifrelenip öyle gönderilir; sunucumuz içeriği okuyamaz."],
["Hangi yapay zekâ istemcileriyle çalışır?","Uzak MCP destekleyen her istemciyle: claude.ai ve Claude Desktop, ChatGPT, Cursor, VS Code ve diğerleri. Bağlantı OAuth ile kurulur."],
["Sunucumda port açmam gerekir mi?","Hayır. SSH için zaten açık olan bağlantıyı kullanırsın; yapay zekâ erişimi için agent WECOMMANDER'a dışarıya doğru güvenli bir bağlantı kurar."],
["Yapay zekâ onaysız ne yapabilir?","Okuma işlemleri (loglar, container listesi ve zamanlayıcılar dahil) onaysız çalışır. Komut çalıştırma, silme, temizlik, servis ya da container yeniden başlatma ve zamanlanmış görev değişiklikleri cihazın ya da SSH sunucusunun güven seviyesine göre onay ister: standartta izinli komutlar onaysız çalışır, tam güvende o makinedeki işlemler onaysız yürür. Salt okunur paylaşılan SSH sunucuları hiç değiştirilemez."],
["Yapay zekâ için her sunucuya agent kurmam gerekir mi?","Hayır. Hibrit Erişim ile Windows, macOS ya da Linux uygulamana kayıtlı SSH sunucularını yapay zekâya açabilirsin: sunucuya hiçbir şey kurulmaz, bağlantı bilgisayarındaki WECOMMANDER üzerinden kurulur ve anahtarların bilgisayarından çıkmaz; bunun için bilgisayarın ve uygulama açık olmalı. Komutlar, dosyalar, temizlik, süreç sinyalleri, zamanlayıcılar ve Docker araçları çalışır. Hangi sunucunun paylaşılacağını sen seçersin; her sunucuya ajandaki gibi güven seviyesi, izinli komutlar ve iki anahtarlı root verebilirsin."],
["Yapay zekâ root olarak çalışabilir mi?","Yalnızca Linux'ta ve iki anahtarla: makine sahibi kurulumu sunucuda --allow-root ile çalıştırır, ardından bir yönetici web panelinden şifresiyle açar. Windows ve macOS'ta root seçeneği yok. Güvenlik ağı (varsayılan açık) diskleri silme, rm -rf / ve kapatma gibi geri dönüşü olmayan komutları root ve tam güvende bile engeller; şifrenle kapatabilirsin."],
["Hangi işletim sistemleri destekleniyor?","Masaüstü uygulaması: Windows 10/11 ve macOS (Apple Silicon ve Intel); Linux için önizleme sürümü. Agent: Windows, macOS ve Linux (Ubuntu/Debian)."],
["Uygulama hangi dillerde?","Site ve Windows ile macOS uygulamaları Türkçe, İngilizce, Almanca, Fransızca, İspanyolca ve Portekizce (Brezilya) dillerinde. Dil sistemine göre seçilir, ayarlardan değiştirilebilir."],
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
 useEffect(()=>{let mounted=true;
  // The CMS copy exists in Turkish and English; the other languages use the built-in translations.
  if(language!=="tr"&&language!=="en"){setSiteCopy(null);return}
  api<{item:{hero_title:string;hero_subtitle:string;overrides:Record<string,string>;seo_title:string;seo_description:string}|null}>("/api/public/site-content?locale="+language).then(r=>{if(mounted)setSiteCopy(r.item)}).catch(()=>{if(mounted)setSiteCopy(null)});return()=>{mounted=false}},[language]);
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
  <section className="logo-strip" aria-labelledby="clients-title"><div className="container-w"><p id="clients-title" className="logo-strip-title">{copy("Sevdiğin yapay zekâ istemcileriyle çalışır")}</p><ul className="logo-row">{clientLogos.map(c=><li key={c.name}>{c.svg}<span>{c.name}</span></li>)}</ul><p className="logo-strip-note">{copy("ve uzak MCP destekleyen her istemci")}</p></div></section>
  <Showcase copy={copy}/>
  <section id="features" className="section-modern"><div className="container-w">
   <div className="section-heading" data-reveal><span className="eyebrow">{copy("YETENEKLER")}</span><h2 className="h2 mt-4">{copy("Sunucu işlerinin hepsi.")}<br/><span className="text-gradient">{copy("Yanında yapay zekâ.")}</span></h2><p>{copy("Bir SSH istemcisinden beklediğin her şey, sunucu bakımını kolaylaştıran araçlar ve sınırlarını senin çizdiğin bir yapay zekâ.")}</p></div>
   <div className="features-grid">{features.map((f,i)=><Card key={f.title} className="feature-card" data-reveal style={{transitionDelay:((i%3)*85)+"ms"}}>{typeof siteCopy?.overrides?.["media:feature:"+i]==="string"&&/^[0-9a-f-]{36}$/i.test(siteCopy.overrides["media:feature:"+i])&&
  <img loading="lazy" className="w-full h-32 object-cover rounded-xl mb-5" src={"/api/public/media/"+siteCopy.overrides["media:feature:"+i]} alt={copy(f.title)}/>}
  <div className={"feature-icon tone-"+f.tone}><f.icon size={24} aria-hidden="true"/></div><h3>{copy(f.title)}</h3><p>{copy(f.text)}</p></Card>)}</div>
  </div></section>
  <section id="how-it-works" className="section-modern alt"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">{copy("3 ADIMDA BAŞLA")}</span><h2 className="h2 mt-4">{copy("İki dakikada hazır.")}<br/>{copy("Yapay zekâ ise isteğe bağlı.")}</h2><p>{copy("Uygulamayı kur, sunucularını ekle; istersen yapay zekânı da bağla.")}</p></div><div className="steps-grid">{steps.map(step=><div className="step" data-reveal key={step.num}><div className="flex items-center justify-between"><span className="number">{copy(step.num)}</span><step.icon size={23} color="var(--accent)" aria-hidden="true"/></div><h3>{copy(step.title)}</h3><p>{copy(step.desc)}</p></div>)}</div><div className="flex justify-center mt-10" data-reveal><Button variant="outline" onClick={()=>nav("/download")}>{copy("Uygulamayı indir")} <ArrowRight size={16}/></Button><Button variant="outline" onClick={()=>nav("/install")}>{copy("Kurulum rehberi")} <ArrowUpRight size={16}/></Button></div></div></section>
  <section id="connect" className="section-modern"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">{copy("İKİ BAĞLANTI YOLU")}</span><h2 className="h2 mt-4">{copy("Sunucunu iki yoldan bağla.")}</h2><p>{copy("Yapay zekâ bir sunucuya ya kurduğun küçük bir ajanla ya da hiçbir şey kurmadan, bilgisayarındaki uygulama üzerinden SSH ile ulaşır.")}</p></div>
   <div className="connect-row" data-reveal>{connectWays.map(w=><Card key={w.title} className="plan-card"><div className="flex items-center gap-3"><w.icon size={22} color="var(--accent)" aria-hidden="true"/><h3>{copy(w.title)}</h3></div><p className="plan-desc">{copy(w.desc)}</p><ul className="plan-features">{w.points.map(p=><li key={p}><Check size={16} aria-hidden="true"/>{copy(p)}</li>)}</ul></Card>)}</div>
   <p className="connect-hint" data-reveal><Info size={16} aria-hidden="true"/>{copy("Hangisi? Sürekli açık ve otonom işler için ajan; hızlıca denemek ya da kurulum yapamadığın sunucular için SSH.")}</p>
  </div></section>
  <section id="compare" className="section-modern"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">{copy("KARŞILAŞTIRMA")}</span><h2 className="h2 mt-4">{copy("Klasik araçların ötesinde.")}</h2><p>{copy("SSH istemcileri yalnızca bağlanır, yerel MCP araçları tek makinede tüm yetkilerle çalışır. WECOMMANDER ikisini tek uygulamada, güvenlik katmanlarıyla birleştirir.")}</p></div>
   <div className="compare-wrap" data-reveal><table className="compare-table"><caption className="sr-only">{copy("Klasik SSH istemcileri ve yerel MCP araçları ile WECOMMANDER karşılaştırması")}</caption><thead><tr><th scope="col"><span className="sr-only">{copy("Özellik")}</span></th><th scope="col">{copy("Klasik SSH istemcileri ve yerel MCP araçları")}</th><th scope="col">WECOMMANDER</th></tr></thead><tbody>{comparison.map(([row,local,ours])=><tr key={row}><th scope="row">{copy(row)}</th><td data-label={copy("Klasik SSH istemcileri ve yerel MCP araçları")}>{copy(local)}</td><td data-label="WECOMMANDER"><CheckCheck size={16} aria-hidden="true"/> {copy(ours)}</td></tr>)}</tbody></table></div>
  </div></section>
  <section className="section-modern alt"><div className="container-w"><div className="dark-spotlight" data-reveal><div><Badge><ShieldCheck size={14}/> {copy("ÖNCE GÜVENLİK")}</Badge><h2 className="mt-6">{copy("Yapay zekâya erişim ver.")}<br/>{copy("Kontrolü bırakma.")}</h2><p>{copy("Her komutun, her cihazın ve her yetkinin hesabı belli olsun. Bağlantı kurmak kadar güvenli yönetmek de önemli.")}</p><Button variant="outline" onClick={start}>{copy("Çalışma alanını oluştur")} <ChevronRight size={17}/></Button></div><div className="security-list"><span><KeyRound/> {copy("Tek kullanımlık, imzalı onaylar")}</span><span><ShieldCheck/> {copy("Cihaz başına güven seviyesi, root izni ve güvenlik ağı")}</span><span><LockKeyhole/> {copy("OAuth ile bağlanan yapay zekâ istemcileri")}</span><span><Zap/> {copy("Denetim kaydı ve e-posta bildirimleri")}</span><span><EyeOff/> {copy("Çıktıdaki parolalar ve anahtarlar cihazda maskelenir")}</span></div></div></div></section>
  <section className="section-modern" id="pricing"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">{copy("PAKETLER")}</span><h2 className="h2 mt-4">{copy("İhtiyacın kadar kullan.")}<br/>{copy("Şeffaf şekilde büyü.")}</h2><p>{copy("Ücretsiz planla başla; büyüdükçe Pro ya da Team'e geç. Ödemeler Paddle ile, 14 gün içinde koşulsuz iade.")}</p></div><div className="plans-row" data-reveal>{(pricing?.plans||[]).slice(0,3).map(p=><Card key={p.key} className={"plan-card"+(p.featured?" featured":"")}>{p.featured&&<span className="plan-ribbon">{copy("En çok tercih edilen")}</span>}<h3>{p.name}</h3><p className="plan-desc">{planText(p.description,language)}</p><div className="plan-price">{planText(p.priceLabel,language)}</div><ul className="plan-features">{p.features.map(f=><li key={f}><Check size={16} aria-hidden="true"/>{planText(f,language)}</li>)}</ul><Button variant={p.featured?"default":"outline"} className="w-full mt-auto" onClick={()=>p.free?start():nav("/pricing")}>{p.free?copy("Ücretsiz başla"):copy("Paketi seç")} <ArrowRight size={16}/></Button></Card>)}{!(pricing?.plans||[]).length&&<Card className="p-7 md:col-span-3 text-center"><h3 className="text-2xl font-bold">WECOMMANDER</h3><p className="muted mt-3 text-sm">{copy("Bireysel ve ekip kullanımı için abonelik seçenekleri.")}</p><Button className="mt-6" onClick={()=>nav("/pricing")}>{copy("Paketleri görüntüle")} <ArrowRight size={16}/></Button></Card>}</div></div></section>
  <section className="section-modern alt" id="faq"><div className="container-w"><div className="section-heading" data-reveal><span className="eyebrow">{copy("SIK SORULANLAR")}</span><h2 className="h2 mt-4">{copy("Merak ettiklerin.")}</h2></div><div className="faq-list" data-reveal>{faq.map(([q,a])=><details key={q}><summary>{copy(q)}</summary><p>{copy(a)}</p></details>)}</div></div></section>
  <section className="section-modern"><div className="container-w"><div className="closing-cta" data-reveal><Sparkles className="mx-auto mb-5 text-[var(--accent)]" size={27} aria-hidden="true"/><h2 className="h2">{copy("Cihazların hazır.")}<br/>{copy("Sıra sende.")}</h2><p className="muted mt-5 mb-7">{copy("Uygulamayı indir, ilk sunucunu iki dakikada bağla. Ücretsiz planla başla, istediğin zaman iptal et.")}</p><div className="flex justify-center gap-3 flex-wrap"><Button size="lg" onClick={start}>{signupEnabled===false?copy("Giriş Yap"):copy("Ücretsiz başla")} <ArrowRight size={18}/></Button><Button size="lg" variant="outline" onClick={()=>nav("/download")}>{copy("Uygulamayı indir")} <Download size={18}/></Button></div></div></div></section>
  <footer className="site-footer"><div className="container-w"><div className="footer-grid"><div><Brand onClick={()=>nav("/")} subtitle/><p className="max-w-[260px]">{copy("SSH istemcisi, sunucu yönetimi ve yapay zekâ için güvenli MCP; tek uygulamada.")}</p></div><div><strong>{copy("Ürün")}</strong><NavLink to="/features" nav={nav}>{copy("Özellikler")}</NavLink><NavLink to="/pricing" nav={nav}>{copy("Paketler")}</NavLink><NavLink to="/download" nav={nav}>{copy("İndir")}</NavLink><NavLink to="/install" nav={nav}>{copy("Kurulum")}</NavLink><NavLink to="/dashboard" nav={nav}>{copy("Uygulama")}</NavLink><NavLink to="/changelog" nav={nav}>{translate("Yenilikler")}</NavLink></div><div><strong>{copy("Hesap")}</strong><NavLink to="/login" nav={nav}>{copy("Giriş Yap")}</NavLink><NavLink to="/register" nav={nav}>{copy("Kayıt Ol")}</NavLink><NavLink to="/forgot-password" nav={nav}>{copy("Şifre Sıfırla")}</NavLink></div><div><strong>{copy("Kaynaklar")}</strong><NavLink to="/docs" nav={nav}>{copy("Dokümantasyon")}</NavLink><NavLink to="/faq" nav={nav}>{copy("Sık sorulanlar")}</NavLink><NavLink to="/alternatives" nav={nav}>{copy("Alternatifler")}</NavLink><NavLink to="/security" nav={nav}>{copy("Güvenlik")}</NavLink></div><div><strong>{copy("Yasal")}</strong><NavLink to="/privacy" nav={nav}>{copy("Gizlilik")}</NavLink><NavLink to="/terms" nav={nav}>{copy("Kullanım Koşulları")}</NavLink><NavLink to="/refund" nav={nav}>{copy("İade ve İptal")}</NavLink><a href="https://github.com/orhanbal/webrising-commender" target="_blank" rel="noopener noreferrer">GitHub</a><a href="/health" target="_blank" rel="noopener noreferrer">{copy("Sistem durumu")}</a></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} WECOMMANDER</span><span>{copy("SSH · SFTP · Sunucu yönetimi · Uzak MCP · Sunucu tarafı onaylar")}</span></div></div></footer>
 </div>;
}

// One period of a wave (first point = last point), so the two copies side by side flow without a seam.
const ago=Array.from({length:21},(_,i)=>46+9*Math.sin(i/20*Math.PI*2)+4*Math.sin(i/20*Math.PI*6));
function Spark({points,color}:{points:number[];color:string}){
 const w=120,h=34,step=w/(points.length-1),lo=Math.min(...points)-4,hi=Math.max(...points)+4;
 const d=points.map((v,i)=>`${(i*step).toFixed(1)},${(h-(v-lo)/(hi-lo)*h).toFixed(1)}`).join(" ");
 return <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true"><polygon points={`0,${h} ${d} ${w},${h}`} fill={color} opacity=".16"/><polyline points={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round"/></svg>;
}
function Showcase({copy}:{copy:(s:string)=>string}){
 const [tab,setTab]=useState<"server"|"dock"|"terminal">("server");
 const tabs:[typeof tab,string,typeof Server][]=[["server","Sunucu yönetimi",Server],["dock","Canlı izleme",Activity],["terminal","Terminal",TerminalSquare]];
 const cleanup:[string,string,number][]=[["Docker build önbelleği","33.8 GB",69],["Kullanılmayan imajlar","13.9 GB",28],["Eski loglar","1.2 GB",3],["Paket önbelleği","0.4 GB",1]];
 return <section className="section-modern showcase" id="product"><div className="container-w">
  <div className="section-heading" data-reveal><span className="eyebrow">{copy("UYGULAMANIN İÇİ")}</span><h2 className="h2 mt-4">{copy("Her şey tek pencerede.")}</h2><p>{copy("Terminal, sunucu bakımı ve canlı izleme; yapay zekâ olmadan da eksiksiz bir araç.")}</p></div>
  <div className="showcase-tabs" role="tablist" aria-label={copy("Uygulama ekranları")} data-reveal>{tabs.map(([key,label,Icon])=><button key={key} role="tab" aria-selected={tab===key} className={tab===key?"active":""} onClick={()=>setTab(key)}><Icon size={16} variant={iconVariant(tab===key)} aria-hidden="true"/>{copy(label)}</button>)}</div>
  <div className="app-window" data-reveal role="tabpanel" aria-label={copy(tabs.find(t=>t[0]===tab)![1])}>
   <div className="window-top"><span className="window-dot"/><span className="window-dot"/><span className="window-dot"/><span className="window-title">WECOMMANDER</span></div>
   {tab==="server"&&<div className="app-body">
    <aside className="app-side"><strong>{copy("Sunucularım")}</strong>{[["ubuntu-prod","crit"],["coolify-01","ok"],["devagent","ok"],["backup-nas","warn"]].map(([n,st])=><span key={n} className={n==="ubuntu-prod"?"on":""}><i className={"dot "+st}/>{n}</span>)}</aside>
    <div className="app-main">
     <div className="disk-head"><div><small>{copy("Disk")} /</small><strong>%91</strong></div><div className="disk-bar"><span style={{width:"91%"}}/></div><em>{copy("Temizlenebilir")}: 49.3 GB</em></div>
     <ul className="cleanup-list">{cleanup.map(([n,size,pct])=><li key={n}><Check size={14} aria-hidden="true"/><span>{copy(n)}</span><div className="mini-bar"><span style={{width:pct+"%"}}/></div><b>{size}</b></li>)}</ul>
     <div className="app-actions"><span className="ghost-btn">{copy("Yenile")}</span><span className="primary-btn">{copy("Seçilenleri temizle")} · 49.3 GB</span></div>
    </div>
   </div>}
   {tab==="dock"&&<div className="app-body dock-demo">
    <div className="dock-bar"><img className="dock-logo" src="/api/public/brand/favicon" alt="" aria-hidden="true"/><span className="dock-server"><i className="dot ok"/>ubuntu-prod<small>{copy("çevrimiçi")}</small></span>
     {[["CPU","%62","var(--success)"],["RAM","%78","#f59e0b"],["Disk","%91","#ef4444"]].map(([n,v,c],i)=><span key={n} className="dock-meter"><small>{n} {v}</small><div className="spark-track"><div className="spark-flow"><Spark points={i===0?ago:i===1?ago.map(x=>x+16):ago.map(x=>x+38)} color={c}/><Spark points={i===0?ago:i===1?ago.map(x=>x+16):ago.map(x=>x+38)} color={c}/></div></div></span>)}
     <span className="dock-btn"><Activity size={15} aria-hidden="true"/>{copy("Görev Yöneticisi")}</span><span className="dock-btn"><TerminalSquare size={15} aria-hidden="true"/>Terminal</span></div>
    <div className="dock-caption"><p>{copy("Windows görev çubuğu gibi ekranın kenarında: sabit, otomatik gizlenen ya da yüzen. Görev Yöneticisi, Görevler ve Terminal Dock'tan açılan panellerde.")}</p></div>
   </div>}
   {tab==="terminal"&&<div className="app-body term-demo">
    <div className="term-tabs"><span className="on">ubuntu-prod</span><span>coolify-01</span><span>+</span></div>
    <pre className="term">{"$ "}<b>{"docker ps --format '{{.Names}}'"}</b>{"\nweb-1\nworker-1\npostgres\n$ "}<b>{"sudo systemctl status nginx"}</b>{"\n● nginx.service - A high performance web server\n   Active: "}<i>{"active (running)"}</i>{" since 3 days\n$ "}<span className="caret"/></pre>
   </div>}
  </div>
 </div></section>;
}
