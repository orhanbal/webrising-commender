import {useEffect} from "react";
import {ArrowRight} from "lucide-react";
import {publicPages,pageByPath,type Block} from "../../../src/site-content";
import {NavLink,type Nav} from "../App";

// Docs, FAQ, alternatives, security and guides. The same text is served as
// plain HTML to crawlers (gateway/src/site-content.ts), so both stay identical.
const sectionLabel:Record<string,string>={Docs:"Documentation",Guides:"Guide",Product:"Product",Legal:"Legal"};

function BlockView({block}:{block:Block}){
 if("h2" in block)return <h2 className="content-h2">{block.h2}</h2>;
 if("p" in block)return <p className="content-p">{block.p}</p>;
 if("ul" in block)return <ul className="content-ul">{block.ul.map(item=><li key={item}>{item}</li>)}</ul>;
 if("code" in block)return <pre className="content-code"><code>{block.code}</code></pre>;
 return <div className="content-table-wrap"><table className="content-table">
  <thead><tr>{block.table.head.map((h,i)=><th key={i}>{h}</th>)}</tr></thead>
  <tbody>{block.table.rows.map((row,r)=><tr key={r}>{row.map((cell,i)=>i===0?<th key={i} scope="row">{cell}</th>:<td key={i} className={i===row.length-1?"content-ours":""}>{cell}</td>)}</tr>)}</tbody>
 </table></div>;
}

export function ContentPage({path,nav}:{path:string;nav:Nav}){
 const page=pageByPath.get(path);
 useEffect(()=>{if(page)document.title=page.title},[page]);
 if(!page)return null;
 const related=publicPages.filter(p=>p.content&&p.path!==path);
 return <div className="container-w content-page">
  <article className="content-article">
   <p className="content-kicker">{sectionLabel[page.section]}</p>
   <h1 className="content-h1">{page.heading}</h1>
   <p className="content-lead">{page.intro}</p>
   {page.blocks.map((block,i)=><BlockView key={i} block={block}/>)}
   {page.faq&&<div className="content-faq">{page.faq.map(item=><details key={item.q}><summary>{item.q}</summary><p>{item.a}</p></details>)}</div>}
   {page.howTo&&<><h2 className="content-h2">{page.howTo.name}</h2><ol className="content-ol">{page.howTo.steps.map(step=><li key={step}>{step}</li>)}</ol></>}
   <div className="content-cta"><NavLink to="/install" nav={nav} className="content-cta-link">Install WECOMMANDER <ArrowRight size={16}/></NavLink></div>
  </article>
  <aside className="content-aside" aria-label="More">
   <strong>Docs and guides</strong>
   {related.map(p=><NavLink key={p.path} to={p.path} nav={nav}>{p.heading}</NavLink>)}
  </aside>
 </div>;
}
