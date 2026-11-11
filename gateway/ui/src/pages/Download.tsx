import {useState} from "react";
import { t as translate,useLocale } from "../i18n";
import {Check,Copy,Download,Laptop,Monitor,TerminalSquare} from "lucide-react";
import type{Account}from"../api";
import{Badge,Button,Card}from"../components/ui";
import{DashboardShell}from"./Dashboard";import type{Nav,Theme}from"../App";

type Platform="windows"|"macos"|"linux";
const platforms:{key:Platform;name:string;kind:string;icon:typeof Monitor}[]=[
 {key:"windows",name:"Windows",kind:"Windows 10/11 · x64",icon:Monitor},
 {key:"macos",name:"macOS",kind:"Apple Silicon / Intel",icon:Laptop},
 {key:"linux",name:"Linux",kind:"x64 · systemd",icon:TerminalSquare}
];
const command=(p:Platform)=>p==="windows"?`irm ${location.origin}/install.ps1 | iex`:`curl -fsSL ${location.origin}/install.sh | sh`;

/** In the panel: get the WECOMMANDER app (agent inside) for this computer. */
export function DownloadPage({nav,account,theme,toggle,logout}:{nav:Nav;account:Account|null;theme:Theme;toggle:()=>void;logout:()=>void}){
 useLocale();
 const guess:Platform=/Mac/i.test(navigator.platform)?"macos":/Linux/i.test(navigator.platform)&&!/Android/i.test(navigator.userAgent)?"linux":"windows";
 const [platform,setPlatform]=useState<Platform>(guess);
 const [copied,setCopied]=useState(false);
 const copy=async()=>{try{await navigator.clipboard.writeText(command(platform));setCopied(true);setTimeout(()=>setCopied(false),2000)}catch{/* clipboard unavailable */}};
 const steps=platform==="windows"
  ?[translate("Aşağıdaki düğmeyle kurulum dosyasını indir ve çift tıkla (Windows sorarsa “Yine de çalıştır”)."),translate("Uygulama açılır; tarayıcıda hesabınla giriş yap."),translate("Bu bilgisayar kendiliğinden bağlanır, ajan arka planda çalışır. Yönetici izni gerekmez.")]
  :platform==="macos"
  ?[translate("Kurulum komutunu kopyala ve Terminal'e yapıştır."),translate("Uygulama açılır; tarayıcıda hesabınla giriş yap."),translate("Bu Mac kendiliğinden bağlanır, ajan arka planda çalışır. Parola gerekmez.")]
  :[translate("Sunucuda kurulum komutunu çalıştır."),translate("Komutun verdiği bağlantıyı tarayıcıda açıp cihazı onayla."),translate("Ajan, root olmayan bir servis kullanıcısıyla arka planda çalışır.")];
 return <DashboardShell nav={nav} path="/download" account={account} theme={theme} toggle={toggle} logout={logout}>
  <div><span className="dash-kicker">{translate("KURULUM")}</span><h1 className="dash-title mt-2">{translate("Uygulamayı indir")}<span className="text-[var(--accent)]">.</span></h1><p className="muted text-sm mt-2">{translate("Tek uygulama: kur, tarayıcıda giriş yap, gerisi arka planda. Ajan uygulamanın içinde gelir.")}</p></div>
  <div className="install-platforms mt-6">{platforms.map(p=><button key={p.key} type="button" className={"install-platform "+(platform===p.key?"active":"")} aria-pressed={platform===p.key} onClick={()=>setPlatform(p.key)}><p.icon size={22}/><span><strong>{p.name}</strong><small>{p.kind}</small></span>{platform===p.key&&<Check size={18} className="install-platform-check"/>}</button>)}</div>
  <Card className="p-6 mt-5">
   <Badge><Check size={14}/> {platform==="linux"?translate("Sunucu ajanı"):translate("Tek uygulama, ajan içinde")}</Badge>
   <ol className="mt-4 grid gap-2 text-sm">{steps.map((s,i)=><li key={i} className="flex gap-3"><span className="font-semibold text-[var(--accent)]">{i+1}.</span><span>{s}</span></li>)}</ol>
   <div className="flex flex-wrap gap-3 mt-5">
    {platform==="windows"
     ?<a className="install-primary-link" href="/install/WECOMMANDER-Kur.cmd" download><Download size={18}/> {translate("WECOMMANDER'ı indir (Windows)")}</a>
     :<Button onClick={()=>void copy()}><Copy size={17}/> {copied?translate("Kopyalandı"):translate("Kurulum komutunu kopyala")}</Button>}
   </div>
   <div className="install-code-wrap mt-5"><div className="install-code-top"><span>{platform==="windows"?translate("Ya da PowerShell'e yapıştır"):translate("Komut")}</span><button type="button" className="install-code-copy" onClick={()=>void copy()}><Copy size={14}/> {copied?translate("Kopyalandı"):translate("Kopyala")}</button></div><pre className="install-code">{command(platform)}</pre></div>
  </Card>
 </DashboardShell>;
}
