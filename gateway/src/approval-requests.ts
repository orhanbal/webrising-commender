import { db } from "./db.js";
import type { AgentAction } from "./protocol.js";

export async function ensureApprovalRequest(
  organizationId: string,
  actor: string,
  deviceId: string,
  action: AgentAction,
) {
  const actionJson = JSON.stringify(action);
  const existing = await db.query<{ id: string; expires_at: Date }>(
    `select id,expires_at
       from approval_requests
      where organization_id=$1
        and device_id=$2
        and requested_by=$3
        and action=$4::jsonb
        and status='pending'
        and expires_at>now()
      order by created_at desc
      limit 1`,
    [organizationId, deviceId, actor, actionJson],
  );

  if (existing.rows[0]) {
    return { ...existing.rows[0], created: false };
  }

  const created = await db.query<{ id: string; expires_at: Date }>(
    `insert into approval_requests(
       organization_id,device_id,requested_by,action_kind,action,status,expires_at
     )
     values($1,$2,$3,$4,$5::jsonb,'pending',now()+interval '10 minutes')
     returning id,expires_at`,
    [organizationId, deviceId, actor, action.kind, actionJson],
  );

  return { ...created.rows[0]!, created: true };
}

export async function consumeApprovedRequest(
  organizationId: string,
  actor: string,
  deviceId: string,
  action: AgentAction,
) {
  const actionJson = JSON.stringify(action);
  const result = await db.query<{ id: string }>(
    `with candidate as (
       select id
         from approval_requests
        where organization_id=$1
          and device_id=$2
          and requested_by=$3
          and action=$4::jsonb
          and status='approved'
          and consumed_at is null
          and expires_at>now()
        order by decided_at desc nulls last, created_at desc
        for update skip locked
        limit 1
     )
     update approval_requests request
        set status='consumed',
            consumed_at=now(),
            action=jsonb_build_object(
              'kind', request.action_kind,
              'redacted', true
            )
       from candidate
      where request.id=candidate.id
        and request.status='approved'
        and request.consumed_at is null
     returning request.id`,
    [organizationId, deviceId, actor, actionJson],
  );

  return result.rows[0]?.id ?? null;
}

/**
 * An approval consumed for a delivery that never reached the device (offline,
 * overloaded, cancelled before sending) is given back: the request is
 * approved again with its original operation, so the AI client's retry runs
 * it without asking the human twice. Only for errors raised before anything
 * was sent; a timeout after sending keeps it consumed (it may have run).
 */
export const UNDELIVERED_ERRORS = new Set([
  "device-offline",
  "gateway-overloaded",
  "device-request-limit",
]);

export async function restoreUndeliveredApproval(
  organizationId: string,
  requestId: string,
  action: AgentAction,
) {
  const result = await db.query(
    `update approval_requests
        set status='approved', consumed_at=null, action=$3::jsonb
      where id=$1 and organization_id=$2 and status='consumed' and expires_at>now()`,
    [requestId, organizationId, JSON.stringify(action)],
  );
  return (result.rowCount ?? 0) > 0;
}
