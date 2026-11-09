import crypto from "node:crypto";
import { db } from "./db.js";
import { newCenterToken, type Principal } from "./auth.js";
import { randomToken, sha256 } from "./security.js";

// Management Center sign-in. The tray app starts a request and opens
// /connect-center in the browser; the signed-in admin approves it there; the
// tray app, which alone holds the request secret, redeems it once for a
// revocable center token. No password ever reaches the tray app.

const centerLinkTtlMinutes = 10;

export type CenterPlatform = "macos" | "windows" | "linux";

export async function createCenterLink(name: string, platform: CenterPlatform | null = null) {
  const secret = randomToken(32);
  const id = crypto.randomUUID();
  await db.query(
    `insert into center_link_requests(id,secret_hash,name,platform,expires_at)
       values($1,$2,$3,$4,now()+interval '10 minutes')`,
    [id, sha256(secret), name, platform],
  );
  return { requestId: id, requestSecret: secret, expiresInSeconds: centerLinkTtlMinutes * 60 };
}

export async function getCenterLinkStatus(id: string, secret: string) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await client.query<{
      name: string; platform: string | null; approved_at: Date | null; approved_by: string | null;
      consumed_at: Date | null; expires_at: Date; organization_id: string | null;
    }>(
      `select name,platform,approved_at,approved_by,consumed_at,expires_at,organization_id
         from center_link_requests where id=$1 and secret_hash=$2 for update`,
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
    if (!item.approved_at || !item.organization_id || !item.approved_by) {
      await client.query("commit");
      return { status: "pending" as const };
    }
    const token = newCenterToken();
    const center = await client.query<{ id: string }>(
      `insert into management_centers(organization_id,user_id,name,platform,token_hash)
       values($1,$2,$3,$4,$5) returning id`,
      [item.organization_id, item.approved_by, item.name, item.platform, sha256(token)],
    );
    await client.query("update center_link_requests set consumed_at=now() where id=$1", [id]);
    await client.query(
      `insert into audit_logs(organization_id,actor,tool,risk,outcome,detail)
        values($1,$2,'center.connect','high','success',$3)`,
      [item.organization_id, `user:${item.approved_by}`,
       JSON.stringify({ centerId: center.rows[0]!.id, name: item.name })],
    );
    await client.query("commit");
    return { status: "approved" as const, centerId: center.rows[0]!.id, centerToken: token, name: item.name };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Approve from a browser session; the approver must be admin or owner there. */
export async function approveCenterLink(id: string, principal: Principal, organizationId: string) {
  if (principal.authKind !== "session" || !principal.userId) {
    return { status: 403, error: "browser_session_required" };
  }
  const membership = await db.query(
    `select 1 from organization_members m join users u on u.id=m.user_id
     where m.user_id=$1 and m.organization_id=$2
       and m.role in ('admin','owner') and u.disabled_at is null limit 1`,
    [principal.userId, organizationId],
  );
  if (!membership.rowCount) return { status: 403, error: "admin_role_required" };
  const result = await db.query<{ name: string }>(
    `update center_link_requests
        set approved_at=now(),approved_by=$2,organization_id=$3
      where id=$1 and approved_at is null and consumed_at is null and expires_at>now()
      returning name`,
    [id, principal.userId, organizationId],
  );
  if (!result.rowCount) return { status: 409, error: "invalid_or_expired_request" };
  return { status: 200, ok: true, name: result.rows[0]!.name };
}

/** Name shown to the approver, so they can see which computer asks. */
export async function centerLinkName(id: string) {
  const result = await db.query<{ name: string }>(
    "select name from center_link_requests where id=$1 and approved_at is null and expires_at>now()",
    [id],
  );
  return result.rows[0]?.name ?? null;
}

/**
 * What a center token may reach. Everything else answers 403, including /mcp:
 * the tray app manages approvals, it never runs device tools.
 */
export function centerMayAccess(method: string, pathname: string) {
  if (method === "GET" && (pathname === "/api/center/me" || pathname === "/api/devices" ||
      pathname === "/api/approval-requests" || pathname === "/api/trust/autonomy")) return true;
  if (method === "GET" && /^\/api\/approval-requests\/[0-9a-f-]{36}$/i.test(pathname)) return true;
  if (method === "POST" && (pathname === "/api/trust/autonomy" || pathname === "/api/center/disconnect")) return true;
  // A signed-in Center installs the agent on its own computer without a
  // second browser sign-in (one-time code, see /api/center/pairing-code).
  if (method === "POST" && pathname === "/api/center/pairing-code") return true;
  if (method === "POST" && /^\/api\/approval-requests\/[0-9a-f-]{36}\/(approve|deny)$/i.test(pathname)) return true;
  return false;
}
