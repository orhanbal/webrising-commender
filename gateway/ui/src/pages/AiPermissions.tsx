import {useEffect,useState} from "react";
import {Copy} from "../components/icons";
import {t as translate,localizedDate} from "../i18n";
import {api,type Device} from "../api";
import {Alert,Button,Dialog,DialogContent,DialogDescription,DialogTitle,Input,Spinner} from "../components/ui";

// Per-device AI permissions (docs/AI_PERMISSIONS.md): trust level with an
// optional time limit, run as user/root and the safety net. Every change goes
// through the session-only, CSRF-checked and audited REST routes; widening
// (full trust, root, safety net off) needs the current password.
export type Trust="strict"|"standard"|"full";
export type PermissionDevice=Device&{trust_level?:Trust;trust_full_until?:string|null;run_as?:"user"|"root";root_capable?:boolean;safety_net?:boolean;safety_net_allow_power?:boolean;agent_root?:boolean};

/** What the person on a Linux machine runs once so root can be turned on. */
export const ROOT_INSTALL_COMMAND="sudo bash install-linux.sh --allow-root";
const durations:{label:string;minutes:number|null}[]=[
 {label:"1 saat",minutes:60},{label:"4 saat",minutes:240},{label:"24 saat",minutes:1440},{label:"7 gün",minutes:10080},{label:"Süre sınırı yok",minutes:null},
];
const trustText:Record<Trust,{title:string;text:string}>={
 strict:{title:"Sıkı",text:"Her yüksek riskli işlem onay ister; izinli komut listesi kullanılmaz."},
 standard:{title:"Standart",text:"İzinli komutlar onaysız çalışır, diğer yüksek riskli işlemler onay ister."},
 full:{title:"Tam",text:"Yapay zekâ komutları, Docker işlemlerini ve zamanlanmış görev değişikliklerini onay beklemeden yapar."},
};

/** Badges for a device row: trust, run as and safety net at a glance. */
export function PermissionBadges({device,onOpen}:{device:PermissionDevice;onOpen?:()=>void}){
 const trust=device.trust_level||"standard";
 const root=device.run_as==="root"||device.agent_root;
 const tone=(warn:boolean)=>"rounded-full border px-3 py-1 text-xs font-semibold "+(warn?"border-[var(--warning)] bg-[var(--warning-soft)] text-[var(--warning)]":"border-[var(--stroke)] bg-[var(--subtle-surface)]");
 const body=<>
  <span className={tone(trust==="full")}>{translate("Güven")}: {translate(trustText[trust].title)}</span>
  <span className={tone(!!root)}>{root?translate("Root olarak"):translate("Kullanıcı olarak")}</span>
  {device.safety_net===false&&<span className={tone(true)}>{translate("Güvenlik ağı kapalı")}</span>}
 </>;
 return onOpen?<button type="button" onClick={onOpen} title={translate("Yapay zekâ yetkileri")} className="flex flex-wrap gap-1.5">{body}</button>:<span className="flex flex-wrap gap-1.5">{body}</span>;
}

export function AiPermissionsDialog({device,onClose,onChanged}:{device:PermissionDevice|null;onClose:()=>void;onChanged:()=>void}){
 const [trust,setTrust]=useState<Trust>("standard");
 // null: keep the current time limit of a device already on full trust.
 const [duration,setDuration]=useState<number|null>(null);
 const [runAs,setRunAs]=useState<"user"|"root">("user");
 const [safety,setSafety]=useState(true);
 const [power,setPower]=useState(false);
 const [password,setPassword]=useState("");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [saved,setSaved]=useState("");
 const [copied,setCopied]=useState(false);
 useEffect(()=>{
  if(!device)return;
  setTrust(device.trust_level||"standard");setRunAs(device.run_as==="root"?"root":"user");
  setSafety(device.safety_net!==false);setPower(device.safety_net_allow_power===true);
  setDuration(null);setPassword("");setError("");setSaved("");
 },[device?.id]);
 if(!device)return null;
 const currentTrust=device.trust_level||"standard";
 const currentRunAs=device.run_as==="root"?"root":"user";
 const currentSafety=device.safety_net!==false;
 const currentPower=device.safety_net_allow_power===true;
 const durationIndex=duration??(currentTrust==="full"?null:0);
 const sendTrust=trust!==currentTrust||(trust==="full"&&duration!==null);
 const runAsChanged=runAs!==currentRunAs;
 const safetyChanged=safety!==currentSafety||power!==currentPower;
 // Widening needs the password (the server checks it again).
 const needsPassword=(trust==="full"&&sendTrust)||(runAs==="root"&&runAsChanged)||(!safety&&currentSafety)||(power&&!currentPower);
 const changed=sendTrust||runAsChanged||safetyChanged;
 async function save(){
  if(!device)return;
  setBusy(true);setError("");setSaved("");
  try{
   const pw=password?{currentPassword:password}:{};
   if(sendTrust){
    const minutes=durationIndex===null?null:durations[durationIndex]!.minutes;
    await api("/api/devices/"+device.id+"/trust",{method:"PUT",body:JSON.stringify({level:trust,...(trust==="full"?{...pw,...(minutes?{minutes}:{})}:{})})});
   }
   if(runAsChanged)await api("/api/devices/"+device.id+"/run-as",{method:"PUT",body:JSON.stringify({runAs,...(runAs==="root"?pw:{})})});
   if(safetyChanged)await api("/api/devices/"+device.id+"/safety-net",{method:"PUT",body:JSON.stringify({enabled:safety,allowPower:power,...pw})});
   setPassword("");setSaved(translate("Yapay zekâ yetkileri kaydedildi."));onChanged();
  }catch(e){setError((e as Error).message);onChanged()}
  finally{setBusy(false)}
 }
 const copy=async()=>{try{await navigator.clipboard.writeText(ROOT_INSTALL_COMMAND);setCopied(true)}catch{setCopied(false)}};
 const fullUntil=currentTrust==="full"?device.trust_full_until:null;
 return <Dialog open={!!device} onOpenChange={open=>{if(!open)onClose()}}><DialogContent className="w-[min(94vw,640px)] max-h-[90vh] overflow-y-auto">
  <DialogTitle className="text-xl font-bold">{translate("Yapay zekâ yetkileri")} · {device.name}</DialogTitle>
  <DialogDescription className="text-sm muted mt-1">{translate("Yapay zekânın bu cihazda ne yapabileceğini seç. Bu ayarları yalnızca yöneticiler tarayıcıdan değiştirebilir; yapay zekâ istemcileri değiştiremez.")}</DialogDescription>
  <div className="mt-4"><PermissionBadges device={device}/>{fullUntil&&<p className="text-xs muted mt-2">{translate("Tam güven bitişi")}: {localizedDate(fullUntil,{dateStyle:"short",timeStyle:"short"})}</p>}{currentTrust==="full"&&!fullUntil&&<p className="text-xs muted mt-2">{translate("Tam güven süresiz açık.")}</p>}</div>

  <fieldset className="grid gap-2 mt-6"><legend className="text-sm font-semibold mb-1">{translate("Güven seviyesi")}</legend>
   {(Object.keys(trustText) as Trust[]).map(key=><label key={key} className={"flex gap-3 rounded-xl border p-3 text-sm "+(trust===key?"border-[var(--accent)] bg-[var(--accent-soft)]":"border-[var(--stroke)]")}><input type="radio" name="ai-trust" checked={trust===key} onChange={()=>setTrust(key)}/><span><span className="font-semibold">{translate(trustText[key].title)}</span>{currentTrust===key&&<span className="muted"> · {translate("şu an")}</span>}<span className="block text-xs muted">{translate(trustText[key].text)}</span></span></label>)}
   {trust==="full"&&<div className="grid gap-2 mt-1"><span className="text-xs font-semibold">{translate("Süre")}</span><div className="flex flex-wrap gap-2">{durations.map((d,i)=><Button key={d.label} type="button" size="sm" variant={durationIndex===i?"default":"outline"} aria-pressed={durationIndex===i} onClick={()=>setDuration(i)}>{translate(d.label)}</Button>)}</div>{durationIndex!==null&&durations[durationIndex]!.minutes===null&&<p className="text-xs text-[var(--warning)]">{translate("Süre sınırı olmadan tam güven, siz değiştirene kadar açık kalır.")}</p>}</div>}
  </fieldset>

  <fieldset className="grid gap-2 mt-6"><legend className="text-sm font-semibold mb-1">{translate("Çalıştıran kullanıcı")}</legend>
   <label className={"flex gap-3 rounded-xl border p-3 text-sm "+(runAs==="user"?"border-[var(--accent)] bg-[var(--accent-soft)]":"border-[var(--stroke)]")}><input type="radio" name="ai-run-as" checked={runAs==="user"} onChange={()=>setRunAs("user")}/><span><span className="font-semibold">{translate("Kullanıcı olarak")}</span><span className="block text-xs muted">{translate("Komutlar, görevler, terminaller ve dosya yazmaları agent servis kullanıcısıyla çalışır (önerilen).")}</span></span></label>
   <label className={"flex gap-3 rounded-xl border p-3 text-sm "+(runAs==="root"?"border-[var(--warning)] bg-[var(--warning-soft)]":"border-[var(--stroke)]")+(device.root_capable?"":" opacity-60")}><input type="radio" name="ai-run-as" checked={runAs==="root"} disabled={!device.root_capable} onChange={()=>setRunAs("root")}/><span><span className="font-semibold">{translate("Root olarak")}</span><span className="block text-xs muted">{translate("Komutlar, görevler, terminaller ve dosya yazmaları sudo ile root olarak çalışır. Dosya araçları yine izinli klasörlerle sınırlıdır.")}</span></span></label>
   {!device.root_capable&&<Alert tone="info" title={translate("Bu cihazda root kapalı")}>{translate("Root yetkisi önce makinenin kendisinde açılmalı; web panelinden tek başına açılamaz. Makinedeki kişi şu komutu bir kez çalıştırsın, sonra burada açabilirsin:")}
    <div className="flex gap-2 items-center mt-2"><code className="font-mono text-xs break-all select-all flex-1 rounded-lg bg-[var(--subtle-surface)] px-3 py-2">{ROOT_INSTALL_COMMAND}</code><Button type="button" variant="outline" size="icon" aria-label={translate("Komutu kopyala")} onClick={()=>void copy()}><Copy size={16}/></Button></div>{copied&&<span role="status" className="text-xs text-[var(--success)]">{translate("Kopyalandı")}</span>}</Alert>}
   {runAs==="root"&&runAsChanged&&<Alert tone="warning" title={translate("Root tam yönetici yetkisidir")}>{translate("Yapay zekâ bu makinede her şeyi değiştirebilir. Değişiklik tüm yöneticilere e-postayla bildirilir ve denetim kaydına yazılır.")}</Alert>}
  </fieldset>

  <fieldset className="grid gap-2 mt-6"><legend className="text-sm font-semibold mb-1">{translate("Güvenlik ağı")}</legend>
   <label className="flex gap-3 text-sm"><input type="checkbox" checked={safety} onChange={e=>setSafety(e.target.checked)}/><span><span className="font-semibold">{translate("Güvenlik ağı açık")}</span><span className="block text-xs muted">{translate("Root ve tam güvende bile şu komutlar hiç çalışmaz: rm -rf /, disk biçimlendirme ve üzerine yazma (mkfs, wipefs, dd), fork bomb, kapatma/yeniden başlatma ve agent servisini silme.")}</span></span></label>
   {safety&&<label className="flex gap-3 text-sm pl-6"><input type="checkbox" checked={power} onChange={e=>setPower(e.target.checked)}/><span>{translate("Kapatma ve yeniden başlatma komutlarına izin ver")}</span></label>}
   {!safety&&currentSafety&&<Alert tone="warning" title={translate("Güvenlik ağını kapatmak geri alınamaz hatalara izin verir")}>{translate("Değişiklik tüm yöneticilere e-postayla bildirilir ve denetim kaydına yazılır.")}</Alert>}
  </fieldset>

  {needsPassword&&<label className="grid gap-1 mt-6 max-w-sm"><span className="text-sm font-semibold">{translate("Mevcut şifren")}</span><Input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></label>}
  {error&&<div className="form-error mt-4" role="alert">{error}</div>}
  <div className="flex flex-wrap items-center gap-3 mt-6"><Button onClick={()=>void save()} disabled={busy||!changed||(needsPassword&&!password)}>{busy?<Spinner label={translate("Kaydediliyor…")}/>:translate("Kaydet")}</Button>{saved&&<span role="status" className="text-sm text-[var(--success)]">{saved}</span>}</div>
 </DialogContent></Dialog>;
}
