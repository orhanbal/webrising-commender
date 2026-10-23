import {useState} from "react";
import type{ReactNode}from"react";
import {ArrowRight,ArrowUpRight,Check,ChevronDown,ChevronRight,ClipboardCheck,Code2,Copy,Download,ExternalLink,FolderOpen,Info,Laptop,LockKeyhole,Monitor,Plug2,Server,ShieldCheck,TerminalSquare,Usb,Workflow} from "lucide-react";
import {Badge,Button,Card,Dialog,DialogContent,DialogDescription,DialogTitle} from "../components/ui";
import type{Nav}from"../App";

type Client="chatgpt"|"claude";
type Platform="windows"|"macos"|"linux";
const project="https://github.com/orhanbal/webrising-commender";
const endpoint=()=>location.origin+"/mcp";
const snippets:Record<Platform,string>={
 windows:"cargo build --release -p webrising-commender-agent\n.\\target\\release\\webrising-commender.exe enroll --control-url https://wecommander.webrising.tr --pairing-code <KOD> --allowed-root C:\\Users\\Kullanici",
 macos:"cargo build --release -p webrising-commender-agent\n./target/release/webrising-commender enroll --control-url https://wecommander.webrising.tr --pairing-code '<KOD>' --allowed-root \"$HOME\"",
 linux:"cargo build --release -p webrising-commender-agent\n./target/release/webrising-commender enroll --control-url https://wecommander.webrising.tr --pairing-code '<KOD>' --allowed-root \"$HOME\"",
};
const docs:Record<Client,{name:string;url:string;steps:string[];caution:string}>={
 chatgpt:{
  name:"ChatGPT",url:"https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt",
  steps:[
   "WECOMMANDER hesabınızda oturum açın, MCP Araçları bölümünden en az gerekli yetkiye sahip bir erişim anahtarı oluşturun.",
   "ChatGPT'nin desteklenen çalışma alanlarında Eklentiler (Plugins) bölümünden özel MCP sunucusu ekleme akışını açın.",
   "Sunucu adresi olarak aşağıdaki HTTPS MCP uç noktasını kullanın. ChatGPT'nin sunduğu kimlik doğrulama seçeneklerini kontrol edin.",
   "İzinleri ve keşfedilen araçları gözden geçirip bağlantıyı test edin. Tam MCP yetkileri ChatGPT planına ve çalışma alanı politikasına bağlıdır."
  ],
  caution:"WECOMMANDER şu anda bearer token ile kimlik doğrular. ChatGPT'deki özel MCP bağlantılarının hesap türüne ve kimlik doğrulama desteğine bağlı olarak ek uyarlama/OAuth gerektirebileceğini unutmayın. Bu düğme tek tıkla kurulum yapmaz."
 },
 claude:{
  name:"Claude",url:"https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
  steps:[
   "WECOMMANDER'da oturum açın. MCP Araçları bölümünden bağlantıya özel, sınırlı yetkili API anahtarı oluşturun.",
   "Claude'da Customize → Connectors → Add custom connector yolunu açın (kurum planlarında önce yönetici kurulumu gerekebilir).",
   "WECOMMANDER adını ve aşağıdaki HTTPS MCP URL'sini girin; kimlik doğrulama ekranında gerekiyorsa Authorization: Bearer <ANAHTAR> üst bilgisini yapılandırın.",
   "Connector'ı ekleyip sohbetinizde etkinleştirin. Yüksek riskli işlemlerde WECOMMANDER onay adımlarını kullanın."
  ],
  caution:"Claude'a bağlantı kurabilmek için sunucunun internetten erişilebilir olması ve hesabınızın özel connector izinlerinin açık olması gerekir. Anahtarınızı yalnızca güvenilir istemcilere verin."
 }
};
function CopyField({value,label,onCopy}:{value:string;label:string;onCopy:(v:string)=>void}){
 return <div className="install-copy-field"><div className="flex gap-2 min-w-0 items-center"><span className="muted text-xs shrink-0">{label}</span><code className="min-w-0 break-all text-[13px] font-mono text-[var(--text)]">{value}</code></div><Button size="icon" variant="outline" aria-label={label+" kopyala"} onClick={()=>onCopy(value)}><Copy className="size-4"/></Button></div>
}
function ClientCard({id,title,description,items,onOpen,mark}:{id:Client;title:string;description:string;items:string[];onOpen:(id:Client)=>void;mark:ReactNode}){
 return <Card className="install-client-card"><div className="install-client-header"><div className={"install-brand-icon "+id}>{mark}</div><div><h2 className="install-client-title">{title}</h2><p className="install-client-label">Remote MCP bağlantısı</p></div></div><p className="install-client-description">{description}</p>
 <div className="install-benefits">{items.map(i=><span key={i}><Check size={17}/>{i}</span>)}</div>
 <Button className="w-full install-client-action" onClick={()=>onOpen(id)}>{title} ile kurulum <ArrowRight size={17}/></Button></Card>;
}
const platforms:{key:Platform;name:string;kind:string;icon:typeof Monitor}[]=[
 {key:"windows",name:"Windows",kind:"Windows 10/11 · x64",icon:Monitor},
 {key:"macos",name:"macOS",kind:"Apple Silicon / Intel",icon:Laptop},
 {key:"linux",name:"Linux",kind:"x64 · systemd",icon:TerminalSquare}
];
export function InstallPage({nav}:{nav:Nav}){
 const [active,setActive]=useState<Client|null>(null);
 const [platform,setPlatform]=useState<Platform>("windows");
 const [expanded,setExpanded]=useState<"other"|"local"|null>(null);
 const [copied,setCopied]=useState("");
 const copy=async(value:string)=>{try{await navigator.clipboard.writeText(value);setCopied("Kopyalandı");}catch{setCopied("Panoya kopyalanamadı");} };
 const guide=active?docs[active]:null;
 return <div className="install-page">
  <section className="install-intro container-w"><Badge className="install-eyebrow"><Plug2 size={14}/> WECOMMANDER · INSTALL</Badge><h1>Konuştuğun yerde <span className="text-gradient">kullan.</span></h1><p>Kullandığın yapay zekâ asistanını WECOMMANDER'a bağla. Sonra erişim izni verdiğin bilgisayarlara ve sunuculara güvenle ulaş.</p></section>
  <section className="install-primary mx-auto">
   <div className="install-client-grid">
    <ClientCard id="chatgpt" title="ChatGPT" mark={<span className="text-[26px] font-bold leading-none" aria-hidden="true">✺</span>} description="ChatGPT'de özel MCP sunucusu olarak bağlan. Gerçek cihazlarına, terminaline ve dosyalarına kontrollü erişim sağla." items={["Web çalışma alanlarında özel MCP", "Yetkilendirilmiş cihaz ve araç erişimi","Bağlantı ayarlarını kendin yönet"]} onOpen={setActive}/>
    <ClientCard id="claude" title="Claude" mark={<span className="text-[31px] leading-none font-semibold" aria-hidden="true">✳</span>} description="Claude'dan uzaktaki cihazlarını kullan. Tek bir güvenli MCP uç noktasıyla farklı makinelerine bağlan." items={["Claude web ve masaüstü connector'ları","Gerçek dosya ve komut araçları","Kullanıcı onaylı yüksek riskli işlemler"]} onOpen={setActive}/>
   </div>
   <div className="install-options">
    <div className={"install-option "+(expanded==="other"?"expanded":"")}>
     <button type="button" aria-expanded={expanded==="other"} className="install-option-head" onClick={()=>setExpanded(expanded==="other"?null:"other")}><span className="install-option-symbol"><Usb size={21}/></span><span className="install-option-copy"><strong>Başka bir MCP istemcisi mi kullanıyorsun?</strong><small>Cursor, VS Code ve özel AI ajanlarını aynı uzak MCP sunucusuna bağlayabilirsin.</small></span><ChevronDown size={19} className="install-chevron"/></button>
     {expanded==="other"&&<div className="install-option-body"><p>İstemcinin uzak HTTPS MCP sunucusu ve bearer token desteğini doğrula. Bağlantı için aşağıdaki adresi kullan; API anahtarını herkese açık dosyalara yazma.</p><CopyField label="MCP" value={endpoint()} onCopy={copy}/><div className="flex gap-3 mt-4 flex-wrap"><Button size="sm" onClick={()=>nav("/mcp")}>MCP anahtarı oluştur <ArrowRight size={15}/></Button><a className="install-link" href={project+"/blob/main/docs/QUICKSTART.md"} target="_blank" rel="noopener noreferrer">Kurulum rehberi <ExternalLink size={14}/></a></div></div>}
    </div>
    <div className={"install-option "+(expanded==="local"?"expanded":"")}>
     <button type="button" aria-expanded={expanded==="local"} className="install-option-head" onClick={()=>setExpanded(expanded==="local"?null:"local")}><span className="install-option-symbol"><TerminalSquare size={21}/></span><span className="install-option-copy"><strong>Kendi sunucunda çalıştırmayı mı tercih ediyorsun?</strong><small>Ücretsiz ve açık kaynaklı self-hosted altyapıyı kur, verilerini kendi ortamında tut.</small></span><ChevronDown size={19} className="install-chevron"/></button>
     {expanded==="local"&&<div className="install-option-body"><p>Docker ve Docker Compose kurulu bir sunucu üzerinde gateway'i başlat. Cihazlarına agent'ı ayrıca yükleyip eşleştir.</p><pre className="install-code">{"git clone "+project+".git\ncd webrising-commender\ncp .env.example .env\n# .env içindeki sırları yapılandır\ndocker compose up -d --build"}</pre><div className="flex gap-3 items-center flex-wrap mt-4"><Button size="sm" variant="outline" onClick={()=>copy("git clone "+project+".git\ncd webrising-commender\ncp .env.example .env\ndocker compose up -d --build")}><Copy size={15}/> Komutları kopyala</Button><a className="install-link" href={project+"/blob/main/docs/QUICKSTART.md"} target="_blank" rel="noopener noreferrer">Ayrıntılı dokümantasyon <ExternalLink size={14}/></a></div></div>}
    </div>
   </div>
  </section>
  <section className="install-download-section" id="download-agent"><div className="container-w">
   <div className="install-download-heading"><div><span className="eyebrow">CİHAZ BAĞLANTISI</span><h2>Cihazına <span className="text-gradient">WECOMMANDER Agent</span> kur.</h2><p>Asistanına bağlandıktan sonra bilgisayarını veya sunucunu eşleştir. Agent, cihazından güvenli dış bağlantı kurar; açık inbound port gerekmez.</p></div><Badge><ShieldCheck size={14}/> Açık kaynak agent</Badge></div>
   <div className="install-platforms">{platforms.map(p=><button key={p.key} type="button" className={"install-platform "+(platform===p.key?"active":"")} aria-pressed={platform===p.key} onClick={()=>setPlatform(p.key)}><p.icon size={22}/><span><strong>{p.name}</strong><small>{p.kind}</small></span>{platform===p.key&&<Check size={18} className="install-platform-check"/>}</button>)}</div>
   <Card className="install-download-card"><div className="install-download-grid"><div><div className="flex gap-2 items-center"><Badge><Info size={14}/> Dağıtım durumu</Badge></div><h3>{platforms.find(p=>p.key===platform)?.name} için kurulum</h3><p>Projenin herkese açık GitHub Releases bölümünde henüz indirilebilir bir sürüm yayımlanmadı. Var olmayan bir indirme bağlantısına yönlendirmiyoruz. Şimdilik agent'ı kaynak koddan derleyebilir veya yayınlanan sürümleri kontrol edebilirsin.</p><div className="install-download-actions"><a className="install-primary-link" href={project+"/releases"} target="_blank" rel="noopener noreferrer"><Download size={18}/> Sürümleri kontrol et <ArrowUpRight size={16}/></a><a className="install-secondary-link" href={project+"/blob/main/docs/QUICKSTART.md"} target="_blank" rel="noopener noreferrer"><FolderOpen size={17}/> Kurulum rehberi</a></div></div><div className="install-code-wrap"><div className="install-code-top"><span><Code2 size={15}/> Kaynak koddan derleme</span><button type="button" className="install-code-copy" onClick={()=>copy(snippets[platform])}><Copy size={14}/> Kopyala</button></div><pre className="install-code">{snippets[platform]}</pre><p className="install-code-note">Rust toolchain gereklidir. Eşleştirme kodunu panelden oluştur; <code>&lt;KOD&gt;</code> alanını onunla değiştir.</p></div></div></Card>
   <div className="install-steps"><span><Check size={15}/> Agent'ı hazırla</span><ChevronRight size={16}/><span><Check size={15}/> <button type="button" onClick={()=>nav("/devices")}>Panelden cihaz eşleştir</button></span><ChevronRight size={16}/><span><Check size={15}/> AI istemcinle bağlan</span></div>
  </div></section>
  <section className="install-end container-w"><div className="install-end-banner"><div><span className="eyebrow">BAŞLAMAYA HAZIR MISIN?</span><h2>Tek panel. Çoklu cihaz. <span className="text-gradient">Tam kontrol.</span></h2><p>Kurulum adımlarını tamamladığında cihazlarını yönetmeye başlayabilirsin.</p></div><Button size="lg" onClick={()=>nav("/dashboard")}>Kullanıcı paneline git <ArrowRight size={17}/></Button></div></section>
  <footer className="install-footer container-w"><span>© {new Date().getFullYear()} WECOMMANDER</span><a href={project} target="_blank" rel="noopener noreferrer">GitHub <ExternalLink size={14}/></a><a href={project+"/blob/main/docs/QUICKSTART.md"} target="_blank" rel="noopener noreferrer">Dokümantasyon <ExternalLink size={14}/></a></footer>
  <Dialog open={!!active} onOpenChange={open=>{if(!open)setActive(null)}}><DialogContent className="install-guide-dialog">{guide&&<><div className="flex gap-3 items-center mb-5"><span className="install-guide-icon">{active==="chatgpt"?"✺":"✳"}</span><div><DialogTitle className="text-xl font-bold">{guide.name} ile bağlantı</DialogTitle><DialogDescription className="text-sm muted mt-1">WECOMMANDER · Remote MCP kurulumu</DialogDescription></div></div><div className="install-guide-steps">{guide.steps.map((s,i)=><div key={s} className="install-guide-step"><span>{i+1}</span><p>{s}</p></div>)}</div><CopyField label="MCP" value={endpoint()} onCopy={copy}/><p className="install-guide-note"><LockKeyhole size={16}/>{guide.caution}</p><div className="install-guide-actions"><Button onClick={()=>{setActive(null);nav("/mcp")}}><ShieldCheck size={16}/> API erişimini ayarla</Button><a href={guide.url} className="install-secondary-link" target="_blank" rel="noopener noreferrer">Resmî yardım <ExternalLink size={15}/></a></div></>}</DialogContent></Dialog>
  {copied&&<div role="status" className="install-toast"><ClipboardCheck size={17}/>{copied}<button type="button" onClick={()=>setCopied("")} aria-label="Bildirimi kapat">×</button></div>}
 </div>;
}
