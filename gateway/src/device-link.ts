import crypto from "node:crypto";
import { db } from "./db.js";
import { randomToken, sha256 } from "./security.js";

export type DeviceLinkPrincipal = {
  userId?: string;
  organizationId: string;
  authKind: string;
  role: string;
};

const deviceLinkTtlMinutes = 10;

export async function createDeviceLink() {
  const secret = randomToken(32);
  const id = crypto.randomUUID();
  await db.query(
    `insert into device_link_requests(id,secret_hash,expires_at)
       values($1,$2,now()+interval '10 minutes')`,
    [id, sha256(secret)],
  );
  return { requestId: id, requestSecret: secret, expiresInSeconds: deviceLinkTtlMinutes * 60 };
}

export async function getDeviceLinkStatus(id: string, secret: string) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await client.query<{
      approved_at: Date | null; consumed_at: Date | null;
      expires_at: Date; organization_id: string | null;
    }>(
      `select approved_at,consumed_at,expires_at,organization_id from device_link_requests
         where id=$1 and secret_hash=$2 for update`,
      [id, sha256(secret)],
    );
    const item = result.rows[0];
    if (!item || item.expires_at.getTime() <= Date.now()) {
      await client.query("rollback");
      return { status: "expired" as const };
    }
    if (item.consumed_at) {
      await client.query("rollback");
      return { status: "consumed" as const };
    }
    if (!item.approved_at || !item.organization_id) {
      await client.query("commit");
      return { status: "pending" as const };
    }
    // A one-time pairing credential is generated only at the moment the
    // original desktop process redeems its approved, secret-bound request.
    const pairingCode = randomToken(24);
    await client.query(
      `insert into pairing_codes(organization_id,code_hash,expires_at)
       values($1,$2,now()+interval '2 minutes')`,
      [item.organization_id, sha256(pairingCode)],
    );
    await client.query("update device_link_requests set consumed_at=now() where id=$1", [id]);
    await client.query("commit");
    return { status: "approved" as const, pairingCode };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function approveDeviceLink(
  id: string,
  principal: DeviceLinkPrincipal,
  organizationId: string,
) {
  if (principal.authKind !== "session" || !principal.userId) {
    return { status: 403, error: "browser_session_required" };
  }
  const membership = await db.query(
    `select 1 from organization_members m join users u on u.id=m.user_id
     where m.user_id=$1 and m.organization_id=$2
       and m.role in ('operator','admin','owner') and u.disabled_at is null limit 1`,
    [principal.userId, organizationId],
  );
  if (!membership.rowCount) return { status: 403, error: "operator_role_required" };
  const result = await db.query(
    `update device_link_requests
        set approved_at=now(),approved_by=$2,organization_id=$3
      where id=$1 and approved_at is null and consumed_at is null and expires_at>now()
      returning id`,
    [id, principal.userId, organizationId],
  );
  if (!result.rowCount) return { status: 409, error: "invalid_or_expired_request" };
  await db.query(
    `insert into audit_logs(organization_id,actor,tool,risk,outcome,detail)
      values($1,$2,'device_link.approve','medium','success',$3)`,
    [organizationId, principal.userId, JSON.stringify({ requestId: id })],
  );
  return { status: 200, ok: true };
}
