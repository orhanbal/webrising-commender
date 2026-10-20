import { db, defaultOrganizationId } from "./db.js";
import { isControlAuthorized, randomToken, sha256 } from "./security.js";

export type Role = "viewer" | "operator" | "admin" | "owner";

export type Principal = {
  organizationId: string;
  actor: string;
  role: Role;
  global: boolean;
};

const roleRank: Record<Role, number> = {
  viewer: 10,
  operator: 20,
  admin: 30,
  owner: 40,
};

export function roleAtLeast(principal: Principal, required: Role) {
  return roleRank[principal.role] >= roleRank[required];
}

export async function authenticateAuthorization(
  authorization: string | undefined,
): Promise<Principal | null> {
  if (isControlAuthorized(authorization)) {
    return {
      organizationId: await defaultOrganizationId(),
      actor: "control-api",
      role: "owner",
      global: true,
    };
  }

  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  if (!token.startsWith("wrc_") || token.length < 40) return null;

  const result = await db.query<{
    id: string;
    organization_id: string;
    name: string;
    role: Role;
  }>(
    `select id,organization_id,name,role
       from api_tokens
      where token_hash=$1
        and revoked_at is null`,
    [sha256(token)],
  );

  const row = result.rows[0];
  if (!row) return null;

  await db.query("update api_tokens set last_used_at=now() where id=$1", [row.id]);

  return {
    organizationId: row.organization_id,
    actor: `token:${row.id}`,
    role: row.role,
    global: false,
  };
}

export function newApiToken() {
  return "wrc_" + randomToken(36);
}
