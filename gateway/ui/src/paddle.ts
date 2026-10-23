export type PaddleClient={Environment:{set:(environment:"sandbox")=>void};Initialize:(options:{token:string;eventCallback?:(event:{name:string;data?:unknown})=>void})=>void;Checkout:{open:(options:{transactionId:string;settings:{displayMode:"overlay";theme:"light"|"dark";locale:"tr"}})=>void;close:()=>void}};
declare global{interface Window{Paddle?:PaddleClient}}
let loadPromise:Promise<PaddleClient>|null=null;
let isInitialized=false;
export async function loadPaddle(token:string,environment:"sandbox"|"live",onCompleted:()=>void):Promise<PaddleClient>{
 if(!token||(environment==="sandbox"?!token.startsWith("test_"):!token.startsWith("live_")))throw new Error("Paddle istemci yapılandırması geçersiz.");
 if(!loadPromise)loadPromise=new Promise<PaddleClient>((resolve,reject)=>{
  if(window.Paddle){resolve(window.Paddle);return}
  const script=document.createElement("script");script.src="https://cdn.paddle.com/paddle/v2/paddle.js";script.async=true;
  script.onload=()=>window.Paddle?resolve(window.Paddle):reject(new Error("Paddle Checkout yüklenemedi."));
  script.onerror=()=>reject(new Error("Paddle'a bağlanılamadı. İnternet bağlantınızı kontrol edin."));
  document.head.appendChild(script);
 }).catch(err=>{loadPromise=null;throw err});
 const paddle=await loadPromise;
 if(!isInitialized){
  if(environment==="sandbox")paddle.Environment.set("sandbox");
  paddle.Initialize({token,eventCallback:(event)=>{if(event.name==="checkout.completed")onCompleted()}});
  isInitialized=true;
 }
 return paddle;
}
