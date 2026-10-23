import crypto from "node:crypto";
import {db} from "./db.js";

export type PlatformIncident={
  fingerprint:string;
  kind:"mail_delivery_failed"|"relay_unhealthy";
  severity:"warning"|"critical";
  title:string;
  explanation:string;
  count:number;
  acknowledgedAt:string|null;
};
const fingerprint=(type:string,evidence:string)=>type+":"+crypto.createHash("sha256").update(evidence).digest("hex").slice(0,32);

/** Incident fingerprints change when the observed failure set/count changes.
 * Acknowledging a signal is triage only; it cannot repair or silence the underlying subsystem.
 * We never return SMTP details, credentials, URLs, or tenant records.
 */
export async function activePlatformIncidents():Promise<PlatformIncident[]>{
  const [failedMail,unhealthyRelays]=await Promise.all([
    db.query<{n:number;last_failure:string|null}>(`select count(*)::int as n,max(failed_at)::text as last_failure
      from mail_outbox where failed_at is not null`),
    db.query<{id:string}>(`select id from relay_nodes
      where enabled and not drain and last_seen_at<=now()-interval '2 minutes'
      order by id asc limit 500`),
  ]);
  const result:Array<Omit<PlatformIncident,"acknowledgedAt">>=[];
  const mail=failedMail.rows[0];
  if(mail?.n>0)result.push({
    fingerprint:fingerprint("mail_delivery_failed",mail.n+":"+(mail.last_failure||"")),
    kind:"mail_delivery_failed",severity:"warning",
    title:"Mail delivery failures",
    explanation:"Failed messages are in the outbox. Check the sender configuration and SMTP delivery logs.",
    count:mail.n,
  });
  if(unhealthyRelays.rowCount&&unhealthyRelays.rowCount>0){
    const ids=unhealthyRelays.rows.map(r=>r.id);
    result.push({
      fingerprint:fingerprint("relay_unhealthy",ids.join("\n")),
      kind:"relay_unhealthy",severity:"critical",
      title:"Unhealthy relay nodes",
      explanation:"At least one enabled, non-draining relay has not reported a heartbeat within two minutes.",
      count:ids.length,
    });
  }
  if(result.length===0)return [];
  const acknowledgements=await db.query<{fingerprint:string;acknowledged_at:string}>(
    "select fingerprint,acknowledged_at from platform_incident_acknowledgements where fingerprint=any($1::text[])",
    [result.map(r=>r.fingerprint)],
  );
  const acknowledged=new Map(acknowledgements.rows.map(r=>[r.fingerprint,r.acknowledged_at]));
  return result.map(r=>({...r,acknowledgedAt:acknowledged.get(r.fingerprint)||null}));
}
