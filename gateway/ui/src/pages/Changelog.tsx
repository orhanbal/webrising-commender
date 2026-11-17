import {Sparkles} from "../components/icons";
import {intlLocale,t as translate,useLocale} from "../i18n";
import {releaseNotes,type ReleaseNote} from "../release-notes.gen";

/** "Yenilikler": the notes the desktop apps show after an update (release-notes/notes.json, built in). */
function appName(platforms:ReleaseNote["platforms"]){
 if(platforms.length===0||platforms.length===2)return translate("Windows ve macOS");
 return platforms.includes("macos")?"macOS":"Windows";
}
function formatDate(day:string){
 const d=new Date(day+"T00:00:00Z");
 return Number.isNaN(d.getTime())?day:new Intl.DateTimeFormat(intlLocale(),{dateStyle:"long",timeZone:"UTC"}).format(d);
}
export function ChangelogPage(){
 const locale=useLocale();
 return <article className="container-w section-modern max-w-4xl mx-auto">
  <div className="flex items-center gap-3 text-[var(--accent)]">
   <Sparkles size={26} aria-hidden="true"/>
   <span className="text-xs tracking-widest font-bold uppercase">WECOMMANDER</span>
  </div>
  <h1 className="h2 mt-6">{translate("Yenilikler")}</h1>
  <p className="muted mt-4 leading-7">{translate("Windows ve macOS uygulamaları her güncellemeden sonra bu notları bir kez gösterir. En yenisi en üstte.")}</p>
  <div className="mt-8 space-y-5">
   {releaseNotes.map(note=><section key={note.id} className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-6 sm:p-8">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
     <h2 className="text-lg font-semibold"><time dateTime={note.date}>{formatDate(note.date)}</time></h2>
     <span className="text-sm muted">{appName(note.platforms)}</span>
    </div>
    <ul className="mt-4 list-disc pl-5 space-y-2 leading-7">
     {(note.items[locale]?.length?note.items[locale]:note.items.en).map((line,index)=><li key={index}>{line}</li>)}
    </ul>
   </section>)}
  </div>
 </article>;
}
