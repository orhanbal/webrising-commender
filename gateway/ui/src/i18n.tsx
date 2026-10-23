import { useSyncExternalStore } from "react";
import { Globe2 } from "lucide-react";
import { commonEnglish } from "./i18n-common";
import { marketingEnglish } from "./i18n-marketing";
import { productEnglish } from "./i18n-product";

export type Locale = "en" | "tr";
const storageKey = "wecommander-language";
const translationTable:Record<string,string> = {...commonEnglish,...marketingEnglish,...productEnglish};
const subscriptions = new Set<()=>void>();
function storedLocale():Locale{
  try { return window.localStorage.getItem(storageKey)==="tr"?"tr":"en"; } catch {return "en"}
}
let activeLocale:Locale = typeof window!=="undefined" ? storedLocale() : "en";

export function locale():Locale { return activeLocale; }
export function setLocale(next:Locale):void{
  if(next!=="en" && next!=="tr")return;
  activeLocale=next;
  try{window.localStorage.setItem(storageKey,next)}catch{}
  if(typeof document!=="undefined"){
    document.documentElement.lang=next;
    document.documentElement.dataset.locale=next;
  }
  subscriptions.forEach(listener=>listener());
}
export function subscribeLocale(cb:()=>void){subscriptions.add(cb);return ()=>subscriptions.delete(cb)}
export function useLocale():Locale {return useSyncExternalStore(subscribeLocale,locale,()=> "en");}

/** Turkish source string -> native English UI text (English is always default).
 * Source strings stay stable to preserve an exact Turkish secondary translation.
 * React views call this helper while rendering; never store a translated label in a module singleton.
 */
export function t(source:string):string {
  return activeLocale==="tr" ? source : (translationTable[source]??source);
}
export function localizedDate(value:string|Date|number|undefined|null,options?:Intl.DateTimeFormatOptions):string {
  if(!value)return "—";
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return "—";
  return new Intl.DateTimeFormat(activeLocale==="tr"?"tr-TR":"en-US",options).format(date);
}
export function LanguageSwitcher({compact=false}:{compact?:boolean}){
  const current=useLocale();
  return <label className={"locale-switcher"+(compact?" locale-switcher-compact":"")}>
    <Globe2 size={17} aria-hidden="true"/>
    <span className="sr-only">{current==="en"?"Language":"Dil"}</span>
    <select aria-label={current==="en"?"Select language":"Dil seçin"} value={current}
      onChange={e=>setLocale(e.target.value as Locale)}>
      <option value="en">English (EN)</option>
      <option value="tr">Türkçe (TR)</option>
    </select>
  </label>;
}
