import { db } from "./db.js";
import { sha256 } from "./crypto-utils.js";
import type { Principal, Role } from "./auth.js";

export const oauthScope = "mcp:tools";

export async function authenticateOAuthAccessToken(token: string, resource: string): Promise<Principal | null> {
  if (!/^wrco_[A-Za-z0-9_-]{40,}$/.test(token)) return null;
  const result = await db.query<{
    user_id: string;
    organization_id: string;
    role: Role;
    email: string;
  }>(
    "select s.user_id,s.organization_id,m.role,u.email from oauth_sessions s " +
    "join users u on u.id=s.user_id and u.disabled_at is null " +
    "join organization_members m on m.user_id=s.user_id and m.organization_id=s.organization_id " +
    "where s.access_hash=$1 and s.resource=$2 and s.scope=$3 " +
    "and s.access_expires_at>now() and s.revoked_at is null limit 1",
    [sha256(token), resource, oauthScope],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    organizationId: row.organization_id,
    actor: "user:" + row.user_id,
    userId: row.user_id,
    email: row.email,
    role: row.role,
    global: false,
    authKind: "oauth",
  };
}
