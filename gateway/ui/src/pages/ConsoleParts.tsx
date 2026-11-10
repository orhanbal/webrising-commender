import type {ReactNode} from "react";
import {ChevronLeft,ChevronRight,Search} from "lucide-react";
import {cn} from "../lib";

/** Shared building blocks for the platform administration console. */

export type Tone="neutral"|"success"|"warning"|"danger"|"info"|"accent";
const toneClass:Record<Tone,string>={
 neutral:"bg-[var(--subtle-surface)] text-[var(--muted)] border-[var(--stroke)]",
 success:"bg-[var(--success-soft)] text-[var(--success)] border-[color-mix(in_srgb,var(--success)_35%,transparent)]",
 warning:"bg-[var(--warning-soft)] text-[var(--warning)] border-[color-mix(in_srgb,var(--warning)_40%,transparent)]",
 danger:"bg-[var(--danger-soft)] text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_40%,transparent)]",
 info:"bg-[var(--info-soft)] text-[var(--info)] border-[color-mix(in_srgb,var(--info)_35%,transparent)]",
 accent:"bg-[var(--accent-soft)] text-[var(--accent)] border-[color-mix(in_srgb,var(--accent)_35%,transparent)]",
};
export function Pill({tone="neutral",children,dot=false}:{tone?:Tone;children:ReactNode;dot?:boolean}){
 return <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap",toneClass[tone])}>
  {dot&&<span aria-hidden="true" className="size-1.5 rounded-full bg-current"/>}{children}
 </span>;
}

/** "3 days ago" with the exact local time in the tooltip. */
export function relativeTime(value:unknown,locale:"en"|"tr"):{text:string;title:string}|null{
 if(typeof value!=="string"||!value)return null;
 const date=new Date(value);
 if(Number.isNaN(date.getTime()))return null;
 const tag=locale==="tr"?"tr-TR":"en-US";
 const seconds=(date.getTime()-Date.now())/1000;
 const units:Array<[Intl.RelativeTimeFormatUnit,number]>=[["year",31536000],["month",2592000],["week",604800],["day",86400],["hour",3600],["minute",60]];
 const format=new Intl.RelativeTimeFormat(tag,{numeric:"auto"});
 let text=format.format(0,"minute");
 for(const [unit,size] of units){if(Math.abs(seconds)>=size){text=format.format(Math.round(seconds/size),unit);break}}
 if(Math.abs(seconds)<60)text=locale==="tr"?"az önce":"just now";
 return {text,title:date.toLocaleString(tag)};
}
export function When({value,locale,empty}:{value:unknown;locale:"en"|"tr";empty:string}){
 const time=relativeTime(value,locale);
 return time?<time dateTime={String(value)} title={time.title} className="whitespace-nowrap">{time.text}</time>:<span className="text-[var(--faint)]">{empty}</span>;
}

export function ShortId({value}:{value:unknown}){
 const text=String(value??"");
 return <code className="font-mono text-[11px] text-[var(--faint)]" title={text}>{text.replace(/^(tenant|platform):/,"").slice(0,8)}</code>;
}

/** Card section with a title row. */
export function Panel({title,description,actions,children,className,flush=false}:{title?:ReactNode;description?:ReactNode;actions?:ReactNode;children:ReactNode;className?:string;flush?:boolean}){
 return <section className={cn("console-panel rounded-2xl border border-[var(--stroke)] bg-[var(--surface)]",className)}>
  {(title||actions)&&<div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 pb-4">
   <div className="min-w-0">{title&&<h2 className="text-base font-bold tracking-tight">{title}</h2>}{description&&<p className="mt-1 text-sm text-[var(--muted)]">{description}</p>}</div>
   {actions&&<div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>}
  <div className={flush?"":"px-5 pb-5"}>{children}</div>
 </section>;
}

export function Stat({label,value,hint,icon:Icon,tone="accent",onClick}:{label:string;value:ReactNode;hint?:ReactNode;icon:React.ComponentType<{size?:number}>;tone?:Tone;onClick?:()=>void}){
 const body=<>
  <div className="flex items-center justify-between gap-3"><span className="text-sm text-[var(--muted)]">{label}</span><span className={cn("grid size-9 place-items-center rounded-xl border",toneClass[tone])}><Icon size={18}/></span></div>
  <div className="mt-3 text-3xl font-bold tracking-tight tabular-nums">{value}</div>
  {hint&&<div className="mt-1 text-xs text-[var(--muted)]">{hint}</div>}
 </>;
 const cls="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-5 text-left";
 return onClick?<button type="button" onClick={onClick} className={cn(cls,"transition-colors hover:border-[var(--accent)]")}>{body}</button>:<section className={cls}>{body}</section>;
}

export const fieldClass="h-10 rounded-xl border border-[var(--stroke)] bg-[var(--input)] px-3 text-sm outline-none focus-visible:border-[var(--accent)]";
export const smallButton="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--stroke)] bg-[var(--surface)] px-3 text-sm font-medium hover:bg-[var(--hover)] disabled:opacity-40";

/** Search box, optional filters and a compact pager. */
export function Toolbar({search,onSearch,placeholder,label,filters,page,total,pageSize=25,onPage,busy,ui}:{
 search:string;onSearch:(v:string)=>void;placeholder:string;label:string;filters?:ReactNode;
 page:number;total:number;pageSize?:number;onPage:(p:number)=>void;busy:boolean;ui:(s:string)=>string;
}){
 const pages=Math.max(1,Math.ceil(total/pageSize));
 const from=total===0?0:page*pageSize+1,to=Math.min(total,(page+1)*pageSize);
 return <div className="flex flex-wrap items-center gap-2 px-5 pb-4">
  <label className="relative flex-1 min-w-[220px]">
   <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--faint)]"/>
   <input aria-label={label} placeholder={placeholder} value={search} onChange={e=>onSearch(e.target.value)} className={cn(fieldClass,"w-full pl-9")}/>
  </label>
  {filters}
  <div className="ml-auto flex items-center gap-2 text-sm text-[var(--muted)]">
   <span className="tabular-nums whitespace-nowrap">{from}–{to} / {total}</span>
   <button type="button" aria-label={ui("Previous")} title={ui("Previous")} disabled={busy||page===0} onClick={()=>onPage(Math.max(0,page-1))} className={cn(smallButton,"px-2")}><ChevronLeft size={16}/></button>
   <span className="sr-only">{ui("Page")} {page+1} / {pages}</span>
   <button type="button" aria-label={ui("Next")} title={ui("Next")} disabled={busy||page+1>=pages} onClick={()=>onPage(page+1)} className={cn(smallButton,"px-2")}><ChevronRight size={16}/></button>
  </div>
 </div>;
}

export type Column<T>={key:string;label:string;render:(row:T)=>ReactNode;className?:string};
/** Table on desktop, labelled cards on phones (see .console-table in styles.css). */
export function AdminTable<T>({columns,rows,rowKey}:{columns:Column<T>[];rows:T[];rowKey:(row:T,i:number)=>string}){
 return <div className="w-full overflow-x-auto border-t border-[var(--stroke)]">
  <table className="console-table w-full text-sm text-left">
   <thead><tr>{columns.map(c=><th key={c.key} scope="col" className={c.className}>{c.label}</th>)}</tr></thead>
   <tbody>{rows.map((row,i)=><tr key={rowKey(row,i)}>{columns.map(c=><td key={c.key} data-label={c.label} className={c.className}>{c.render(row)}</td>)}</tr>)}</tbody>
  </table>
 </div>;
}
