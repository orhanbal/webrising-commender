import {useEffect,useMemo,useState} from "react";
import {ArrowLeft,ArrowRight,Check,ChevronDown,Copy,Info} from "../components/icons";
import {api} from "../api";
import {NavLink,type Nav} from "../App";
import {Spinner} from "../components/ui";

// Docs, FAQ, alternatives, security and guides. The text comes from the
// gateway (gateway/src/site-content.ts and docs-content.ts), the same source
// as the pre-rendered HTML that crawlers read and /llms.txt. Documentation
// pages (/docs and /docs/<slug>) get a sidebar with every section, an
// "On this page" list and heading anchors.
type Block={h2:string}|{h3:string}|{p:string}|{ul:string[]}|{ol:string[]}|{code:string}|{note:string}|{see:string[]}|{table:{head:string[];rows:string[][]}};
type Page={path:string;title:string;heading:string;intro:string;section:string;docGroup?:string;blocks:Block[];faq?:{q:string;a:string}[];howTo?:{name:string;steps:string[]}};
type NavItem={path:string;heading:string;description:string;group?:string};
type Response={page:Page;related:{path:string;heading:string}[];nav?:NavItem[]};
const sectionLabel:Record<string,string>={Docs:"Documentation",Guides:"Guide",Product:"Product",Legal:"Legal"};

/** The same ids as the pre-rendered HTML (site-content.ts anchorId), so shared links keep working. */
function anchorId(text:string){
 return text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,80)||"section";
}

function CodeBlock({code}:{code:string}){
 const [copied,setCopied]=useState(false);
 const copy=async()=>{try{await navigator.clipboard.writeText(code);setCopied(true);setTimeout(()=>setCopied(false),2000)}catch{/* clipboard unavailable */}};
 return <div className="content-code-wrap">
  <button type="button" className="content-code-copy" onClick={()=>void copy()} aria-label={copied?"Copied":"Copy to clipboard"}>{copied?<Check size={14}/>:<Copy size={14}/>}<span>{copied?"Copied":"Copy"}</span></button>
  <pre className="content-code"><code>{code}</code></pre>
 </div>;
}

function Heading({level,text}:{level:2|3;text:string}){
 const id=anchorId(text);
 const Tag=level===2?"h2":"h3";
 return <Tag id={id} className={level===2?"content-h2":"content-h3"}>{text}<a className="content-anchor" href={"#"+id} aria-label={"Link to "+text}>#</a></Tag>;
}

function BlockView({block,nav,links}:{block:Block;nav:Nav;links:Map<string,NavItem>}){
 if("h2" in block)return <Heading level={2} text={block.h2}/>;
 if("h3" in block)return <Heading level={3} text={block.h3}/>;
 if("p" in block)return <p className="content-p">{block.p}</p>;
 if("note" in block)return <div className="content-note" role="note"><Info size={18} aria-hidden="true"/><p>{block.note}</p></div>;
 if("ul" in block)return <ul className="content-ul">{block.ul.map(item=><li key={item}>{item}</li>)}</ul>;
 if("ol" in block)return <ol className="content-ol">{block.ol.map(item=><li key={item}>{item}</li>)}</ol>;
 if("code" in block)return <CodeBlock code={block.code}/>;
 if("see" in block)return <div className="content-see">{block.see.map(path=>{const item=links.get(path);return item?<NavLink key={path} to={path} nav={nav} className="content-see-card"><strong>{item.heading}</strong><span>{item.description}</span></NavLink>:null})}</div>;
 return <div className="content-table-wrap"><table className="content-table">
  <thead><tr>{block.table.head.map((h,i)=><th key={i}>{h}</th>)}</tr></thead>
  <tbody>{block.table.rows.map((row,r)=><tr key={r}>{row.map((cell,i)=>i===0?<th key={i} scope="row">{cell}</th>:<td key={i} className={i===row.length-1?"content-ours":""}>{cell}</td>)}</tr>)}</tbody>
 </table></div>;
}

/** Every documentation page by section, with a filter; folds away on narrow screens. */
function DocsSidebar({items,current,nav}:{items:NavItem[];current:string;nav:Nav}){
 const [open,setOpen]=useState(false);
 const [filter,setFilter]=useState("");
 const groups=useMemo(()=>{
  const q=filter.trim().toLowerCase();
  const map=new Map<string,NavItem[]>();
  for(const item of items){
   if(!item.group)continue;
   if(q&&!(item.heading+" "+item.description).toLowerCase().includes(q))continue;
   map.set(item.group,[...(map.get(item.group)??[]),item]);
  }
  return [...map.entries()];
 },[items,filter]);
 return <aside className={"docs-sidebar"+(open?" open":"")} aria-label="Documentation">
  <button type="button" className="docs-sidebar-toggle" aria-expanded={open} onClick={()=>setOpen(!open)}>Documentation menu <ChevronDown size={16}/></button>
  <div className="docs-sidebar-body">
   <NavLink to="/docs" nav={nav} className={"docs-sidebar-home"+(current==="/docs"?" active":"")}>All documentation</NavLink>
   <input className="docs-filter" type="search" placeholder="Filter topics" aria-label="Filter documentation topics" value={filter} onChange={e=>setFilter(e.target.value)}/>
   {groups.map(([group,pages])=><div key={group} className="docs-sidebar-group">
    <strong>{group}</strong>
    {pages.map(p=><NavLink key={p.path} to={p.path} nav={nav} className={current===p.path?"active":""}>{p.heading}</NavLink>)}
   </div>)}
   {groups.length===0&&<p className="docs-empty">No topic matches.</p>}
  </div>
 </aside>;
}

function OnThisPage({page}:{page:Page}){
 const headings=page.blocks.flatMap(b=>"h2" in b?[b.h2]:[]);
 if(headings.length<2)return null;
 return <nav className="docs-toc" aria-label="On this page">
  <strong>On this page</strong>
  {headings.map(h=><a key={h} href={"#"+anchorId(h)}>{h}</a>)}
 </nav>;
}

export function ContentPage({path,nav}:{path:string;nav:Nav}){
 const [data,setData]=useState<Response|null>(null);
 const [failed,setFailed]=useState(false);
 useEffect(()=>{
  let active=true;setData(null);setFailed(false);
  api<Response>("/api/public/pages?path="+encodeURIComponent(path))
   .then(next=>{if(!active)return;setData(next);document.title=next.page.title})
   .catch(()=>{if(active)setFailed(true)});
  return()=>{active=false};
 },[path]);
 // A shared link to a heading (#anchor) scrolls there once the text is in.
 useEffect(()=>{
  if(!data||!location.hash)return;
  const target=document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if(target)requestAnimationFrame(()=>target.scrollIntoView());
 },[data]);
 const links=useMemo(()=>new Map((data?.nav??[]).map(item=>[item.path,item])),[data]);
 if(failed)return <div className="container-w content-page"><p className="content-lead">This page could not be loaded. Please try again.</p></div>;
 if(!data)return <div className="grid min-h-[50vh] place-items-center"><Spinner/></div>;
 const page=data.page;
 const body=<>
  {page.blocks.map((block,i)=><BlockView key={i} block={block} nav={nav} links={links}/>)}
  {page.faq&&<div className="content-faq">{page.faq.map(item=><details key={item.q}><summary>{item.q}</summary><p>{item.a}</p></details>)}</div>}
  {page.howTo&&<><Heading level={2} text={page.howTo.name}/><ol className="content-ol">{page.howTo.steps.map(step=><li key={step}>{step}</li>)}</ol></>}
 </>;
 const isDocs=page.path==="/docs"||!!page.docGroup;
 if(!isDocs)return <div className="container-w content-page">
  <article className="content-article">
   <p className="content-kicker">{sectionLabel[page.section]??page.section}</p>
   <h1 className="content-h1">{page.heading}</h1>
   <p className="content-lead">{page.intro}</p>
   {body}
   <div className="content-cta"><NavLink to="/install" nav={nav} className="content-cta-link">Install WECOMMANDER <ArrowRight size={16}/></NavLink></div>
  </article>
  <aside className="content-aside" aria-label="More">
   <strong>Docs and guides</strong>
   {data.related.map(p=><NavLink key={p.path} to={p.path} nav={nav}>{p.heading}</NavLink>)}
  </aside>
 </div>;
 const docs=(data.nav??[]).filter(item=>item.group);
 const index=docs.findIndex(item=>item.path===page.path);
 const prev=index>0?docs[index-1]:null;
 const next=index>=0&&index<docs.length-1?docs[index+1]:page.path==="/docs"?docs[0]:null;
 return <div className="container-w docs-layout">
  <DocsSidebar items={docs} current={page.path} nav={nav}/>
  <article className="content-article docs-article">
   <nav className="docs-breadcrumb" aria-label="Breadcrumb">
    <NavLink to="/docs" nav={nav}>Documentation</NavLink>{page.docGroup&&<><span aria-hidden="true">/</span><span>{page.docGroup}</span></>}
   </nav>
   <h1 className="content-h1">{page.heading}</h1>
   <p className="content-lead">{page.intro}</p>
   {body}
   {(prev||next)&&<nav className="docs-pager" aria-label="Previous and next page">
    {prev?<NavLink to={prev.path} nav={nav} className="docs-pager-link"><small><ArrowLeft size={14}/> Previous</small><strong>{prev.heading}</strong></NavLink>:<span/>}
    {next&&<NavLink to={next.path} nav={nav} className="docs-pager-link docs-pager-next"><small>Next <ArrowRight size={14}/></small><strong>{next.heading}</strong></NavLink>}
   </nav>}
  </article>
  <OnThisPage page={page}/>
 </div>;
}
