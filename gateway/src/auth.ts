import crypto from "node:crypto";
import { sessionTokenFromCookie } from "./browser-auth.js";
import { db, defaultOrganizationId } from "./db.js";
import { isControlAuthorized, randomToken, sha256 } from "./security.js";

export type Role = "viewer" | "operator" | "admin" | "owner";
export type AuthKind = "control" | "token" | "session" | "oauth";

export type Principal = {
  organizationId: string;
  actor: string;
  role: Role;
  global: boolean;
  authKind: AuthKind;
  userId?: string;
  email?: string;
  sessionId?: string;
  csrfHash?: string;
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
      authKind: "control",
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
    authKind: "token",
  };
}

export async function authenticateRequest(
  authorization: string | undefined,
  cookieHeader: string | undefined,
): Promise<Principal | null> {
  if (authorization) {
    return authenticateAuthorization(authorization);
  }

  const sessionToken = sessionTokenFromCookie(cookieHeader);
  if (!sessionToken) return null;

  const result = await db.query<{
    session_id: string;
    csrf_hash: string;
    user_id: string;
    email: string;
    organization_id: string;
    role: Role;
  }>(
    `select s.id as session_id,
            s.csrf_hash,
            u.id as user_id,
            u.email,
            m.organization_id,
            m.role
       from browser_sessions s
       join users u
         on u.id=s.user_id
        and u.disabled_at is null
       join organization_members m
         on m.user_id=u.id
        and m.organization_id=s.organization_id
      where s.token_hash=$1
        and s.revoked_at is null
        and s.expires_at>now()
      limit 1`,
    [sha256(sessionToken)],
  );

  const row = result.rows[0];
  if (!row) return null;

  await db.query("update browser_sessions set last_seen_at=now() where id=$1", [row.session_id]);

  return {
    organizationId: row.organization_id,
    actor: `user:${row.user_id}`,
    role: row.role,
    global: false,
    authKind: "session",
    userId: row.user_id,
    email: row.email,
    sessionId: row.session_id,
    csrfHash: row.csrf_hash,
  };
}

export function verifyBrowserCsrf(principal: Principal, supplied: string | undefined) {
  if (principal.authKind !== "session") return true;
  if (!principal.csrfHash || !supplied) return false;

  const expected = Buffer.from(principal.csrfHash, "hex");
  const actual = Buffer.from(sha256(supplied), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function newApiToken() {
  return "wrc_" + randomToken(36);
}
