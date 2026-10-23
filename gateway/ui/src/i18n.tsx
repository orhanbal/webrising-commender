import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, Globe2 } from "lucide-react";
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
  const [open,setOpen]=useState(false);
  const root=useRef<HTMLDivElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  const choices=useRef<Array<HTMLButtonElement|null>>([]);
  const options:[Locale,string][]=[["en","English (EN)"],["tr","Türkçe (TR)"]];
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
      aria-label={current==="en"?"Select language":"Dil seçin"} aria-haspopup="menu" aria-expanded={open}
      onClick={()=>setOpen(value=>!value)}
      onKeyDown={event=>{if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();setOpen(true);requestAnimationFrame(()=>focusOption(event.key==="ArrowDown"?0:options.length-1))}}}>
      <Globe2 size={17} aria-hidden="true"/>
      <span>{current==="en"?"English (EN)":"Türkçe (TR)"}</span>
      <ChevronDown size={15} className={"locale-chevron"+(open?" locale-chevron-open":"")} aria-hidden="true"/>
    </button>
    {open&&<div className="locale-menu" role="menu" aria-label={current==="en"?"Language":"Dil"}>
      {options.map(([code,label],index)=><button key={code} type="button" role="menuitemradio"
        aria-checked={current===code} ref={node=>{choices.current[index]=node}}
        className={"locale-option"+(current===code?" locale-option-active":"")}
        onClick={()=>choose(code)}
        onKeyDown={event=>{
          if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();focusOption(index+(event.key==="ArrowDown"?1:-1))}
          if(event.key==="Home"){event.preventDefault();focusOption(0)}
          if(event.key==="End"){event.preventDefault();focusOption(options.length-1)}
          if(event.key==="Tab")setOpen(false);
        }}>
        <span>{label}</span>
        {current===code&&<Check size={16} aria-hidden="true"/>}
      </button>)}
    </div>}
  </div>;
}
