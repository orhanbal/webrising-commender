import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Flag } from "./components/Flag";
import { commonEnglish } from "./i18n-common";
import { marketingEnglish } from "./i18n-marketing";
import { productEnglish } from "./i18n-product";

/** The six languages of the first release; adding one is a table file plus a line here. */
export const LOCALES = [
  { code: "en", name: "English", short: "EN", intl: "en-US", paddle: "en" },
  { code: "tr", name: "Türkçe", short: "TR", intl: "tr-TR", paddle: "tr" },
  { code: "de", name: "Deutsch", short: "DE", intl: "de-DE", paddle: "de" },
  { code: "pt-BR", name: "Português (Brasil)", short: "PT", intl: "pt-BR", paddle: "pt" },
  { code: "es", name: "Español", short: "ES", intl: "es-ES", paddle: "es" },
  { code: "fr", name: "Français", short: "FR", intl: "fr-FR", paddle: "fr" },
] as const;
export type Locale = (typeof LOCALES)[number]["code"];
const storageKey = "wecommander-language";
const translationTable:Record<string,string> = {...commonEnglish,...marketingEnglish,...productEnglish};
// The other languages load on demand (each is a large table): Turkish source -> text.
const loaders:Record<string,()=>Promise<Record<string,string>>> = {
  de: () => import("./locales/de").then((m) => m.table),
  "pt-BR": () => import("./locales/pt-BR").then((m) => m.table),
  es: () => import("./locales/es").then((m) => m.table),
  fr: () => import("./locales/fr").then((m) => m.table),
};
const loaded:Record<string,Record<string,string>> = {};
const subscriptions = new Set<()=>void>();

export function isLocale(value:unknown):value is Locale { return LOCALES.some((l) => l.code === value); }

/** A browser or system language tag (de-AT, pt-BR, es-419) to one of ours; null when we have none. */
export function matchLocale(tag:string|null|undefined):Locale|null {
  const lower=(tag||"").toLowerCase();
  if(!lower)return null;
  if(lower.startsWith("pt"))return "pt-BR";
  const base=lower.split(/[-_]/)[0];
  return (LOCALES.find((l) => l.code === base)?.code as Locale|undefined) ?? null;
}

function initialLocale():Locale{
  // ?lang=de (links from search engines' hreflang alternates) wins, then the saved choice, then the browser.
  try {
    const fromUrl=new URLSearchParams(window.location.search).get("lang");
    if(isLocale(fromUrl))return fromUrl;
    const saved=window.localStorage.getItem(storageKey);
    if(isLocale(saved))return saved;
  } catch {}
  try {
    for(const tag of navigator.languages?.length?navigator.languages:[navigator.language]){
      const match=matchLocale(tag);
      if(match)return match;
    }
  } catch {}
  return "en";
}
let activeLocale:Locale = typeof window!=="undefined" ? initialLocale() : "en";

function applyDocument(){
  if(typeof document!=="undefined"){
    document.documentElement.lang=activeLocale;
    document.documentElement.dataset.locale=activeLocale;
  }
}
function ensureTable(code:Locale){
  const load=loaders[code];
  if(!load||loaded[code])return;
  void load().then((table)=>{loaded[code]=table;subscriptions.forEach(listener=>listener())}).catch(()=>{});
}
if(typeof window!=="undefined"){applyDocument();ensureTable(activeLocale);}

export function locale():Locale { return activeLocale; }
/** Intl tag of the current language (dates, numbers). */
export function intlLocale():string { return LOCALES.find((l)=>l.code===activeLocale)?.intl ?? "en-US"; }
/** Paddle checkout language. */
export function paddleLocale():string { return LOCALES.find((l)=>l.code===activeLocale)?.paddle ?? "en"; }
export function setLocale(next:Locale):void{
  if(!isLocale(next))return;
  activeLocale=next;
  try{window.localStorage.setItem(storageKey,next)}catch{}
  applyDocument();
  ensureTable(next);
  subscriptions.forEach(listener=>listener());
}
let version=0;
subscriptions.add(()=>{version++;});
export function subscribeLocale(cb:()=>void){subscriptions.add(cb);return ()=>subscriptions.delete(cb)}
export function useLocale():Locale {
  // Re-renders also when a language's table finishes loading.
  useSyncExternalStore(subscribeLocale,()=>version,()=>0);
  return useSyncExternalStore(subscribeLocale,locale,()=> "en");
}

/** Turkish source string -> native English UI text (English is always default).
 * Source strings stay stable to preserve an exact Turkish secondary translation.
 * React views call this helper while rendering; never store a translated label in a module singleton.
 */
export function t(source:string):string {
  if(activeLocale==="tr")return source;
  if(activeLocale!=="en"){const own=loaded[activeLocale]?.[source];if(own)return own;}
  return translationTable[source]??source;
}
/** The text in a given language (for plan names that come from the server). */
export function tIn(code:Locale,source:string):string|undefined {
  if(code==="tr")return source;
  if(code==="en")return translationTable[source];
  return loaded[code]?.[source];
}
export function localizedDate(value:string|Date|number|undefined|null,options?:Intl.DateTimeFormatOptions):string {
  if(!value)return "—";
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return "—";
  return new Intl.DateTimeFormat(intlLocale(),options).format(date);
}
export function LanguageSwitcher({compact=false}:{compact?:boolean}){
  const current=useLocale();
  const [open,setOpen]=useState(false);
  const root=useRef<HTMLDivElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  const choices=useRef<Array<HTMLButtonElement|null>>([]);
  // Each language in its own name, with its code.
  const options:[Locale,string,string][]=LOCALES.map(l=>[l.code,l.name,l.short]);
  const currentEntry=LOCALES.find(l=>l.code===current)??LOCALES[0];
  useEffect(()=>{
    if(!open)return;
    const onPointer=(event:PointerEvent)=>{
      if(root.current && !root.current.contains(event.target as Node))setOpen(false);
    };
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){setOpen(false);trigger.current?.focus();}
    };
    document.addEventListener("pointerdown",onPointer);
    document.addEventListener("keydown",onKey);
    return ()=>{document.removeEventListener("pointerdown",onPointer);document.removeEventListener("keydown",onKey)};
  },[open]);
  const choose=(next:Locale)=>{setLocale(next);setOpen(false);trigger.current?.focus()};
  const focusOption=(index:number)=>choices.current[(index+options.length)%options.length]?.focus();
  return <div ref={root} className={"locale-switcher"+(compact?" locale-switcher-compact":"")}>
    <button ref={trigger} type="button" className="locale-trigger"
      aria-label={t("Dil seçin")} aria-haspopup="menu" aria-expanded={open}
      onClick={()=>setOpen(value=>!value)}
      onKeyDown={event=>{if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();setOpen(true);requestAnimationFrame(()=>focusOption(event.key==="ArrowDown"?0:options.length-1))}}}>
      <Flag code={current} size={20}/>
      {compact
        ? <span className="locale-code">{currentEntry.short}</span>
        : <><span className="locale-label-long">{currentEntry.name}</span><span className="locale-label-short" aria-hidden="true">{currentEntry.short}</span></>}
      <ChevronDown size={15} className={"locale-chevron"+(open?" locale-chevron-open":"")} aria-hidden="true"/>
    </button>
    {open&&<div className="locale-menu" role="menu" aria-label={t("Dil")}>
      <div className="locale-menu-title" aria-hidden="true">{t("Dil")}</div>
      {options.map(([code,label,short],index)=><button key={code} type="button" role="menuitemradio"
        aria-checked={current===code} ref={node=>{choices.current[index]=node}}
        className={"locale-option"+(current===code?" locale-option-active":"")}
        onClick={()=>choose(code)}
        onKeyDown={event=>{
          if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();focusOption(index+(event.key==="ArrowDown"?1:-1))}
          if(event.key==="Home"){event.preventDefault();focusOption(0)}
          if(event.key==="End"){event.preventDefault();focusOption(options.length-1)}
          if(event.key==="Tab")setOpen(false);
        }}>
        <span className="locale-option-name"><Flag code={code}/>{label}</span>
        <span className="locale-option-code">{current===code?<Check size={15} aria-hidden="true"/>:short}</span>
      </button>)}
    </div>}
  </div>;
}
