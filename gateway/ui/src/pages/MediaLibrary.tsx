import {useEffect,useState} from "react";
import {ImagePlus} from "lucide-react";
import {api} from "../api";
import {useLocale} from "../i18n";
import {consoleText} from "../console-text";

type MediaAsset={id:string;alt_text:string;content_type:string;bytes:number;created_at:string};
const acceptable=new Set(["image/png","image/webp"]);

export function MediaLibrary({onUse,selected}:{onUse:(id:string,slot:number)=>void;selected:Record<string,string>}){
 const language=useLocale(),ui=(source:string)=>consoleText(source,language);
 const [items,setItems]=useState<MediaAsset[]>([]);
 const [alt,setAlt]=useState("");
 const [password,setPassword]=useState("");
 const [preview,setPreview]=useState("");
 const [mime,setMime]=useState<"image/png"|"image/webp">("image/png");
 const [error,setError]=useState("");
 const [status,setStatus]=useState("");
 const [busy,setBusy]=useState(false);
 const [slot,setSlot]=useState(0);
 const reload=async()=>{
  const response=await api<{items:MediaAsset[]}>("/api/console/media");
  setItems(response.items);
 };
 useEffect(()=>{void reload().catch(e=>setError(String(e)))},[]);
 const onFile=async(file?:File)=>{
  if(!file)return;
  setError("");setPreview("");setStatus("");
  const svg=file.type==="image/svg+xml"||file.name.toLowerCase().endsWith(".svg");
  if(svg){
   if(file.size>250000){setError("SVG source must be under 250 KB");return;}
   const url=URL.createObjectURL(file);
   const img=new Image();
   img.onload=()=>{
    try{
     const ratio=Math.min(1,1024/Math.max(1,img.naturalWidth),1024/Math.max(1,img.naturalHeight));
     const canvas=document.createElement("canvas");
     canvas.width=Math.max(1,Math.round((img.naturalWidth||512)*ratio));
     canvas.height=Math.max(1,Math.round((img.naturalHeight||512)*ratio));
     const context=canvas.getContext("2d");
     if(!context)throw new Error("Canvas unavailable");
     context.drawImage(img,0,0,canvas.width,canvas.height);
     const raster=canvas.toDataURL("image/png");
     if((raster.length-raster.indexOf(",")-1)*3/4>500000)throw new Error("Rasterized image exceeds 500 KB");
     setMime("image/png");setPreview(raster);
    }catch(e){setError(String(e))}finally{URL.revokeObjectURL(url)}
   };
   img.onerror=()=>{URL.revokeObjectURL(url);setError("Cannot decode SVG")};
   img.src=url;return;
  }
  if(!acceptable.has(file.type)||file.size>500000){setError("Choose PNG or WebP under 500 KB");return}
  const reader=new FileReader();
  reader.onload=()=>{setMime(file.type as "image/png"|"image/webp");setPreview(String(reader.result))};
  reader.onerror=()=>setError("Unable to read image");
  reader.readAsDataURL(file);
 };
 const upload=async()=>{
  if(!preview)return;
  setBusy(true);setError("");setStatus("");
  try{
   await api("/api/console/media/upload",{method:"POST",body:JSON.stringify({
    alt:alt.trim(),mime,base64:preview.split(",")[1],currentPassword:password,
   })});
   await reload();setAlt("");setPassword("");setPreview("");
   setStatus("Image uploaded. Assign it below and publish the CMS revision to make it live.");
  }catch(e){setError(String(e))}finally{setBusy(false)}
 };
 return <div className="rounded-2xl border border-[var(--stroke)] bg-[var(--surface)] p-5 mt-8">
  <div className="flex items-center gap-3 mb-2"><ImagePlus size={22}/><h3 className="text-lg font-bold">{ui("Landing media library")}</h3></div>
  <p className="muted text-sm mb-5">{ui("Upload up to 500 KB PNG/WebP or rasterize SVG locally, then assign an image to a feature card. Published content changes only after CMS publication.")}</p>
  <div className="grid gap-3 sm:grid-cols-2">
   <label className="text-sm font-semibold">{ui("Accessible image description")}
    <input value={alt} maxLength={180} onChange={e=>setAlt(e.target.value)} className="mt-2 block w-full border border-[var(--stroke)] rounded-xl bg-[var(--surface)] p-3"/>
   </label>
   <label className="text-sm font-semibold">{ui("Image file")}
    <input type="file" accept="image/png,image/webp,image/svg+xml,.svg" onChange={e=>void onFile(e.target.files?.[0])} className="mt-2 block w-full text-sm"/>
   </label>
   <label className="text-sm font-semibold">{ui("Current admin password")}
    <input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} className="mt-2 block w-full border border-[var(--stroke)] rounded-xl bg-[var(--surface)] p-3"/>
   </label>
   {preview&&<img src={preview} alt={alt||"Image preview"} className="max-w-[220px] max-h-[150px] rounded-xl object-contain"/>}
  </div>
  <button type="button" disabled={busy||alt.trim().length===0||password.length<12||!preview} className="mt-4 rounded-xl bg-[var(--accent)] text-[var(--accent-ink)] px-5 py-3 font-semibold disabled:opacity-40" onClick={()=>void upload()}>{ui("Upload to library")}</button>
  {status&&<p className="mt-3 text-sm" role="status">{ui(status)}</p>}
  {error&&<p className="mt-3 text-sm text-[var(--danger)]" role="alert">{error}</p>}
  <label className="block text-sm font-semibold mt-7 mb-4">{ui("Target feature card")}
   <select value={slot} onChange={e=>setSlot(Number(e.target.value))} className="block mt-2 rounded-xl border border-[var(--stroke)] bg-[var(--surface)] p-3">
    {Array.from({length:6},(_,i)=><option value={i} key={i}>{ui("Feature card")} {i+1}</option>)}
   </select>
  </label>
  {items.length===0?<p className="muted text-sm">{ui("No library images yet.")}</p>:<div className="grid grid-cols-2 md:grid-cols-3 gap-3">
   {items.map(item=><div className="rounded-xl border border-[var(--stroke)] p-3" key={item.id}>
    <img src={"/api/public/media/"+item.id} alt={item.alt_text} loading="lazy" className="w-full h-28 object-contain"/>
    <p className="text-xs font-medium mt-2 line-clamp-2">{item.alt_text}</p>
    <button type="button" className="mt-3 border border-[var(--stroke)] rounded-lg text-xs px-3 py-2" onClick={()=>onUse(item.id,slot)}>{selected["media:feature:"+slot]===item.id?ui("Selected"):ui("Use in card")}</button>
   </div>)}
  </div>}
  <p className="muted text-xs mt-5">{ui("Library assets are retained to preserve the integrity of previously published revisions.")}</p>
 </div>;
}
