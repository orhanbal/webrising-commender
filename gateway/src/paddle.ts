import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "./db.js";
import { applyNormalizedBillingEvent, deploymentMode } from "./billing.js";

export const paddleEnvironment = process.env.PADDLE_ENVIRONMENT === "live" ? "live" : "sandbox";
const pricePattern = /^pri_[a-z0-9]{26}$/;
const customerPattern = /^ctm_[a-z0-9]{26}$/;
const transactionPattern = /^txn_[a-z0-9]{26}$/;
const subscriptionPattern = /^sub_[a-z0-9]{26}$/;

export function publicPaddleConfig() {
  const token = String(process.env.PADDLE_CLIENT_TOKEN || "").trim();
  const apiKey = String(process.env.PADDLE_API_KEY || "").trim();
  const webhookSecret = String(process.env.PADDLE_WEBHOOK_SECRET || "").trim();
  const tokenOkay = paddleEnvironment === "live" ? token.startsWith("live_") : token.startsWith("test_");
  return {
    environment: paddleEnvironment,
    clientToken: deploymentMode === "saas" && tokenOkay && apiKey && webhookSecret ? token : null,
    checkoutEnabled: Boolean(deploymentMode === "saas" && tokenOkay && apiKey && webhookSecret),
  };
}

export type PublicPlan = {
  key: string; name: string; description: string; featured: boolean;
  priceLabel: string | null; priceId: string | null; features: string[];
  maxDevices: number | null; maxMembers: number | null; maxApiTokens: number | null;
};

export async function getPublicPlans(): Promise<PublicPlan[]> {
  if (deploymentMode === "self_hosted") return [];
  const result = await db.query<{
    key: string; name: string; max_devices: number | null; max_members: number | null;
    max_api_tokens: number | null; metadata: Record<string, unknown>;
  }>("select key,name,max_devices,max_members,max_api_tokens,metadata from billing_plans where active=true order by created_at,key");
  return result.rows.map((row) => {
    const meta = row.metadata ?? {};
    const id = String(meta.paddlePriceId ?? meta.paddle_price_id ?? "").trim();
    const features = Array.isArray(meta.features) ? meta.features.filter((value): value is string => typeof value === "string").slice(0,8) : [];
    return {
      key: row.key, name: row.name, description: String(meta.description ?? "").slice(0,240),
      featured: meta.featured === true,
      priceLabel: typeof meta.priceLabel === "string" ? meta.priceLabel.slice(0,90) : null,
      priceId: pricePattern.test(id) ? id : null,
      features,
      maxDevices: row.max_devices, maxMembers: row.max_members, maxApiTokens: row.max_api_tokens,
    };
  });
}
export function checkPaddleSignature(raw: Buffer, header: string, secret: string, now=Date.now()) {
  if (!header || !secret || raw.length > 2_097_152) return false;
  const parts = header.split(";").map(x=>x.trim());
  const timestamp = parts.find(x=>x.startsWith("ts="))?.slice(3);
  const signatures = parts.filter(x=>x.startsWith("h1=")).map(x=>x.slice(3));
  if (!timestamp || !/^\d{10}$/.test(timestamp) || signatures.length===0) return false;
  const ageMs = Math.abs(now - Number(timestamp)*1000);
  if (!Number.isFinite(ageMs) || ageMs>5*60*1000) return false;
  const expected = createHmac("sha256",secret).update(timestamp+":").update(raw).digest();
  return signatures.some(value=>{
    if (!/^[a-f0-9]{64}$/i.test(value)) return false;
    return timingSafeEqual(expected,Buffer.from(value,"hex"));
  });
}
async function paddleApi<T>(route: string, options: {method?: string; body?: unknown}={}) {
  const apiKey=String(process.env.PADDLE_API_KEY||"").trim();
  if(!apiKey) throw Object.assign(new Error("paddle_not_configured"),{status:503});
  const host=paddleEnvironment==="live"?"https://api.paddle.com":"https://sandbox-api.paddle.com";
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),12000);
  try{
    const res=await fetch(host+route,{
      method:options.method||"GET",
      headers:{"Authorization":"Bearer "+apiKey,"Content-Type":"application/json"},
      ...(options.body===undefined?{}:{body:JSON.stringify(options.body)}),
      signal:controller.signal,
    });
    if(!res.ok){
      // Never relay payment provider's raw response or credentials to the client.
      throw Object.assign(new Error("paddle_api_unavailable"),{status:502});
    }
    return await res.json() as {data:T};
  }catch(error){
    if((error as Error).name==="AbortError") throw Object.assign(new Error("paddle_api_timeout"),{status:504});
    throw error;
  }finally{clearTimeout(timeout)}
}

export async function createPaddleCheckout(organizationId:string,planKey:string) {
  if(!publicPaddleConfig().checkoutEnabled) throw Object.assign(new Error("paddle_not_configured"),{status:503});
  const plan=(await getPublicPlans()).find(p=>p.key===planKey);
  if(!plan) throw Object.assign(new Error("billing_plan_not_found"),{status:404});
  if(!plan.priceId) throw Object.assign(new Error("paddle_price_not_configured"),{status:503});
  const current=await db.query<{provider:string|null,status:string}>( "select provider,status from organization_subscriptions where organization_id=$1",[organizationId]);
  if(current.rows[0]?.provider==="paddle"&&["active","trialing"].includes(current.rows[0].status)){
    throw Object.assign(new Error("subscription_already_active_use_portal"),{status:409});
  }
  const transaction=await paddleApi<{id:string}>("/transactions",{
    method:"POST",
    body:{
      items:[{price_id:plan.priceId,quantity:1}],
      collection_mode:"automatic",
      custom_data:{app:"wecommander",organizationId,planKey},
    }
  });
  if(!transactionPattern.test(transaction.data?.id||"")) throw new Error("invalid_paddle_transaction");
  await db.query(
    "insert into paddle_checkout_intents(transaction_id,organization_id,plan_key,price_id) values($1,$2,$3,$4)",
    [transaction.data.id,organizationId,planKey,plan.priceId]
  );
  return {transactionId:transaction.data.id};
}
export async function createPaddlePortal(organizationId:string) {
  const found=await db.query<{customer_id:string;subscription_id:string|null}>(
    "select external_customer_id as customer_id,external_subscription_id as subscription_id from organization_subscriptions where organization_id=$1 and provider='paddle'",
    [organizationId]
  );
  const item=found.rows[0];
  if(!item?.customer_id||!customerPattern.test(item.customer_id))throw Object.assign(new Error("paddle_subscription_not_found"),{status:404});
  const response=await paddleApi<{urls:{general:{overview:string}}}>(
    "/customers/"+item.customer_id+"/portal-sessions",{
      method:"POST",
      body:item.subscription_id&&subscriptionPattern.test(item.subscription_id)?{subscription_ids:[item.subscription_id]}:{},
    });
  const url=response.data?.urls?.general?.overview;
  if(!url||!/^https:\/\/[^/]*\.paddle\.com\//i.test(url))throw new Error("invalid_paddle_portal_url");
  return {url};
}
type PaddleEvent={
  event_id?:string;event_type?:string;occurred_at?:string;
  data?:{
    id?:string;status?:string;transaction_id?:string;customer_id?:string;
    custom_data?:Record<string,unknown>|null;
    current_billing_period?:{ends_at?:string}|null;
    scheduled_change?:{action?:string}|null;
    items?:Array<{price?:{id?:string}}>;
  };
};
export async function consumePaddleWebhook(raw:Buffer,signature:string) {
  if(!checkPaddleSignature(raw,signature,String(process.env.PADDLE_WEBHOOK_SECRET||""))) {
    throw Object.assign(new Error("invalid_paddle_signature"),{status:401});
  }
  let event:PaddleEvent;
  try{event=JSON.parse(raw.toString("utf8")) as PaddleEvent}catch{throw Object.assign(new Error("invalid_paddle_event"),{status:400})}
  if(!event.event_id||!event.occurred_at||!event.event_type||!event.data) {
    throw Object.assign(new Error("invalid_paddle_event"),{status:400});
  }
  if(!event.event_type.startsWith("subscription."))return {ok:true,ignored:true};
  const data=event.data;
  if(!data.id||!subscriptionPattern.test(data.id))throw Object.assign(new Error("invalid_paddle_subscription"),{status:400});
  // Only provision a subscription that follows an app-created transaction, or
  // updates an existing, already verified Paddle subscription. Never trust
  // a client-controlled organizationId/custom_data for entitlement.
  const fromIntent=data.transaction_id&&transactionPattern.test(data.transaction_id)
    ?await db.query<{organization_id:string;plan_key:string;price_id:string}>(
      "select organization_id,plan_key,price_id from paddle_checkout_intents where transaction_id=$1",
      [data.transaction_id])
    :null;
  const fromExisting=await db.query<{organization_id:string;plan_key:string}>(
    "select organization_id,plan_key from organization_subscriptions where provider='paddle' and external_subscription_id=$1",
    [data.id]
  );
  const record=fromIntent?.rows[0]||fromExisting.rows[0];
  if(!record)return {ok:true,ignored:true};
  const price=data.items?.[0]?.price?.id;
  if(!price||!pricePattern.test(price)){
    throw Object.assign(new Error("invalid_paddle_price"),{status:400});
  }
  if(fromIntent?.rows[0]&&price!==fromIntent.rows[0].price_id){
    throw Object.assign(new Error("paddle_price_mismatch"),{status:400});
  }
  // A customer may switch packages using Paddle's customer portal. Apply
  // updated plan limits from the signed subscription price, never from
  // custom_data supplied by a client or a stale original checkout intent.
  const mappedPlans=await db.query<{key:string}>(
    "select key from billing_plans where coalesce(metadata->>'paddlePriceId',metadata->>'paddle_price_id')=$1 order by created_at limit 2",
    [price]
  );
  if(mappedPlans.rows.length!==1){
    throw Object.assign(new Error("paddle_price_unmapped_or_duplicated"),{status:409});
  }
  if(fromIntent?.rows[0] && mappedPlans.rows[0]!.key!==fromIntent.rows[0].plan_key){
    throw Object.assign(new Error("paddle_checkout_plan_mismatch"),{status:400});
  }
  const status=(data.status||"").toLowerCase();
  if(!["active","trialing","past_due","paused","canceled"].includes(status)){
    throw Object.assign(new Error("unrecognized_paddle_subscription_status"),{status:400});
  }
  const mapped=status as "active"|"trialing"|"past_due"|"paused"|"canceled";
  const occurredAt=new Date(event.occurred_at);
  if(!Number.isFinite(occurredAt.getTime()))throw Object.assign(new Error("invalid_paddle_date"),{status:400});
  const result=await applyNormalizedBillingEvent({
    provider:"paddle",eventId:event.event_id,eventType:event.event_type,
    occurredAt:occurredAt.toISOString(),organizationId:record.organization_id,
    subscription:{
      planKey:mappedPlans.rows[0]!.key,status:mapped,
      externalSubscriptionId:data.id,
      externalCustomerId:data.customer_id&&customerPattern.test(data.customer_id)?data.customer_id:null,
      currentPeriodEnd:data.current_billing_period?.ends_at??null,
      cancelAtPeriodEnd:data.scheduled_change?.action==="cancel",
    }
  });
  return {ok:true,applied:result.applied};
}
