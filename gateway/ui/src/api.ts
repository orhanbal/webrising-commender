import {errorText} from "./lib";
export type Account={organizationId:string;email:string|null;actor:string;role:string;authKind:string;global?:boolean};
export type Device={id:string;name:string;online:boolean;last_seen_at?:string;platform?:string;hostname?:string;revoked_at?:string|null;agent_version?:string|null};
export type Plan={key:string;name:string;description:string;featured:boolean;priceLabel:string|null;priceId:string|null;features:string[];maxDevices:number|null;maxMembers:number|null;maxApiTokens:number|null};
export type Pricing={mode:"saas"|"self_hosted";plans:Plan[];paddle:{clientToken:string|null;checkoutEnabled:boolean;environment:"sandbox"|"live"}};
export type Usage={monthCalls:number;limit:number|null;dailyAverage:number;resetAt:string|null;daily:Array<{day:string;calls:number}>;months:Array<{month:string;calls:number}>;topTools:Array<{tool:string;calls:number}>};
export type Billing={mode:string;entitled:boolean;plan:{key:string;name:string}|null;subscription:{status:string;currentPeriodEnd?:string;cancelAtPeriodEnd?:boolean;provider?:string}|null;usage?:{devices:number}};
function readCookie(name:string){const value=document.cookie.split("; ").find(x=>x.startsWith(name+"="));return value?decodeURIComponent(value.slice(name.length+1)):""}
export async function api<T>(path:string,options:RequestInit={}):Promise<T>{
 const method=(options.method||"GET").toUpperCase();
 const headers=new Headers(options.headers||{});
 if(!["GET","HEAD"].includes(method))headers.set("X-CSRF-Token",readCookie("commender_csrf"));
 if(options.body&&typeof options.body==="string")headers.set("Content-Type","application/json");
 const res=await fetch(path,{...options,headers,credentials:"same-origin",cache:"no-store"});
 const body=await res.json().catch(()=>({}));
 if(!res.ok)throw new Error(errorText(typeof body.error==="string"?body.error:"HTTP "+res.status));
 return body as T;
}
export async function getMe(){try{return await api<Account>("/api/auth/me")}catch{return null}}
