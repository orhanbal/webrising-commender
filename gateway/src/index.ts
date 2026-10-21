import crypto from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { SecureVersion } from "node:tls";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { z } from "zod";
import type { PoolClient } from "pg";
import { consumeApproval } from "./approvals.js";
import { authenticateRequest, newApiToken, roleAtLeast, verifyBrowserCsrf, type Principal, type Role } from "./auth.js";
import {
  authCookies,
  browserSessionSeconds,
  clearAuthCookies,
  hashPassword,
  newBrowserSessionMaterial,
  normalizeEmail,
  verifyPassword,
} from "./browser-auth.js";
import {
  allocationDecision,
  applyNormalizedBillingEvent,
  billingSnapshot,
  deploymentMode,
  upsertBillingPlan,
  upsertSubscription,
  type AllocationResource,
} from "./billing.js";
import { db, housekeeping, migrate, ready } from "./db.js";
import { DeviceRouter } from "./device-router.js";
import { enqueueMail, mailConfigured, publicSignupEnabled, startMailWorker } from "./mail.js";
import { handleMcp } from "./mcp.js";
import { actionRisk, parseAgentAction } from "./protocol.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { AgentHub } from "./relay.js";
import {
  assignRelayForDevice,
  currentNodeId,
  currentNodeIsRelay,
  regionalRelayEnabled,
  startRelayHeartbeat,
  verifyRelayRequest,
} from "./relay-cluster.js";
import { deviceApprovalKeyForAgent, issueApproval, randomToken, redact, sha256 } from "./security.js";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8787);
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, "");
const tlsCertFile = String(process.env.TLS_CERT_FILE || "").trim();
const tlsKeyFile = String(process.env.TLS_KEY_FILE || "").trim();
const tlsMinVersionRaw = String(process.env.TLS_MIN_VERSION || "TLSv1.2").trim();
const bodyLimit = 2 * 1024 * 1024;

if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
  throw new Error("TLS_CERT_FILE and TLS_KEY_FILE must be configured together");
}
if (!["TLSv1.2", "TLSv1.3"].includes(tlsMinVersionRaw)) {
  throw new Error("TLS_MIN_VERSION must be TLSv1.2 or TLSv1.3");
}
const nativeTlsEnabled = Boolean(tlsCertFile && tlsKeyFile);
if (nativeTlsEnabled && !publicBaseUrl.startsWith("https://")) {
  throw new Error("PUBLIC_BASE_URL must use https:// when native TLS is enabled");
}

async function nativeTlsOptions() {
  if (!nativeTlsEnabled) return null;
  const [cert, key] = await Promise.all([
    fs.readFile(tlsCertFile),
    fs.readFile(tlsKeyFile),
  ]);
  return {
    cert,
    key,
    minVersion: tlsMinVersionRaw as SecureVersion,
    honorCipherOrder: true,
  };
}

const tlsOptions = await nativeTlsOptions();
const hub = new AgentHub(currentNodeId());
const deviceRouter = new DeviceRouter(hub);
const enrollRateLimit = new FixedWindowRateLimiter();
const agentRouteRateLimit = new FixedWindowRateLimiter();
const pairingRateLimit = new FixedWindowRateLimiter();
const loginIpRateLimit = new FixedWindowRateLimiter();
const loginAccountRateLimit = new FixedWindowRateLimiter();
const invitationPreviewRateLimit = new FixedWindowRateLimiter();
const invitationAcceptIpRateLimit = new FixedWindowRateLimiter();
const invitationAcceptTokenRateLimit = new FixedWindowRateLimiter();
const signupIpRateLimit = new FixedWindowRateLimiter();
const signupEmailRateLimit = new FixedWindowRateLimiter();
const signupVerifyIpRateLimit = new FixedWindowRateLimiter();
const signupVerifyTokenRateLimit = new FixedWindowRateLimiter();
const resetIpRateLimit = new FixedWindowRateLimiter();
const resetEmailRateLimit = new FixedWindowRateLimiter();
const resetConfirmIpRateLimit = new FixedWindowRateLimiter();
const resetTokenRateLimit = new FixedWindowRateLimiter();
const trustProxyHeaders = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY_HEADERS || ""));

await migrate();
await housekeeping();
startMailWorker();

const housekeepingTimer = setInterval(() => {
  void housekeeping().catch((error) => {
    process.stderr.write(`housekeeping failed: ${redact(error instanceof Error ? error.message : error)}\n`);
  });
}, 60 * 60 * 1000);
housekeepingTimer.unref();

function securityHeaders() {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    ...(publicBaseUrl.startsWith("https://")
      ? { "strict-transport-security": "max-age=31536000" }
      : {}),
  };
}

function json(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...securityHeaders(),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > bodyLimit) throw Object.assign(new Error("body-too-large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage) {
  const body = await readBody(req);
  if (body.length === 0) return {};
  return JSON.parse(body.toString("utf8"));
}

async function authenticateDeviceRequest(req: IncomingMessage) {
  const deviceId = String(req.headers["x-device-id"] || "");
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!deviceId || !token) return null;

  const result = await db.query<{
    id: string;
    organization_id: string;
    token_hash: string;
    assigned_relay_id: string | null;
  }>(
    `select id,organization_id,token_hash,assigned_relay_id
       from devices
      where id=$1
        and revoked_at is null
      limit 1`,
    [deviceId],
  );
  const row = result.rows[0];
  if (!row || row.token_hash !== sha256(token)) return null;
  return {
    deviceId: row.id,
    organizationId: row.organization_id,
    assignedRelayId: row.assigned_relay_id,
  };
}

function remoteKey(req: IncomingMessage) {
  if (trustProxyHeaders) {
    const forwarded = req.headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const client = value?.split(",")[0]?.trim();
    if (client) return client;
  }
  return req.socket.remoteAddress || "unknown";
}

async function auditForOrganization(
  principal: Principal,
  organizationId: string,
  deviceId: string | null,
  tool: string,
  risk: string,
  outcome: string,
  detail = "",
) {
  await db.query(
    "insert into audit_logs(organization_id,actor,device_id,tool,risk,outcome,detail) values($1,$2,$3,$4,$5,$6,$7)",
    [organizationId, principal.actor, deviceId, tool, risk, outcome, detail],
  );
}

async function auditControl(
  principal: Principal,
  deviceId: string | null,
  tool: string,
  risk: string,
  outcome: string,
  detail = "",
) {
  await auditForOrganization(
    principal,
    principal.organizationId,
    deviceId,
    tool,
    risk,
    outcome,
    detail,
  );
}

function requireRole(principal: Principal, role: Role, res: ServerResponse) {
  if (roleAtLeast(principal, role)) return true;
  json(res, 403, { error: "forbidden", requiredRole: role });
  return false;
}

async function requireCapacity(
  organizationId: string,
  resource: AllocationResource,
  res: ServerResponse,
  queryable: typeof db | PoolClient = db,
) {
  const decision = await allocationDecision(organizationId, resource, queryable);
  if (decision.allowed) return true;
  json(res, decision.reason === "billing_required" ? 402 : 409, {
    error: decision.reason,
    resource: decision.resource,
    used: decision.used,
    limit: decision.limit,
  });
  return false;
}

async function serveConsole(res: ServerResponse) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../public/index.html"),
    path.resolve(here, "../../public/index.html"),
  ];
  for (const candidate of candidates) {
    try {
      const body = await fs.readFile(candidate);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": body.length,
        ...securityHeaders(),
        "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      });
      res.end(body);
      return;
    } catch {}
  }
  json(res, 404, { error: "console-not-found" });
}

const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url || "/", publicBaseUrl);

    if (req.method === "GET" && url.pathname === "/") return void (await serveConsole(res));
    if (req.method === "GET" && url.pathname === "/health/live") return void json(res, 200, { status: "ok", service: "commender-gateway" });
    if (req.method === "GET" && url.pathname === "/health") {
      const databaseReady = await ready();
      return void json(res, databaseReady ? 200 : 503, {
        status: databaseReady ? "ok" : "error",
        database: databaseReady ? "ok" : "error",
        transport: nativeTlsEnabled ? "https" : "http",
      });
    }

    if (req.method === "GET" && url.pathname === "/api/public/config") {
      return void json(res, 200, {
        deploymentMode,
        signupEnabled:
          deploymentMode === "saas" &&
          publicSignupEnabled() &&
          mailConfigured(),
        passwordResetEnabled: mailConfigured(),
        mailEnabled: mailConfigured(),
        regionalRelayEnabled: regionalRelayEnabled(),
      });
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/internal/relay/request" ||
        url.pathname === "/internal/relay/disconnect")
    ) {
      if (!currentNodeIsRelay() || !currentNodeId()) {
        return void json(res, 404, { error: "relay_endpoint_unavailable" });
      }

      const rawBody = await readBody(req);
      if (!verifyRelayRequest(req.method, url.pathname, req.headers, rawBody)) {
        return void json(res, 401, { error: "invalid_relay_signature" });
      }

      const parsed = rawBody.length
        ? JSON.parse(rawBody.toString("utf8"))
        : {};

      if (url.pathname === "/internal/relay/request") {
        const body = z.object({
          deviceId: z.string().uuid(),
          action: z.unknown(),
          approvalToken: z.string().nullable().optional(),
        }).parse(parsed);
        const action = parseAgentAction(body.action);
        const device = await db.query(
          `select 1
             from devices
            where id=$1
              and connected_relay_id=$2
              and revoked_at is null
            limit 1`,
          [body.deviceId, currentNodeId()],
        );
        if (!device.rowCount || !hub.isOnline(body.deviceId)) {
          return void json(res, 409, { ok: false, error: "device-offline" });
        }

        try {
          const data = await hub.request(
            body.deviceId,
            action,
            body.approvalToken,
          );
          return void json(res, 200, { ok: true, data });
        } catch (error) {
          return void json(res, 502, {
            ok: false,
            error: redact(error instanceof Error ? error.message : error),
          });
        }
      }

      const body = z.object({
        deviceId: z.string().uuid(),
      }).parse(parsed);
      const device = await db.query(
        `select 1
           from devices
          where id=$1
            and connected_relay_id=$2
          limit 1`,
        [body.deviceId, currentNodeId()],
      );
      if (!device.rowCount) {
        return void json(res, 200, { ok: true, disconnected: false });
      }
      return void json(res, 200, {
        ok: true,
        disconnected: hub.disconnect(body.deviceId),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/agent/route") {
      const device = await authenticateDeviceRequest(req);
      if (!device) return void json(res, 401, { error: "unauthorized" });

      const routeRate = agentRouteRateLimit.hit(
        `${remoteKey(req)}:${device.deviceId}`,
        120,
        5 * 60_000,
      );
      if (!routeRate.allowed) {
        res.setHeader("Retry-After", String(routeRate.retryAfterSeconds));
        return void json(res, 429, { error: "rate_limited" });
      }

      if (!regionalRelayEnabled()) {
        return void json(res, 200, {
          deviceId: device.deviceId,
          gatewayWsUrl:
            publicBaseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") +
            "/agent",
          relayId: null,
          region: null,
        });
      }

      const client = await db.connect();
      try {
        await client.query("begin");
        const relay = await assignRelayForDevice(device.deviceId, client);
        if (!relay) {
          await client.query("rollback");
          return void json(res, 503, { error: "relay_unavailable" });
        }
        await client.query("commit");
        return void json(res, 200, {
          deviceId: device.deviceId,
          gatewayWsUrl: relay.publicWsUrl,
          relayId: relay.id,
          region: relay.region,
        });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const body = z.object({
        email: z.string().trim().email().max(320),
        password: z.string().min(12).max(256),
        organizationId: z.string().uuid().optional(),
      }).parse(await readJson(req));
      const email = normalizeEmail(body.email);
      const ip = remoteKey(req);
      const ipRate = loginIpRateLimit.hit(ip, 60, 10 * 60_000);
      const accountRate = loginAccountRateLimit.hit(`${ip}:${sha256(email)}`, 12, 10 * 60_000);
      if (!ipRate.allowed || !accountRate.allowed) {
        res.setHeader(
          "Retry-After",
          String(Math.max(ipRate.retryAfterSeconds, accountRate.retryAfterSeconds)),
        );
        return void json(res, 429, { error: "rate_limited" });
      }

      const account = await db.query<{
        user_id: string;
        email: string;
        password_hash: string;
        organization_id: string;
        role: Role;
      }>(
        `select u.id as user_id,u.email,u.password_hash,m.organization_id,m.role
           from users u
           join organization_members m on m.user_id=u.id
          where lower(u.email)=lower($1)
            and u.disabled_at is null
            and u.email_verified_at is not null
            and ($2::uuid is null or m.organization_id=$2)
          order by case m.role when 'owner' then 40 when 'admin' then 30 when 'operator' then 20 else 10 end desc,
                   m.created_at asc
          limit 1`,
        [email, body.organizationId ?? null],
      );

      const row = account.rows[0];
      if (!row) {
        await hashPassword(body.password);
        return void json(res, 401, { error: "invalid_credentials" });
      }
      if (!(await verifyPassword(body.password, row.password_hash))) {
        return void json(res, 401, { error: "invalid_credentials" });
      }

      const material = newBrowserSessionMaterial();
      const maxAge = browserSessionSeconds();
      const created = await db.query<{ id: string }>(
        `insert into browser_sessions(user_id,organization_id,token_hash,csrf_hash,expires_at)
         values($1,$2,$3,$4,now()+($5::int * interval '1 second'))
         returning id`,
        [row.user_id, row.organization_id, material.sessionHash, material.csrfHash, maxAge],
      );
      await db.query("update users set last_login_at=now() where id=$1", [row.user_id]);
      await db.query(
        "insert into audit_logs(organization_id,actor,device_id,tool,risk,outcome,detail) values($1,$2,null,'auth.login','low','success','browser session created')",
        [row.organization_id, `user:${row.user_id}`],
      );

      res.setHeader(
        "Set-Cookie",
        authCookies(material.sessionToken, material.csrfToken, maxAge, publicBaseUrl.startsWith("https://")),
      );
      return void json(res, 200, {
        userId: row.user_id,
        email: row.email,
        organizationId: row.organization_id,
        role: row.role,
        authKind: "session",
        sessionId: created.rows[0]!.id,
        csrfToken: material.csrfToken,
        expiresInSeconds: maxAge,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/signup") {
      if (deploymentMode !== "saas" || !publicSignupEnabled()) {
        return void json(res, 404, { error: "signup_disabled" });
      }
      if (!mailConfigured()) {
        return void json(res, 503, { error: "mail_not_configured" });
      }

      const body = z.object({
        email: z.string().trim().email().max(320),
        password: z.string().min(12).max(256),
        workspaceName: z.string().trim().min(2).max(120),
      }).parse(await readJson(req));
      const email = normalizeEmail(body.email);
      const ip = remoteKey(req);
      const ipRate = signupIpRateLimit.hit(ip, 30, 60 * 60_000);
      const emailRate = signupEmailRateLimit.hit(sha256(email), 6, 60 * 60_000);
      if (!ipRate.allowed || !emailRate.allowed) {
        res.setHeader(
          "Retry-After",
          String(Math.max(ipRate.retryAfterSeconds, emailRate.retryAfterSeconds)),
        );
        return void json(res, 429, { error: "rate_limited" });
      }

      const passwordHash = await hashPassword(body.password);
      const existing = await db.query(
        "select 1 from users where lower(email)=lower($1) limit 1",
        [email],
      );
      if (existing.rowCount) {
        return void json(res, 202, { ok: true });
      }

      const token = "wrsv_" + randomToken(32);
      const ttlHoursRaw = Number(process.env.SIGNUP_VERIFY_TTL_HOURS ?? 24);
      const ttlHours = Number.isFinite(ttlHoursRaw)
        ? Math.min(168, Math.max(1, Math.floor(ttlHoursRaw)))
        : 24;
      const verifyUrl = `${publicBaseUrl}/#verify=${encodeURIComponent(token)}`;

      const client = await db.connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into pending_signups(
             email,password_hash,workspace_name,token_hash,expires_at,updated_at
           )
           values($1,$2,$3,$4,now()+($5::int*interval '1 hour'),now())
           on conflict ((lower(email)))
           do update set
             password_hash=excluded.password_hash,
             workspace_name=excluded.workspace_name,
             token_hash=excluded.token_hash,
             expires_at=excluded.expires_at,
             consumed_at=null,
             updated_at=now()`,
          [email, passwordHash, body.workspaceName, sha256(token), ttlHours],
        );
        await enqueueMail(
          {
            to: email,
            subject: "Verify your WebRising Commender account",
            text:
              `Verify your WebRising Commender account by opening this link:\n\n${verifyUrl}\n\n` +
              `This link expires in ${ttlHours} hour(s). If you did not request this account, ignore this message.`,
          },
          client,
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }

      return void json(res, 202, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/signup/verify") {
      const body = z.object({
        token: z.string().min(40).max(200),
        password: z.string().min(12).max(256),
      }).parse(await readJson(req));
      const verifyIp = remoteKey(req);
      const ipRate = signupVerifyIpRateLimit.hit(verifyIp, 60, 15 * 60_000);
      const tokenRate = signupVerifyTokenRateLimit.hit(
        `${verifyIp}:${sha256(body.token)}`,
        15,
        15 * 60_000,
      );
      if (!ipRate.allowed || !tokenRate.allowed) {
        res.setHeader(
          "Retry-After",
          String(Math.max(ipRate.retryAfterSeconds, tokenRate.retryAfterSeconds)),
        );
        return void json(res, 429, { error: "rate_limited" });
      }
      if (!body.token.startsWith("wrsv_")) {
        return void json(res, 400, { error: "invalid_or_expired_verification" });
      }

      const material = newBrowserSessionMaterial();
      const maxAge = browserSessionSeconds();
      const client = await db.connect();
      let response:
        | {
            userId: string;
            email: string;
            organizationId: string;
            role: "owner";
            sessionId: string;
          }
        | null = null;
      try {
        await client.query("begin");
        const pending = await client.query<{
          id: string;
          email: string;
          password_hash: string;
          workspace_name: string;
        }>(
          `select id,email,password_hash,workspace_name
             from pending_signups
            where token_hash=$1
              and consumed_at is null
              and expires_at>now()
            for update`,
          [sha256(body.token)],
        );
        const item = pending.rows[0];
        if (!item) {
          await client.query("rollback");
          return void json(res, 400, { error: "invalid_or_expired_verification" });
        }
        if (!(await verifyPassword(body.password, item.password_hash))) {
          await client.query("rollback");
          return void json(res, 401, { error: "invalid_credentials" });
        }

        const exists = await client.query(
          "select 1 from users where lower(email)=lower($1) limit 1",
          [item.email],
        );
        if (exists.rowCount) {
          await client.query("update pending_signups set consumed_at=now() where id=$1", [item.id]);
          await client.query("commit");
          return void json(res, 409, { error: "account_already_exists" });
        }

        const user = await client.query<{ id: string; email: string }>(
          `insert into users(email,password_hash,email_verified_at)
           values($1,$2,now())
           returning id,email`,
          [item.email, item.password_hash],
        );
        const organization = await client.query<{ id: string; name: string }>(
          "insert into organizations(name) values($1) returning id,name",
          [item.workspace_name],
        );
        await client.query(
          "insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",
          [organization.rows[0]!.id, user.rows[0]!.id],
        );
        const session = await client.query<{ id: string }>(
          `insert into browser_sessions(
             user_id,organization_id,token_hash,csrf_hash,expires_at
           )
           values($1,$2,$3,$4,now()+($5::int*interval '1 second'))
           returning id`,
          [
            user.rows[0]!.id,
            organization.rows[0]!.id,
            material.sessionHash,
            material.csrfHash,
            maxAge,
          ],
        );
        await client.query(
          "update pending_signups set consumed_at=now() where id=$1",
          [item.id],
        );
        await client.query(
          `insert into audit_logs(
             organization_id,actor,device_id,tool,risk,outcome,detail
           )
           values($1,$2,null,'auth.signup.verify','low','success',$3)`,
          [
            organization.rows[0]!.id,
            `user:${user.rows[0]!.id}`,
            JSON.stringify({ email: user.rows[0]!.email }),
          ],
        );
        await client.query("commit");
        response = {
          userId: user.rows[0]!.id,
          email: user.rows[0]!.email,
          organizationId: organization.rows[0]!.id,
          role: "owner",
          sessionId: session.rows[0]!.id,
        };
      } catch (error: any) {
        await client.query("rollback");
        if (error?.code === "23505") {
          return void json(res, 409, { error: "account_already_exists" });
        }
        throw error;
      } finally {
        client.release();
      }

      res.setHeader(
        "Set-Cookie",
        authCookies(
          material.sessionToken,
          material.csrfToken,
          maxAge,
          publicBaseUrl.startsWith("https://"),
        ),
      );
      return void json(res, 200, {
        ...response,
        authKind: "session",
        csrfToken: material.csrfToken,
        expiresInSeconds: maxAge,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/password-reset/request") {
      if (!mailConfigured()) {
        return void json(res, 503, { error: "mail_not_configured" });
      }
      const body = z.object({
        email: z.string().trim().email().max(320),
      }).parse(await readJson(req));
      const email = normalizeEmail(body.email);
      const ipRate = resetIpRateLimit.hit(remoteKey(req), 30, 60 * 60_000);
      const emailRate = resetEmailRateLimit.hit(sha256(email), 6, 60 * 60_000);
      if (!ipRate.allowed || !emailRate.allowed) {
        res.setHeader(
          "Retry-After",
          String(Math.max(ipRate.retryAfterSeconds, emailRate.retryAfterSeconds)),
        );
        return void json(res, 429, { error: "rate_limited" });
      }

      const user = await db.query<{ id: string; email: string }>(
        `select id,email
           from users
          where lower(email)=lower($1)
            and disabled_at is null
            and email_verified_at is not null
          limit 1`,
        [email],
      );

      if (user.rows[0]) {
        const token = "wrrp_" + randomToken(32);
        const ttlMinutesRaw = Number(process.env.PASSWORD_RESET_TTL_MINUTES ?? 60);
        const ttlMinutes = Number.isFinite(ttlMinutesRaw)
          ? Math.min(1440, Math.max(10, Math.floor(ttlMinutesRaw)))
          : 60;
        const resetUrl = `${publicBaseUrl}/#reset=${encodeURIComponent(token)}`;

        const client = await db.connect();
        try {
          await client.query("begin");
          await client.query(
            `update auth_tokens
                set consumed_at=coalesce(consumed_at,now())
              where user_id=$1
                and purpose='password_reset'
                and consumed_at is null`,
            [user.rows[0].id],
          );
          await client.query(
            `insert into auth_tokens(user_id,purpose,token_hash,expires_at)
             values($1,'password_reset',$2,now()+($3::int*interval '1 minute'))`,
            [user.rows[0].id, sha256(token), ttlMinutes],
          );
          await enqueueMail(
            {
              to: user.rows[0].email,
              subject: "Reset your WebRising Commender password",
              text:
                `Reset your WebRising Commender password by opening this link:\n\n${resetUrl}\n\n` +
                `This link expires in ${ttlMinutes} minute(s). If you did not request a reset, ignore this message.`,
            },
            client,
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      }

      return void json(res, 202, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/password-reset/confirm") {
      const body = z.object({
        token: z.string().min(40).max(200),
        newPassword: z.string().min(12).max(256),
      }).parse(await readJson(req));
      const resetIp = remoteKey(req);
      const ipRate = resetConfirmIpRateLimit.hit(resetIp, 30, 15 * 60_000);
      const tokenRate = resetTokenRateLimit.hit(
        `${resetIp}:${sha256(body.token)}`,
        12,
        15 * 60_000,
      );
      if (!ipRate.allowed || !tokenRate.allowed) {
        res.setHeader(
          "Retry-After",
          String(Math.max(ipRate.retryAfterSeconds, tokenRate.retryAfterSeconds)),
        );
        return void json(res, 429, { error: "rate_limited" });
      }
      if (!body.token.startsWith("wrrp_")) {
        return void json(res, 400, { error: "invalid_or_expired_reset" });
      }

      const passwordHash = await hashPassword(body.newPassword);
      const client = await db.connect();
      try {
        await client.query("begin");
        const reset = await client.query<{ id: string; user_id: string }>(
          `select id,user_id
             from auth_tokens
            where token_hash=$1
              and purpose='password_reset'
              and consumed_at is null
              and expires_at>now()
            for update`,
          [sha256(body.token)],
        );
        const item = reset.rows[0];
        if (!item) {
          await client.query("rollback");
          return void json(res, 400, { error: "invalid_or_expired_reset" });
        }

        const user = await client.query(
          `select id
             from users
            where id=$1
              and disabled_at is null
              and email_verified_at is not null
            for update`,
          [item.user_id],
        );
        if (!user.rowCount) {
          await client.query("rollback");
          return void json(res, 400, { error: "invalid_or_expired_reset" });
        }

        await client.query("update users set password_hash=$2 where id=$1", [
          item.user_id,
          passwordHash,
        ]);
        await client.query(
          `update auth_tokens
              set consumed_at=coalesce(consumed_at,now())
            where user_id=$1
              and purpose='password_reset'
              and consumed_at is null`,
          [item.user_id],
        );
        await client.query(
          `update browser_sessions
              set revoked_at=coalesce(revoked_at,now())
            where user_id=$1
              and revoked_at is null`,
          [item.user_id],
        );
        await client.query(
          `insert into audit_logs(
             organization_id,actor,device_id,tool,risk,outcome,detail
           )
           select organization_id,$2,null,'auth.password_reset','high','success','password reset completed'
             from organization_members
            where user_id=$1`,
          [item.user_id, `user:${item.user_id}`],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }

      return void json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/invitations/preview") {
      const previewRate = invitationPreviewRateLimit.hit(remoteKey(req), 120, 10 * 60_000);
      if (!previewRate.allowed) {
        res.setHeader("Retry-After", String(previewRate.retryAfterSeconds));
        return void json(res, 429, { error: "rate_limited" });
      }
      const body = z.object({ token: z.string().min(40).max(200) }).parse(await readJson(req));
      const token = body.token;
      if (!token.startsWith("wrci_")) {
        return void json(res, 404, { error: "invalid_or_expired_invitation" });
      }
      const result = await db.query<{
        id: string;
        email: string;
        role: Role;
        organization_id: string;
        organization_name: string;
        expires_at: string;
        existing_user: boolean;
      }>(
        `select i.id,i.email,i.role,i.organization_id,o.name as organization_name,i.expires_at,
                exists(select 1 from users u where lower(u.email)=lower(i.email) and u.disabled_at is null) as existing_user
           from invitations i
           join organizations o on o.id=i.organization_id
          where i.token_hash=$1
            and i.revoked_at is null
            and i.accepted_at is null
            and i.expires_at>now()
          limit 1`,
        [sha256(token)],
      );
      const item = result.rows[0];
      if (!item) return void json(res, 404, { error: "invalid_or_expired_invitation" });
      return void json(res, 200, {
        item: {
          id: item.id,
          email: item.email,
          role: item.role,
          organizationId: item.organization_id,
          organizationName: item.organization_name,
          expiresAt: item.expires_at,
          existingUser: item.existing_user,
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/api/invitations/accept") {
      const body = z.object({
        token: z.string().min(40).max(200),
        password: z.string().min(12).max(256),
      }).parse(await readJson(req));
      const ip = remoteKey(req);
      const ipRate = invitationAcceptIpRateLimit.hit(ip, 60, 15 * 60_000);
      const tokenRate = invitationAcceptTokenRateLimit.hit(
        `${ip}:${sha256(body.token)}`,
        10,
        15 * 60_000,
      );
      if (!ipRate.allowed || !tokenRate.allowed) {
        res.setHeader(
          "Retry-After",
          String(Math.max(ipRate.retryAfterSeconds, tokenRate.retryAfterSeconds)),
        );
        return void json(res, 429, { error: "rate_limited" });
      }

      const client = await db.connect();
      let acceptedUserId = "";
      let acceptedEmail = "";
      let acceptedOrganizationId = "";
      let acceptedRole: Role = "viewer";
      try {
        await client.query("begin");
        const invitation = await client.query<{
          id: string;
          organization_id: string;
          email: string;
          role: Role;
        }>(
          `select id,organization_id,email,role
             from invitations
            where token_hash=$1
              and revoked_at is null
              and accepted_at is null
              and expires_at>now()
            for update`,
          [sha256(body.token)],
        );
        const invite = invitation.rows[0];
        if (!invite) {
          await client.query("rollback");
          return void json(res, 400, { error: "invalid_or_expired_invitation" });
        }

        await client.query("select id from organizations where id=$1 for update", [
          invite.organization_id,
        ]);

        let existing = await client.query<{ id: string; email: string; password_hash: string }>(
          "select id,email,password_hash from users where lower(email)=lower($1) and disabled_at is null for update",
          [invite.email],
        );
        let userId: string;
        let email: string;
        if (!existing.rows[0]) {
          const passwordHash = await hashPassword(body.password);
          const created = await client.query<{ id: string; email: string }>(
            "insert into users(email,password_hash,email_verified_at) values($1,$2,now()) on conflict do nothing returning id,email",
            [normalizeEmail(invite.email), passwordHash],
          );
          if (created.rows[0]) {
            userId = created.rows[0].id;
            email = created.rows[0].email;
          } else {
            existing = await client.query<{ id: string; email: string; password_hash: string }>(
              "select id,email,password_hash from users where lower(email)=lower($1) and disabled_at is null for update",
              [invite.email],
            );
            if (!existing.rows[0] || !(await verifyPassword(body.password, existing.rows[0].password_hash))) {
              await client.query("rollback");
              return void json(res, 401, { error: "invalid_credentials" });
            }
            userId = existing.rows[0].id;
            email = existing.rows[0].email;
          }
        } else {
          if (!(await verifyPassword(body.password, existing.rows[0].password_hash))) {
            await client.query("rollback");
            return void json(res, 401, { error: "invalid_credentials" });
          }
          userId = existing.rows[0].id;
          email = existing.rows[0].email;
        }

        const currentMembership = await client.query<{ role: Role }>(
          "select role from organization_members where organization_id=$1 and user_id=$2",
          [invite.organization_id, userId],
        );
        if (currentMembership.rows[0]) {
          acceptedRole = currentMembership.rows[0].role;
        } else {
          if (!(await requireCapacity(invite.organization_id, "member_accept", res, client))) {
            await client.query("rollback");
            return;
          }
          await client.query(
            "insert into organization_members(organization_id,user_id,role) values($1,$2,$3)",
            [invite.organization_id, userId, invite.role],
          );
          acceptedRole = invite.role;
        }

        await client.query("update invitations set accepted_at=now() where id=$1", [invite.id]);
        await client.query("update users set last_login_at=now() where id=$1", [userId]);
        await client.query("commit");
        acceptedUserId = userId;
        acceptedEmail = email;
        acceptedOrganizationId = invite.organization_id;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }

      const material = newBrowserSessionMaterial();
      const maxAge = browserSessionSeconds();
      const session = await db.query<{ id: string }>(
        `insert into browser_sessions(user_id,organization_id,token_hash,csrf_hash,expires_at)
         values($1,$2,$3,$4,now()+($5::int * interval '1 second'))
         returning id`,
        [
          acceptedUserId,
          acceptedOrganizationId,
          material.sessionHash,
          material.csrfHash,
          maxAge,
        ],
      );
      await db.query(
        "insert into audit_logs(organization_id,actor,device_id,tool,risk,outcome,detail) values($1,$2,null,'invitation.accept','low','success',$3)",
        [
          acceptedOrganizationId,
          `user:${acceptedUserId}`,
          JSON.stringify({ email: acceptedEmail, role: acceptedRole }),
        ],
      );
      res.setHeader(
        "Set-Cookie",
        authCookies(material.sessionToken, material.csrfToken, maxAge, publicBaseUrl.startsWith("https://")),
      );
      return void json(res, 200, {
        ok: true,
        userId: acceptedUserId,
        email: acceptedEmail,
        organizationId: acceptedOrganizationId,
        role: acceptedRole,
        authKind: "session",
        sessionId: session.rows[0]!.id,
        csrfToken: material.csrfToken,
        expiresInSeconds: maxAge,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/agent/enroll") {
      const rate = enrollRateLimit.hit(remoteKey(req), 20, 10 * 60_000);
      if (!rate.allowed) {
        res.setHeader("Retry-After", String(rate.retryAfterSeconds));
        return void json(res, 429, { error: "rate_limited" });
      }

      const body = z.object({
        pairingCode: z.string().min(20).max(200),
        name: z.string().trim().min(1).max(120).nullish(),
        hostname: z.string().max(255).default(""),
        platform: z.string().max(100).default(""),
      }).parse(await readJson(req));

      const client = await db.connect();
      try {
        await client.query("begin");
        const pairing = await client.query<{ id: string; organization_id: string }>(
          "select id,organization_id from pairing_codes where code_hash=$1 and used_at is null and expires_at>now() for update",
          [sha256(body.pairingCode)],
        );
        const code = pairing.rows[0];
        if (!code) {
          await client.query("rollback");
          return void json(res, 400, { error: "invalid_or_expired_pairing_code" });
        }

        await client.query("select id from organizations where id=$1 for update", [
          code.organization_id,
        ]);
        if (!(await requireCapacity(code.organization_id, "device", res, client))) {
          await client.query("rollback");
          return;
        }

        const deviceId = crypto.randomUUID();
        const token = randomToken(32);
        await client.query(
          "insert into devices(id,organization_id,name,hostname,platform,token_hash) values($1,$2,$3,$4,$5,$6)",
          [deviceId, code.organization_id, body.name || body.hostname || "Unnamed device", body.hostname, body.platform, sha256(token)],
        );

        let wsUrl =
          publicBaseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") +
          "/agent";
        let relayId: string | null = null;
        let relayRegion: string | null = null;
        if (regionalRelayEnabled()) {
          const relay = await assignRelayForDevice(deviceId, client);
          if (!relay) {
            await client.query("rollback");
            return void json(res, 503, { error: "relay_unavailable" });
          }
          wsUrl = relay.publicWsUrl;
          relayId = relay.id;
          relayRegion = relay.region;
        }

        await client.query("update pairing_codes set used_at=now() where id=$1", [code.id]);
        await client.query("commit");

        return void json(res, 201, {
          deviceId,
          deviceToken: token,
          approvalKey: deviceApprovalKeyForAgent(deviceId),
          gatewayWsUrl: wsUrl,
          relayId,
          relayRegion,
        });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    let principal: Principal | null = null;
    if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") {
      principal = await authenticateRequest(req.headers.authorization, req.headers.cookie);
      if (!principal) return void json(res, 401, { error: "unauthorized" });

      const method = req.method || "GET";
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        const csrfHeader = Array.isArray(req.headers["x-csrf-token"])
          ? req.headers["x-csrf-token"][0]
          : req.headers["x-csrf-token"];
        if (!verifyBrowserCsrf(principal, csrfHeader)) {
          return void json(res, 403, { error: "csrf_required" });
        }
      }
    }

    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      return void json(res, 200, {
        organizationId: principal!.organizationId,
        actor: principal!.actor,
        role: principal!.role,
        global: principal!.global,
        authKind: principal!.authKind,
        userId: principal!.userId ?? null,
        email: principal!.email ?? null,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      if (principal!.authKind === "session" && principal!.sessionId) {
        await db.query("update browser_sessions set revoked_at=coalesce(revoked_at,now()) where id=$1", [
          principal!.sessionId,
        ]);
        await auditControl(principal!, null, "auth.logout", "low", "success");
      }
      res.setHeader("Set-Cookie", clearAuthCookies(publicBaseUrl.startsWith("https://")));
      return void json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/change-password") {
      if (principal!.authKind !== "session" || !principal!.userId || !principal!.sessionId) {
        return void json(res, 400, { error: "browser_session_required" });
      }
      const body = z.object({
        currentPassword: z.string().min(12).max(256),
        newPassword: z.string().min(12).max(256),
      }).parse(await readJson(req));
      if (body.currentPassword === body.newPassword) {
        return void json(res, 400, { error: "new_password_must_differ" });
      }

      const current = await db.query<{ password_hash: string }>(
        "select password_hash from users where id=$1 and disabled_at is null",
        [principal!.userId],
      );
      if (!current.rows[0] || !(await verifyPassword(body.currentPassword, current.rows[0].password_hash))) {
        return void json(res, 401, { error: "invalid_credentials" });
      }
      const passwordHash = await hashPassword(body.newPassword);
      await db.query("update users set password_hash=$2 where id=$1", [principal!.userId, passwordHash]);
      await db.query(
        "update browser_sessions set revoked_at=coalesce(revoked_at,now()) where user_id=$1 and id<>$2 and revoked_at is null",
        [principal!.userId, principal!.sessionId],
      );
      await db.query(
        "update auth_tokens set consumed_at=coalesce(consumed_at,now()) where user_id=$1 and purpose='password_reset' and consumed_at is null",
        [principal!.userId],
      );
      await auditControl(principal!, null, "auth.change_password", "high", "success");
      return void json(res, 200, { ok: true });
    }

    if (req.method === "DELETE" && url.pathname === "/api/auth/account") {
      if (principal!.authKind !== "session" || !principal!.userId) {
        return void json(res, 400, { error: "browser_session_required" });
      }
      const body = z.object({
        password: z.string().min(12).max(256),
        confirmEmail: z.string().trim().email().max(320),
      }).parse(await readJson(req));

      const preflight = await db.query<{
        password_hash: string;
        email: string;
      }>(
        "select password_hash,email from users where id=$1 and disabled_at is null",
        [principal!.userId],
      );
      const account = preflight.rows[0];
      if (!account || normalizeEmail(body.confirmEmail) !== normalizeEmail(account.email)) {
        return void json(res, 400, { error: "account_confirmation_mismatch" });
      }
      if (!(await verifyPassword(body.password, account.password_hash))) {
        return void json(res, 401, { error: "invalid_credentials" });
      }

      const client = await db.connect();
      try {
        await client.query("begin");
        const lockedUser = await client.query<{
          password_hash: string;
          email: string;
        }>(
          "select password_hash,email from users where id=$1 and disabled_at is null for update",
          [principal!.userId],
        );
        const user = lockedUser.rows[0];
        if (!user || user.password_hash !== account.password_hash) {
          await client.query("rollback");
          return void json(res, 409, { error: "credentials_changed_retry" });
        }

        const memberships = await client.query<{
          organization_id: string;
          role: Role;
          name: string;
        }>(
          `select m.organization_id,m.role,o.name
             from organization_members m
             join organizations o on o.id=m.organization_id
            where m.user_id=$1
            order by m.organization_id
            for update of m`,
          [principal!.userId],
        );

        const ownedIds = memberships.rows
          .filter((row) => row.role === "owner")
          .map((row) => row.organization_id);
        if (ownedIds.length) {
          const lockedOwnedMembers = await client.query<{
            organization_id: string;
            user_id: string;
            role: Role;
          }>(
            `select organization_id,user_id,role
               from organization_members
              where organization_id=any($1::uuid[])
              order by organization_id,user_id
              for update`,
            [ownedIds],
          );
          const blocking = memberships.rows
            .filter((membership) => membership.role === "owner")
            .filter((membership) => {
              const owners = lockedOwnedMembers.rows.filter(
                (row) =>
                  row.organization_id === membership.organization_id &&
                  row.role === "owner",
              );
              return owners.length <= 1;
            })
            .map((membership) => ({
              id: membership.organization_id,
              name: membership.name,
            }));
          if (blocking.length) {
            await client.query("rollback");
            return void json(res, 409, {
              error: "owned_workspace_requires_transfer_or_delete",
              workspaces: blocking,
            });
          }
        }

        await client.query(
          `insert into audit_logs(
             organization_id,actor,device_id,tool,risk,outcome,detail
           )
           select m.organization_id,$2,null,'auth.account_delete','high','success',$3
             from organization_members m
            where m.user_id=$1`,
          [
            principal!.userId,
            principal!.actor,
            JSON.stringify({ userId: principal!.userId }),
          ],
        );
        await client.query(
          "delete from pending_signups where lower(email)=lower($1)",
          [user.email],
        );
        await client.query(
          "delete from invitations where lower(email)=lower($1)",
          [user.email],
        );
        await client.query(
          "delete from mail_outbox where recipient_hash=$1 and sent_at is null",
          [sha256(normalizeEmail(user.email))],
        );
        await client.query("delete from users where id=$1", [principal!.userId]);
        await client.query("commit");
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {}
        throw error;
      } finally {
        client.release();
      }

      res.setHeader(
        "Set-Cookie",
        clearAuthCookies(publicBaseUrl.startsWith("https://")),
      );
      return void json(res, 200, { ok: true, signedOut: true });
    }

    if (req.method === "GET" && url.pathname === "/api/auth/organizations") {
      if (principal!.authKind !== "session" || !principal!.userId) {
        return void json(res, 400, { error: "browser_session_required" });
      }
      const memberships = await db.query(
        `select o.id,o.name,o.relay_region,m.role,m.created_at
           from organization_members m
           join organizations o on o.id=m.organization_id
          where m.user_id=$1
          order by m.created_at asc`,
        [principal!.userId],
      );
      return void json(res, 200, { items: memberships.rows });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/organizations") {
      if (principal!.authKind !== "session" || !principal!.userId || !principal!.sessionId) {
        return void json(res, 400, { error: "browser_session_required" });
      }
      const body = z.object({ name: z.string().trim().min(2).max(120) }).parse(await readJson(req));
      const client = await db.connect();
      try {
        await client.query("begin");
        const created = await client.query<{ id: string; name: string; created_at: string }>(
          "insert into organizations(name) values($1) returning id,name,created_at",
          [body.name],
        );
        await client.query(
          "insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",
          [created.rows[0]!.id, principal!.userId],
        );
        await client.query(
          "update browser_sessions set organization_id=$2 where id=$1",
          [principal!.sessionId, created.rows[0]!.id],
        );
        await client.query("commit");
        await db.query(
          "insert into audit_logs(organization_id,actor,device_id,tool,risk,outcome,detail) values($1,$2,null,'organization.create','high','success',$3)",
          [created.rows[0]!.id, principal!.actor, JSON.stringify({ name: body.name })],
        );
        return void json(res, 201, { item: { ...created.rows[0], role: "owner" } });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    if (req.method === "POST" && url.pathname === "/api/auth/switch-organization") {
      if (principal!.authKind !== "session" || !principal!.userId || !principal!.sessionId) {
        return void json(res, 400, { error: "browser_session_required" });
      }
      const body = z.object({ organizationId: z.string().uuid() }).parse(await readJson(req));
      const membership = await db.query<{ role: Role }>(
        "select role from organization_members where organization_id=$1 and user_id=$2",
        [body.organizationId, principal!.userId],
      );
      if (!membership.rows[0]) return void json(res, 403, { error: "membership_required" });
      await db.query("update browser_sessions set organization_id=$2 where id=$1", [
        principal!.sessionId,
        body.organizationId,
      ]);
      return void json(res, 200, {
        ok: true,
        organizationId: body.organizationId,
        role: membership.rows[0].role,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/organization") {
      if (!requireRole(principal!, "viewer", res)) return;
      const result = await db.query(
        "select id,name,relay_region,created_at from organizations where id=$1",
        [principal!.organizationId],
      );
      if (!result.rows[0]) return void json(res, 404, { error: "organization_not_found" });
      return void json(res, 200, { item: result.rows[0] });
    }

    if (req.method === "PATCH" && url.pathname === "/api/organization") {
      if (!requireRole(principal!, "owner", res)) return;
      const body = z.object({ name: z.string().trim().min(2).max(120) }).parse(await readJson(req));
      const updated = await db.query(
        "update organizations set name=$2 where id=$1 returning id,name,created_at",
        [principal!.organizationId, body.name],
      );
      if (!updated.rows[0]) return void json(res, 404, { error: "organization_not_found" });
      await auditControl(
        principal!,
        null,
        "organization.rename",
        "high",
        "success",
        JSON.stringify({ name: body.name }),
      );
      return void json(res, 200, { item: updated.rows[0] });
    }

    if (req.method === "DELETE" && url.pathname === "/api/organization") {
      if (
        principal!.authKind !== "session" ||
        !principal!.userId ||
        !principal!.sessionId
      ) {
        return void json(res, 400, { error: "browser_session_required" });
      }
      if (!requireRole(principal!, "owner", res)) return;

      const body = z.object({
        password: z.string().min(12).max(256),
        confirmName: z.string().trim().min(1).max(120),
      }).parse(await readJson(req));

      const preflight = await db.query<{
        password_hash: string;
        name: string;
      }>(
        `select u.password_hash,o.name
           from users u
           join organization_members m on m.user_id=u.id
           join organizations o on o.id=m.organization_id
          where u.id=$1
            and o.id=$2
            and m.role='owner'
            and u.disabled_at is null
          limit 1`,
        [principal!.userId, principal!.organizationId],
      );
      const current = preflight.rows[0];
      if (!current || body.confirmName !== current.name) {
        return void json(res, 400, { error: "workspace_confirmation_mismatch" });
      }
      if (!(await verifyPassword(body.password, current.password_hash))) {
        return void json(res, 401, { error: "invalid_credentials" });
      }

      const preflightOrganizationCount = await db.query<{ count: string }>(
        "select count(*)::text as count from organizations",
      );
      if (Number(preflightOrganizationCount.rows[0]?.count || 0) <= 1) {
        return void json(res, 409, { error: "last_organization_required" });
      }

      const devices = await db.query<{ id: string }>(
        "select id from devices where organization_id=$1 and revoked_at is null",
        [principal!.organizationId],
      );
      await Promise.allSettled(
        devices.rows.map((device) => deviceRouter.disconnect(device.id)),
      );

      const client = await db.connect();
      let nextOrganization:
        | { id: string; role: Role }
        | null = null;
      try {
        await client.query("begin");
        await client.query("lock table organizations in share row exclusive mode");

        const lockedOrganization = await client.query<{ name: string }>(
          "select name from organizations where id=$1 for update",
          [principal!.organizationId],
        );
        if (!lockedOrganization.rows[0]) {
          await client.query("rollback");
          return void json(res, 404, { error: "organization_not_found" });
        }
        if (lockedOrganization.rows[0].name !== body.confirmName) {
          await client.query("rollback");
          return void json(res, 409, { error: "workspace_changed_retry" });
        }

        const lockedUser = await client.query<{ password_hash: string }>(
          "select password_hash from users where id=$1 and disabled_at is null for update",
          [principal!.userId],
        );
        if (
          !lockedUser.rows[0] ||
          lockedUser.rows[0].password_hash !== current.password_hash
        ) {
          await client.query("rollback");
          return void json(res, 409, { error: "credentials_changed_retry" });
        }

        const membership = await client.query<{ role: Role }>(
          `select role
             from organization_members
            where organization_id=$1 and user_id=$2
            for update`,
          [principal!.organizationId, principal!.userId],
        );
        if (membership.rows[0]?.role !== "owner") {
          await client.query("rollback");
          return void json(res, 403, { error: "owner_required" });
        }

        const organizationCount = await client.query<{ count: string }>(
          "select count(*)::text as count from organizations",
        );
        if (Number(organizationCount.rows[0]?.count || 0) <= 1) {
          await client.query("rollback");
          return void json(res, 409, { error: "last_organization_required" });
        }

        const next = await client.query<{ id: string; role: Role }>(
          `select o.id,m.role
             from organization_members m
             join organizations o on o.id=m.organization_id
            where m.user_id=$1
              and m.organization_id<>$2
            order by
              case m.role
                when 'owner' then 40
                when 'admin' then 30
                when 'operator' then 20
                else 10
              end desc,
              m.created_at asc
            limit 1`,
          [principal!.userId, principal!.organizationId],
        );
        nextOrganization = next.rows[0] ?? null;
        if (nextOrganization) {
          await client.query(
            "update browser_sessions set organization_id=$2 where id=$1",
            [principal!.sessionId, nextOrganization.id],
          );
        }

        await client.query(
          `insert into audit_logs(
             organization_id,actor,device_id,tool,risk,outcome,detail
           )
           values($1,$2,null,'organization.delete','high','success',$3)`,
          [
            principal!.organizationId,
            principal!.actor,
            JSON.stringify({
              organizationId: principal!.organizationId,
              name: lockedOrganization.rows[0].name,
            }),
          ],
        );
        await client.query("delete from organizations where id=$1", [
          principal!.organizationId,
        ]);
        await client.query("commit");
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {}
        throw error;
      } finally {
        client.release();
      }

      if (!nextOrganization) {
        res.setHeader(
          "Set-Cookie",
          clearAuthCookies(publicBaseUrl.startsWith("https://")),
        );
      }
      return void json(res, 200, {
        ok: true,
        deletedOrganizationId: principal!.organizationId,
        nextOrganizationId: nextOrganization?.id ?? null,
        role: nextOrganization?.role ?? null,
        signedOut: !nextOrganization,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/relay-regions") {
      if (!requireRole(principal!, "viewer", res)) return;
      if (!regionalRelayEnabled()) {
        return void json(res, 200, { enabled: false, items: [] });
      }
      const regions = await db.query<{ region: string; nodes: string }>(
        `select region,count(*)::text as nodes
           from relay_nodes
          where enabled
            and not drain
            and last_seen_at>now()-interval '45 seconds'
          group by region
          order by region asc`,
      );
      return void json(res, 200, {
        enabled: true,
        items: regions.rows.map((row) => ({
          region: row.region,
          nodes: Number(row.nodes),
        })),
      });
    }

    if (req.method === "PATCH" && url.pathname === "/api/organization/relay-region") {
      if (!requireRole(principal!, "owner", res)) return;
      const body = z.object({
        region: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/)
          .nullable(),
      }).parse(await readJson(req));

      const region = body.region?.toLowerCase() ?? null;
      if (region !== null) {
        if (!regionalRelayEnabled()) {
          return void json(res, 409, { error: "regional_relay_disabled" });
        }
        const available = await db.query(
          `select 1
             from relay_nodes
            where region=$1
              and enabled
              and not drain
              and last_seen_at>now()-interval '45 seconds'
            limit 1`,
          [region],
        );
        if (!available.rowCount) {
          return void json(res, 409, { error: "relay_region_unavailable" });
        }
      }

      const updated = await db.query(
        `update organizations
            set relay_region=$2
          where id=$1
          returning id,name,relay_region,created_at`,
        [principal!.organizationId, region],
      );
      if (!updated.rows[0]) return void json(res, 404, { error: "organization_not_found" });

      await auditControl(
        principal!,
        null,
        "organization.relay_region",
        "high",
        "success",
        JSON.stringify({ relayRegion: region }),
      );
      return void json(res, 200, { item: updated.rows[0] });
    }

    if (req.method === "GET" && url.pathname === "/api/organizations") {
      if (!principal!.global) return void json(res, 403, { error: "global_control_required" });
      const result = await db.query("select id,name,created_at from organizations order by created_at asc");
      return void json(res, 200, { items: result.rows });
    }

    if (req.method === "POST" && url.pathname === "/api/organizations") {
      if (!principal!.global) return void json(res, 403, { error: "global_control_required" });
      const body = z.object({ name: z.string().trim().min(2).max(120) }).parse(await readJson(req));
      const created = await db.query(
        "insert into organizations(name) values($1) returning id,name,created_at",
        [body.name],
      );
      return void json(res, 201, { item: created.rows[0] });
    }

    if (req.method === "GET" && url.pathname === "/api/billing") {
      if (!requireRole(principal!, "viewer", res)) return;
      return void json(res, 200, await billingSnapshot(principal!.organizationId));
    }

    if (req.method === "GET" && url.pathname === "/api/admin/relays") {
      if (!principal!.global) return void json(res, 403, { error: "global_control_required" });
      const result = await db.query<{
        id: string;
        region: string;
        public_ws_url: string;
        internal_base_url: string;
        max_devices: number;
        enabled: boolean;
        drain: boolean;
        last_seen_at: string;
        assigned_count: string;
        connected_count: string;
      }>(
        `select r.id,
                r.region,
                r.public_ws_url,
                r.internal_base_url,
                r.max_devices,
                r.enabled,
                r.drain,
                r.last_seen_at,
                count(d.id) filter (
                  where d.assigned_relay_id=r.id and d.revoked_at is null
                )::text as assigned_count,
                count(d.id) filter (
                  where d.connected_relay_id=r.id
                    and d.revoked_at is null
                    and d.relay_last_seen_at>now()-interval '45 seconds'
                )::text as connected_count
           from relay_nodes r
           left join devices d
             on d.assigned_relay_id=r.id or d.connected_relay_id=r.id
          group by r.id
          order by r.region asc,r.id asc`,
      );
      return void json(res, 200, {
        enabled: regionalRelayEnabled(),
        items: result.rows.map((row) => ({
          ...row,
          healthy: row.enabled && new Date(row.last_seen_at).getTime() > Date.now() - 45_000,
          assigned_count: Number(row.assigned_count),
          connected_count: Number(row.connected_count),
        })),
      });
    }

    const relayAdminMatch = url.pathname.match(
      /^\/api\/admin\/relays\/([^/]+)$/,
    );
    if (req.method === "PATCH" && relayAdminMatch) {
      if (!principal!.global) return void json(res, 403, { error: "global_control_required" });
      const relayId = decodeURIComponent(relayAdminMatch[1]!);
      const body = z.object({
        enabled: z.boolean().optional(),
        drain: z.boolean().optional(),
        maxDevices: z.number().int().min(1).max(1_000_000).optional(),
      }).refine(
        (value) =>
          value.enabled !== undefined ||
          value.drain !== undefined ||
          value.maxDevices !== undefined,
        { message: "at_least_one_relay_setting_required" },
      ).parse(await readJson(req));

      const updated = await db.query(
        `update relay_nodes
            set enabled=coalesce($2,enabled),
                drain=coalesce($3,drain),
                max_devices=coalesce($4,max_devices),
                updated_at=now()
          where id=$1
          returning id,region,max_devices,enabled,drain,last_seen_at,updated_at`,
        [relayId, body.enabled ?? null, body.drain ?? null, body.maxDevices ?? null],
      );
      if (!updated.rows[0]) return void json(res, 404, { error: "relay_not_found" });

      await auditControl(
        principal!,
        null,
        "relay.update",
        "high",
        "success",
        JSON.stringify({
          relayId,
          enabled: body.enabled,
          drain: body.drain,
          maxDevices: body.maxDevices,
        }),
      );
      return void json(res, 200, { item: updated.rows[0] });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/mail/outbox") {
      if (!principal!.global) return void json(res, 403, { error: "global_control_required" });
      const requestedLimit = Number(url.searchParams.get("limit") || 100);
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(500, Math.max(1, Math.floor(requestedLimit)))
        : 100;
      const result = await db.query(
        `select id::text,organization_id,kind,attempts,next_attempt_at,sent_at,failed_at,last_error,created_at
           from mail_outbox
          order by created_at desc
          limit $1`,
        [limit],
      );
      const counts = await db.query<{
        pending: string;
        sent: string;
        failed: string;
      }>(
        `select
           count(*) filter (where sent_at is null and failed_at is null)::text as pending,
           count(*) filter (where sent_at is not null)::text as sent,
           count(*) filter (where failed_at is not null)::text as failed
         from mail_outbox`,
      );
      return void json(res, 200, {
        configured: mailConfigured(),
        counts: {
          pending: Number(counts.rows[0]?.pending || 0),
          sent: Number(counts.rows[0]?.sent || 0),
          failed: Number(counts.rows[0]?.failed || 0),
        },
        items: result.rows,
      });
    }

    const mailRetryMatch = url.pathname.match(
      /^\/api\/admin\/mail\/outbox\/(\d+)\/retry$/,
    );
    if (req.method === "POST" && mailRetryMatch) {
      if (!principal!.global) return void json(res, 403, { error: "global_control_required" });
      const updated = await db.query(
        `update mail_outbox
            set failed_at=null,
                attempts=0,
                next_attempt_at=now(),
                locked_at=null,
                locked_by=null,
                last_error=null
          where id=$1::bigint
            and sent_at is null
          returning id::text,attempts,next_attempt_at,failed_at`,
        [mailRetryMatch[1]],
      );
      if (!updated.rows[0]) return void json(res, 404, { error: "mail_outbox_item_not_found" });
      return void json(res, 200, { ok: true, item: updated.rows[0] });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/billing/plans") {
      if (!principal!.global) return void json(res, 403, { error: "global_control_required" });
      const result = await db.query(
        `select key,name,max_devices,max_members,max_api_tokens,metadata,active,created_at,updated_at
           from billing_plans
          order by created_at asc,key asc`,
      );
      return void json(res, 200, { mode: deploymentMode, items: result.rows });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/billing/plans") {
      if (!principal!.global) return void json(res, 403, { error: "global_control_required" });
      const body = z.object({
        key: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
        name: z.string().trim().min(2).max(120),
        maxDevices: z.number().int().min(0).max(1_000_000).nullable().default(null),
        maxMembers: z.number().int().min(0).max(1_000_000).nullable().default(null),
        maxApiTokens: z.number().int().min(0).max(1_000_000).nullable().default(null),
        metadata: z.record(z.string(), z.unknown()).default({}),
        active: z.boolean().default(true),
      }).parse(await readJson(req));
      const item = await upsertBillingPlan(body);
      await auditControl(
        principal!,
        null,
        "billing.plan.upsert",
        "high",
        "success",
        JSON.stringify({
          key: body.key,
          maxDevices: body.maxDevices,
          maxMembers: body.maxMembers,
          maxApiTokens: body.maxApiTokens,
          active: body.active,
        }),
      );
      return void json(res, 200, { item });
    }

    const adminBillingMatch = url.pathname.match(
      /^\/api\/admin\/organizations\/([0-9a-f-]{36})\/billing$/i,
    );
    if (req.method === "GET" && adminBillingMatch) {
      if (!principal!.global) return void json(res, 403, { error: "global_control_required" });
      const organizationId = adminBillingMatch[1]!;
      const exists = await db.query("select 1 from organizations where id=$1", [organizationId]);
      if (!exists.rowCount) return void json(res, 404, { error: "organization_not_found" });
      return void json(res, 200, await billingSnapshot(organizationId));
    }

    const subscriptionMatch = url.pathname.match(
      /^\/api\/admin\/organizations\/([0-9a-f-]{36})\/subscription$/i,
    );
    if (req.method === "PUT" && subscriptionMatch) {
      if (!principal!.global) return void json(res, 403, { error: "global_control_required" });
      const organizationId = subscriptionMatch[1]!;
      const body = z.object({
        planKey: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
        status: z.enum(["trialing", "active", "past_due", "canceled"]),
        currentPeriodEnd: z.string().datetime({ offset: true }).nullable().optional(),
        cancelAtPeriodEnd: z.boolean().default(false),
      }).parse(await readJson(req));

      const client = await db.connect();
      try {
        await client.query("begin");
        const organization = await client.query(
          "select id from organizations where id=$1 for update",
          [organizationId],
        );
        if (!organization.rowCount) {
          await client.query("rollback");
          return void json(res, 404, { error: "organization_not_found" });
        }
        const item = await upsertSubscription(
          {
            organizationId,
            planKey: body.planKey,
            status: body.status,
            provider: null,
            externalCustomerId: null,
            externalSubscriptionId: null,
            currentPeriodEnd: body.currentPeriodEnd ?? null,
            cancelAtPeriodEnd: body.cancelAtPeriodEnd,
            providerEventAt: null,
            providerEventId: null,
          },
          client,
        );
        await client.query("commit");
        await auditForOrganization(
          principal!,
          organizationId,
          null,
          "billing.subscription.upsert",
          "high",
          "success",
          JSON.stringify({ planKey: body.planKey, status: body.status, provider: null }),
        );
        return void json(res, 200, { item });
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {}
        throw error;
      } finally {
        client.release();
      }
    }

    if (req.method === "POST" && url.pathname === "/api/admin/billing/events") {
      if (!principal!.global) return void json(res, 403, { error: "global_control_required" });
      const body = z.object({
        provider: z.string().trim().min(1).max(80).transform((value) => value.toLowerCase()),
        eventId: z.string().trim().min(1).max(255),
        eventType: z.string().trim().min(1).max(120),
        occurredAt: z.string().datetime({ offset: true }),
        organizationId: z.string().uuid(),
        subscription: z.object({
          planKey: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
          status: z.enum(["trialing", "active", "past_due", "canceled"]),
          externalCustomerId: z.string().trim().min(1).max(255).nullable().optional(),
          externalSubscriptionId: z.string().trim().min(1).max(255).nullable().optional(),
          currentPeriodEnd: z.string().datetime({ offset: true }).nullable().optional(),
          cancelAtPeriodEnd: z.boolean().default(false),
        }),
      }).parse(await readJson(req));
      const result = await applyNormalizedBillingEvent({
        provider: body.provider,
        eventId: body.eventId,
        eventType: body.eventType,
        occurredAt: body.occurredAt,
        organizationId: body.organizationId,
        subscription: {
          planKey: body.subscription.planKey,
          status: body.subscription.status,
          externalCustomerId: body.subscription.externalCustomerId ?? null,
          externalSubscriptionId: body.subscription.externalSubscriptionId ?? null,
          currentPeriodEnd: body.subscription.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: body.subscription.cancelAtPeriodEnd,
        },
      });
      if (result.applied) {
        await auditForOrganization(
          principal!,
          body.organizationId,
          null,
          "billing.event.apply",
          "high",
          "success",
          JSON.stringify({
            provider: body.provider,
            eventId: body.eventId,
            eventType: body.eventType,
            occurredAt: body.occurredAt,
            planKey: body.subscription.planKey,
            status: body.subscription.status,
          }),
        );
      } else if (result.stale || result.providerMismatch || result.orderConflict) {
        const reason = result.orderConflict
          ? "order_conflict"
          : result.stale
            ? "stale"
            : "provider_mismatch";
        await auditForOrganization(
          principal!,
          body.organizationId,
          null,
          "billing.event.ignore",
          "high",
          "denied",
          JSON.stringify({
            provider: body.provider,
            eventId: body.eventId,
            eventType: body.eventType,
            occurredAt: body.occurredAt,
            reason,
          }),
        );
      }
      return void json(res, result.orderConflict ? 409 : 200, {
        ...result,
        ...(result.orderConflict ? { error: "billing_event_order_conflict" } : {}),
      });
    }

    if (req.method === "GET" && (url.pathname === "/api/users" || url.pathname === "/api/members")) {
      if (!requireRole(principal!, "admin", res)) return;
      const result = await db.query(
        `select u.id,u.email,u.email_verified_at,u.disabled_at,u.last_login_at,u.created_at,m.role,m.created_at as member_since
           from organization_members m
           join users u on u.id=m.user_id
          where m.organization_id=$1
          order by u.created_at asc`,
        [principal!.organizationId],
      );
      return void json(res, 200, { items: result.rows });
    }

    if (req.method === "POST" && url.pathname === "/api/users") {
      if (!requireRole(principal!, "admin", res)) return;
      const body = z.object({
        email: z.string().trim().email().max(320),
        password: z.string().min(12).max(256),
        role: z.enum(["viewer", "operator", "admin", "owner"]).default("operator"),
        organizationId: z.string().uuid().optional(),
      }).parse(await readJson(req));

      if (!roleAtLeast(principal!, body.role)) {
        return void json(res, 403, { error: "cannot_grant_role", requestedRole: body.role });
      }
      if (
        body.organizationId &&
        !principal!.global &&
        body.organizationId !== principal!.organizationId
      ) {
        return void json(res, 403, { error: "forbidden" });
      }

      const organizationId = body.organizationId ?? principal!.organizationId;
      const org = await db.query("select 1 from organizations where id=$1", [organizationId]);
      if (!org.rowCount) return void json(res, 404, { error: "organization_not_found" });

      const email = normalizeEmail(body.email);
      const passwordHash = await hashPassword(body.password);
      const client = await db.connect();
      try {
        await client.query("begin");
        const lockedOrganization = await client.query(
          "select id from organizations where id=$1 for update",
          [organizationId],
        );
        if (!lockedOrganization.rowCount) {
          await client.query("rollback");
          return void json(res, 404, { error: "organization_not_found" });
        }
        if (!(await requireCapacity(organizationId, "member", res, client))) {
          await client.query("rollback");
          return;
        }
        const created = await client.query<{ id: string; email: string; created_at: string }>(
          "insert into users(email,password_hash,email_verified_at) values($1,$2,now()) returning id,email,created_at",
          [email, passwordHash],
        );
        await client.query(
          "insert into organization_members(organization_id,user_id,role) values($1,$2,$3)",
          [organizationId, created.rows[0]!.id, body.role],
        );
        await client.query("commit");
        await db.query(
          "insert into audit_logs(organization_id,actor,device_id,tool,risk,outcome,detail) values($1,$2,null,'user.create','high','success',$3)",
          [
            organizationId,
            principal!.actor,
            JSON.stringify({ userId: created.rows[0]!.id, email, role: body.role }),
          ],
        );
        return void json(res, 201, {
          item: { ...created.rows[0], role: body.role, organizationId },
        });
      } catch (error: any) {
        await client.query("rollback");
        if (error?.code === "23505") return void json(res, 409, { error: "user_already_exists" });
        throw error;
      } finally {
        client.release();
      }
    }

    if (req.method === "POST" && url.pathname === "/api/members") {
      if (!requireRole(principal!, "admin", res)) return;
      const body = z.object({
        email: z.string().trim().email().max(320),
        role: z.enum(["viewer", "operator", "admin", "owner"]).default("operator"),
        organizationId: z.string().uuid().optional(),
      }).parse(await readJson(req));

      if (!roleAtLeast(principal!, body.role)) {
        return void json(res, 403, { error: "cannot_grant_role", requestedRole: body.role });
      }
      if (
        body.organizationId &&
        !principal!.global &&
        body.organizationId !== principal!.organizationId
      ) {
        return void json(res, 403, { error: "forbidden" });
      }

      const organizationId = body.organizationId ?? principal!.organizationId;
      const email = normalizeEmail(body.email);
      const client = await db.connect();
      try {
        await client.query("begin");
        const organization = await client.query(
          "select id from organizations where id=$1 for update",
          [organizationId],
        );
        if (!organization.rowCount) {
          await client.query("rollback");
          return void json(res, 404, { error: "organization_not_found" });
        }

        const user = await client.query<{ id: string; email: string }>(
          "select id,email from users where lower(email)=lower($1) and disabled_at is null",
          [email],
        );
        if (!user.rows[0]) {
          await client.query("rollback");
          return void json(res, 404, { error: "user_not_found" });
        }

        const currentMembership = await client.query<{ role: Role }>(
          "select role from organization_members where organization_id=$1 and user_id=$2",
          [organizationId, user.rows[0].id],
        );
        if (currentMembership.rows[0]) {
          await client.query("rollback");
          if (!roleAtLeast(principal!, currentMembership.rows[0].role)) {
            return void json(res, 403, {
              error: "cannot_manage_higher_role",
              targetRole: currentMembership.rows[0].role,
            });
          }
          return void json(res, 409, {
            error: "member_already_exists",
            currentRole: currentMembership.rows[0].role,
          });
        }

        if (!(await requireCapacity(organizationId, "member", res, client))) {
          await client.query("rollback");
          return;
        }

        const membership = await client.query(
          `insert into organization_members(organization_id,user_id,role)
           values($1,$2,$3)
           on conflict do nothing
           returning organization_id,user_id,role,created_at`,
          [organizationId, user.rows[0].id, body.role],
        );
        if (!membership.rows[0]) {
          await client.query("rollback");
          return void json(res, 409, { error: "member_already_exists" });
        }

        await client.query("commit");
        await auditForOrganization(
          principal!,
          organizationId,
          null,
          "member.create",
          "high",
          "success",
          JSON.stringify({ userId: user.rows[0].id, email, role: body.role }),
        );
        return void json(res, 200, { item: membership.rows[0] });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    if (req.method === "GET" && url.pathname === "/api/invitations") {
      if (!requireRole(principal!, "admin", res)) return;
      const result = await db.query(
        `select id,email,role,expires_at,accepted_at,revoked_at,created_at,created_by,
                case
                  when accepted_at is not null then 'accepted'
                  when revoked_at is not null then 'revoked'
                  when expires_at<=now() then 'expired'
                  else 'pending'
                end as status
           from invitations
          where organization_id=$1
          order by created_at desc
          limit 200`,
        [principal!.organizationId],
      );
      return void json(res, 200, { items: result.rows });
    }

    if (req.method === "POST" && url.pathname === "/api/invitations") {
      if (!requireRole(principal!, "admin", res)) return;
      const body = z.object({
        email: z.string().trim().email().max(320),
        role: z.enum(["viewer", "operator", "admin", "owner"]).default("operator"),
        ttlHours: z.number().int().min(1).max(168).default(72),
        sendEmail: z.boolean().default(false),
      }).parse(await readJson(req));
      if (!roleAtLeast(principal!, body.role)) {
        return void json(res, 403, { error: "cannot_grant_role", requestedRole: body.role });
      }
      if (body.sendEmail && !mailConfigured()) {
        return void json(res, 503, { error: "mail_not_configured" });
      }

      const organizationId = principal!.organizationId;
      const email = normalizeEmail(body.email);
      const token = "wrci_" + randomToken(32);
      const client = await db.connect();
      try {
        await client.query("begin");
        const organization = await client.query<{ name: string }>(
          "select name from organizations where id=$1 for update",
          [organizationId],
        );
        if (!organization.rows[0]) {
          await client.query("rollback");
          return void json(res, 404, { error: "organization_not_found" });
        }

        const existingMember = await client.query(
          `select 1
             from organization_members m
             join users u on u.id=m.user_id
            where m.organization_id=$1 and lower(u.email)=lower($2)`,
          [organizationId, email],
        );
        if (existingMember.rowCount) {
          await client.query("rollback");
          return void json(res, 409, { error: "already_member" });
        }

        await client.query(
          `update invitations
              set revoked_at=now()
            where organization_id=$1
              and lower(email)=lower($2)
              and accepted_at is null
              and revoked_at is null`,
          [organizationId, email],
        );

        if (!(await requireCapacity(organizationId, "member", res, client))) {
          await client.query("rollback");
          return;
        }

        const created = await client.query(
          `insert into invitations(organization_id,email,role,token_hash,created_by,expires_at)
           values($1,$2,$3,$4,$5,now()+($6::int * interval '1 hour'))
           returning id,email,role,expires_at,created_at`,
          [
            organizationId,
            email,
            body.role,
            sha256(token),
            principal!.actor,
            body.ttlHours,
          ],
        );
        const inviteUrl = `${publicBaseUrl}/#invite=${encodeURIComponent(token)}`;
        if (body.sendEmail) {
          await enqueueMail(
            {
              to: email,
              subject: `Invitation to ${organization.rows[0].name} · WebRising Commender`,
              text:
                `You were invited to ${organization.rows[0].name} as ${body.role}.\n\n` +
                `Open this one-time invitation link:\n\n${inviteUrl}\n\n` +
                `The invitation expires in ${body.ttlHours} hour(s). If you were not expecting this invitation, ignore this message.`,
            },
            client,
            { organizationId, kind: "invitation" },
          );
        }
        await client.query("commit");
        await auditControl(
          principal!,
          null,
          "invitation.create",
          "medium",
          "success",
          JSON.stringify({
            invitationId: created.rows[0]!.id,
            email,
            role: body.role,
            emailQueued: body.sendEmail,
          }),
        );
        return void json(res, 201, {
          item: created.rows[0],
          inviteToken: token,
          inviteUrl: `${publicBaseUrl}/#invite=${encodeURIComponent(token)}`,
          emailQueued: body.sendEmail,
        });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    const invitationRevokeMatch = url.pathname.match(/^\/api\/invitations\/([0-9a-f-]{36})\/revoke$/i);
    if (req.method === "POST" && invitationRevokeMatch) {
      if (!requireRole(principal!, "admin", res)) return;
      const invitationId = invitationRevokeMatch[1]!;
      const target = await db.query<{ role: Role; accepted_at: string | null; revoked_at: string | null }>(
        "select role,accepted_at,revoked_at from invitations where id=$1 and organization_id=$2",
        [invitationId, principal!.organizationId],
      );
      const item = target.rows[0];
      if (!item) return void json(res, 404, { error: "invitation_not_found" });
      if (!roleAtLeast(principal!, item.role)) {
        return void json(res, 403, { error: "cannot_manage_higher_role", targetRole: item.role });
      }
      if (item.accepted_at) return void json(res, 409, { error: "invitation_already_accepted" });
      const revoked = await db.query(
        "update invitations set revoked_at=coalesce(revoked_at,now()) where id=$1 and organization_id=$2 returning id,revoked_at",
        [invitationId, principal!.organizationId],
      );
      await auditControl(
        principal!,
        null,
        "invitation.revoke",
        "medium",
        "success",
        JSON.stringify({ invitationId }),
      );
      return void json(res, 200, { ok: true, item: revoked.rows[0] });
    }

    const memberMatch = url.pathname.match(/^\/api\/members\/([0-9a-f-]{36})$/i);
    if (memberMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      if (!requireRole(principal!, "admin", res)) return;
      const userId = memberMatch[1]!;
      const nextRole = req.method === "PATCH"
        ? z.object({ role: z.enum(["viewer", "operator", "admin", "owner"]) }).parse(await readJson(req)).role
        : null;
      if (nextRole && !roleAtLeast(principal!, nextRole)) {
        return void json(res, 403, { error: "cannot_grant_role", requestedRole: nextRole });
      }

      const client = await db.connect();
      let auditDetail: Record<string, unknown> | null = null;
      try {
        await client.query("begin");
        const lockedMembers = await client.query<{ user_id: string; role: Role; email: string }>(
          `select m.user_id,m.role,u.email
             from organization_members m
             join users u on u.id=m.user_id
            where m.organization_id=$1
            order by m.user_id
            for update of m`,
          [principal!.organizationId],
        );
        const member = lockedMembers.rows.find((row) => row.user_id === userId);
        if (!member) {
          await client.query("rollback");
          return void json(res, 404, { error: "member_not_found" });
        }
        if (!roleAtLeast(principal!, member.role)) {
          await client.query("rollback");
          return void json(res, 403, { error: "cannot_manage_higher_role", targetRole: member.role });
        }

        const ownerCount = lockedMembers.rows.filter((row) => row.role === "owner").length;
        if (
          member.role === "owner" &&
          ownerCount <= 1 &&
          (req.method === "DELETE" || nextRole !== "owner")
        ) {
          await client.query("rollback");
          return void json(res, 409, { error: "last_owner_required" });
        }

        if (req.method === "PATCH") {
          const updated = await client.query(
            `update organization_members
                set role=$3
              where organization_id=$1 and user_id=$2
              returning organization_id,user_id,role,created_at`,
            [principal!.organizationId, userId, nextRole],
          );
          await client.query("commit");
          auditDetail = { userId, email: member.email, from: member.role, to: nextRole };
          await auditControl(
            principal!,
            null,
            "member.role_update",
            "high",
            "success",
            JSON.stringify(auditDetail),
          );
          return void json(res, 200, { item: updated.rows[0] });
        }

        await client.query(
          "delete from organization_members where organization_id=$1 and user_id=$2",
          [principal!.organizationId, userId],
        );
        await client.query(
          "update browser_sessions set revoked_at=coalesce(revoked_at,now()) where organization_id=$1 and user_id=$2 and revoked_at is null",
          [principal!.organizationId, userId],
        );
        await client.query("commit");
        auditDetail = { userId, email: member.email, role: member.role };
        await auditControl(
          principal!,
          null,
          "member.remove",
          "high",
          "success",
          JSON.stringify(auditDetail),
        );
        return void json(res, 200, { ok: true });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    if (req.method === "GET" && url.pathname === "/api/tokens") {
      if (!requireRole(principal!, "admin", res)) return;
      const result = await db.query(
        "select id,name,role,last_used_at,revoked_at,created_at from api_tokens where organization_id=$1 order by created_at desc",
        [principal!.organizationId],
      );
      return void json(res, 200, { items: result.rows });
    }

    if (req.method === "POST" && url.pathname === "/api/tokens") {
      if (!requireRole(principal!, "admin", res)) return;
      const body = z.object({
        name: z.string().trim().min(2).max(120),
        role: z.enum(["viewer","operator","admin","owner"]).default("operator"),
        organizationId: z.string().uuid().optional(),
      }).parse(await readJson(req));

      if (
        body.organizationId &&
        !principal!.global &&
        body.organizationId !== principal!.organizationId
      ) {
        return void json(res, 403, { error: "forbidden" });
      }
      if (!roleAtLeast(principal!, body.role)) {
        return void json(res, 403, {
          error: "cannot_grant_role",
          requestedRole: body.role,
        });
      }

      const organizationId = body.organizationId ?? principal!.organizationId;
      const rawToken = newApiToken();
      const client = await db.connect();
      try {
        await client.query("begin");
        const organization = await client.query(
          "select id from organizations where id=$1 for update",
          [organizationId],
        );
        if (!organization.rowCount) {
          await client.query("rollback");
          return void json(res, 404, { error: "organization_not_found" });
        }
        if (!(await requireCapacity(organizationId, "api_token", res, client))) {
          await client.query("rollback");
          return;
        }

        const created = await client.query(
          "insert into api_tokens(organization_id,name,role,token_hash,created_by) values($1,$2,$3,$4,$5) returning id,name,role,created_at",
          [organizationId, body.name, body.role, sha256(rawToken), principal!.actor],
        );
        await client.query("commit");
        await auditForOrganization(
          principal!,
          organizationId,
          null,
          "token.create",
          "medium",
          "success",
          JSON.stringify({
            tokenId: created.rows[0].id,
            name: body.name,
            role: body.role,
          }),
        );
        return void json(res, 201, { item: created.rows[0], token: rawToken });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    const tokenRevokeMatch = url.pathname.match(/^\/api\/tokens\/([0-9a-f-]{36})\/revoke$/i);
    if (req.method === "POST" && tokenRevokeMatch) {
      if (!requireRole(principal!, "admin", res)) return;
      const tokenId = tokenRevokeMatch[1]!;
      const target = await db.query<{ role: Role }>(
        "select role from api_tokens where id=$1 and organization_id=$2",
        [tokenId, principal!.organizationId],
      );
      const targetToken = target.rows[0];
      if (!targetToken) return void json(res, 404, { error: "token_not_found" });
      if (!roleAtLeast(principal!, targetToken.role)) {
        return void json(res, 403, {
          error: "cannot_manage_higher_role",
          targetRole: targetToken.role,
        });
      }

      const revoked = await db.query(
        "update api_tokens set revoked_at=coalesce(revoked_at,now()) where id=$1 and organization_id=$2 returning id,role,revoked_at",
        [tokenId, principal!.organizationId],
      );
      await auditControl(
        principal!,
        null,
        "token.revoke",
        "high",
        "success",
        JSON.stringify({ tokenId, role: targetToken.role }),
      );
      return void json(res, 200, { ok: true, item: revoked.rows[0] });
    }

    if (req.method === "POST" && url.pathname === "/api/pairing") {
      if (!requireRole(principal!, "operator", res)) return;
      const rate = pairingRateLimit.hit(remoteKey(req), 30, 60_000);
      if (!rate.allowed) {
        res.setHeader("Retry-After", String(rate.retryAfterSeconds));
        return void json(res, 429, { error: "rate_limited" });
      }

      const orgId = principal!.organizationId;
      if (!(await requireCapacity(orgId, "device", res))) return;
      await db.query("delete from pairing_codes where expires_at < now() or used_at is not null");
      const code = randomToken(24);
      await db.query(
        "insert into pairing_codes(organization_id,code_hash,expires_at) values($1,$2,now()+interval '10 minutes')",
        [orgId, sha256(code)],
      );
      return void json(res, 201, { pairingCode: code, expiresInSeconds: 600 });
    }

    if (req.method === "GET" && url.pathname === "/api/devices") {
      if (!requireRole(principal!, "viewer", res)) return;
      const orgId = principal!.organizationId;
      const result = await db.query(
        `select id,name,hostname,platform,agent_version,capabilities,last_seen_at,
                assigned_relay_id,connected_relay_id,relay_last_seen_at,
                created_at,revoked_at
           from devices
          where organization_id=$1
          order by created_at desc`,
        [orgId],
      );
      const online = await deviceRouter.onlineStatuses(result.rows.map((row) => row.id));
      return void json(res, 200, {
        items: result.rows.map((row) => ({
          ...row,
          online: online.has(row.id),
        })),
      });
    }

    const disconnectMatch = url.pathname.match(/^\/api\/devices\/([0-9a-f-]{36})\/disconnect$/i);
    if (req.method === "POST" && disconnectMatch) {
      if (!requireRole(principal!, "operator", res)) return;
      const deviceId = disconnectMatch[1]!;
      const orgId = principal!.organizationId;
      const exists = await db.query(
        "select 1 from devices where id=$1 and organization_id=$2 and revoked_at is null",
        [deviceId, orgId],
      );
      if (!exists.rowCount) return void json(res, 404, { error: "device_not_found" });
      const disconnected = await deviceRouter.disconnect(deviceId);
      return void json(res, 200, { ok: true, disconnected });
    }

    const deviceMatch = url.pathname.match(/^\/api\/devices\/([0-9a-f-]{36})$/i);
    if (req.method === "PATCH" && deviceMatch) {
      if (!requireRole(principal!, "admin", res)) return;
      const deviceId = deviceMatch[1]!;
      const body = z.object({ name: z.string().trim().min(1).max(120) }).parse(await readJson(req));
      const orgId = principal!.organizationId;
      const updated = await db.query(
        "update devices set name=$3 where id=$1 and organization_id=$2 and revoked_at is null returning id,name",
        [deviceId, orgId, body.name],
      );
      if (!updated.rowCount) return void json(res, 404, { error: "device_not_found" });
      await auditControl(principal!, deviceId, "device.rename", "medium", "success", JSON.stringify({ name: body.name }));
      return void json(res, 200, { item: updated.rows[0] });
    }

    const revokeMatch = url.pathname.match(/^\/api\/devices\/([0-9a-f-]{36})\/revoke$/i);
    if (req.method === "POST" && revokeMatch) {
      if (!requireRole(principal!, "admin", res)) return;
      const deviceId = revokeMatch[1]!;
      const orgId = principal!.organizationId;
      const revoked = await db.query(
        "update devices set revoked_at=coalesce(revoked_at,now()) where id=$1 and organization_id=$2 returning id,revoked_at",
        [deviceId, orgId],
      );
      if (!revoked.rowCount) return void json(res, 404, { error: "device_not_found" });
      await deviceRouter.disconnect(deviceId);
      await auditControl(principal!, deviceId, "device.revoke", "high", "success");
      return void json(res, 200, { ok: true, item: revoked.rows[0] });
    }

    if (req.method === "GET" && url.pathname === "/api/approval-requests") {
      if (!requireRole(principal!, "admin", res)) return;
      const parsedStatus = z
        .enum(["pending", "approved", "denied", "consumed", "expired"])
        .safeParse(url.searchParams.get("status") || "pending");
      if (!parsedStatus.success) {
        return void json(res, 400, { error: "invalid_status" });
      }
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
      const result = await db.query(
        `select id,device_id,requested_by,action_kind,action,status,expires_at,
                decided_by,decided_at,consumed_at,created_at
           from approval_requests
          where organization_id=$1 and status=$2
          order by created_at desc
          limit $3`,
        [principal!.organizationId, parsedStatus.data, limit],
      );
      return void json(res, 200, { items: result.rows });
    }

    const approvalDecisionMatch = url.pathname.match(
      /^\/api\/approval-requests\/([0-9a-f-]{36})\/(approve|deny)$/i,
    );
    if (req.method === "POST" && approvalDecisionMatch) {
      if (!requireRole(principal!, "admin", res)) return;
      const requestId = approvalDecisionMatch[1]!;
      const decision = approvalDecisionMatch[2]!.toLowerCase() as "approve" | "deny";
      const nextStatus = decision === "approve" ? "approved" : "denied";

      const updated = await db.query(
        `update approval_requests
            set status=$3,
                decided_by=$4,
                decided_at=now(),
                action=case
                  when $3='denied'
                    then jsonb_build_object('kind',action_kind,'redacted',true)
                  else action
                end
          where id=$1
            and organization_id=$2
            and status='pending'
            and expires_at>now()
          returning id,device_id,requested_by,action_kind,action,status,expires_at,
                    decided_by,decided_at,created_at`,
        [requestId, principal!.organizationId, nextStatus, principal!.actor],
      );

      const item = updated.rows[0];
      if (!item) {
        const exists = await db.query(
          "select status,expires_at from approval_requests where id=$1 and organization_id=$2",
          [requestId, principal!.organizationId],
        );
        if (!exists.rowCount) {
          return void json(res, 404, { error: "approval_request_not_found" });
        }
        return void json(res, 409, {
          error: "approval_request_not_pending",
          item: exists.rows[0],
        });
      }

      await auditControl(
        principal!,
        item.device_id,
        `approval_request.${decision}`,
        "high",
        "success",
        JSON.stringify({
          approvalRequestId: requestId,
          action: item.action_kind,
          requestedBy: item.requested_by,
        }),
      );
      return void json(res, 200, { ok: true, item });
    }

    if (req.method === "POST" && url.pathname === "/api/approvals") {
      if (!requireRole(principal!, "admin", res)) return;
      const body = z.object({
        deviceId: z.string().uuid(),
        action: z.unknown(),
        ttlSeconds: z.number().int().min(15).max(600).optional(),
      }).parse(await readJson(req));
      const approvalAction = parseAgentAction(body.action);
      const orgId = principal!.organizationId;
      const exists = await db.query("select 1 from devices where id=$1 and organization_id=$2 and revoked_at is null", [body.deviceId, orgId]);
      if (!exists.rowCount) return void json(res, 404, { error: "device_not_found" });

      let approvalRisk;
      try {
        approvalRisk = actionRisk(approvalAction.kind);
      } catch {
        return void json(res, 400, { error: "invalid_action" });
      }
      if (approvalRisk !== "high") {
        return void json(res, 400, { error: "approval_not_required" });
      }

      const { token, claim } = issueApproval(body.deviceId, approvalAction, body.ttlSeconds);
      await db.query(
        "insert into approvals(organization_id,device_id,action,nonce,expires_at) values($1,$2,$3,$4,to_timestamp($5))",
        [orgId, body.deviceId, approvalAction.kind, claim.nonce, claim.exp],
      );
      await auditControl(
        principal!,
        body.deviceId,
        "approval.issue",
        "high",
        "success",
        JSON.stringify({ action: approvalAction.kind }),
      );
      return void json(res, 201, { approvalToken: token, expiresAt: new Date(claim.exp * 1000).toISOString() });
    }

    if (req.method === "POST" && url.pathname === "/api/device/request") {
      const body = z.object({
        deviceId: z.string().uuid(),
        action: z.unknown(),
        approvalToken: z.string().optional(),
      }).parse(await readJson(req));
      const action = parseAgentAction(body.action);

      const orgId = principal!.organizationId;
      const exists = await db.query(
        "select 1 from devices where id=$1 and organization_id=$2 and revoked_at is null",
        [body.deviceId, orgId],
      );
      if (!exists.rowCount) return void json(res, 404, { error: "device_not_found" });

      let risk;
      try {
        risk = actionRisk(action.kind);
      } catch {
        return void json(res, 400, { error: "invalid_action" });
      }

      const neededRole = risk === "low" ? "viewer" : "operator";
      if (!requireRole(principal!, neededRole, res)) return;

      if (risk === "high" && !(await consumeApproval(body.approvalToken, body.deviceId, action))) {
        await auditControl(principal!, body.deviceId, `direct.${action.kind}`, risk, "denied", "missing_or_invalid_approval");
        return void json(res, 403, { error: "approval_required", action: action.kind });
      }
      try {
        const data = await deviceRouter.request(body.deviceId, action, body.approvalToken);
        await auditControl(principal!, body.deviceId, `direct.${action.kind}`, risk, "success", redact({ kind: action.kind }));
        return void json(res, 200, { ok: true, data });
      } catch (error) {
        const detail = redact(error instanceof Error ? error.message : error);
        await auditControl(principal!, body.deviceId, `direct.${action.kind}`, risk, "error", detail);
        return void json(res, 502, { ok: false, error: detail });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/audit") {
      if (!requireRole(principal!, "admin", res)) return;
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
      const result = await db.query(
        "select id,actor,device_id,tool,risk,outcome,detail,created_at from audit_logs where organization_id=$1 order by created_at desc limit $2",
        [principal!.organizationId, limit],
      );
      return void json(res, 200, { items: result.rows });
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      const payload = await readJson(req);
      if (Array.isArray(payload)) {
        const results = (await Promise.all(payload.map((item) => handleMcp(item, deviceRouter, principal!)))).filter(Boolean);
        return void json(res, 200, results);
      }
      const result = await handleMcp(payload, deviceRouter, principal!);
      if (result === null) {
        res.writeHead(202);
        res.end();
        return;
      }
      return void json(res, 200, result);
    }

    json(res, 404, { error: "not_found" });
  } catch (error) {
    const status = typeof (error as any)?.status === "number" ? (error as any).status : error instanceof z.ZodError ? 400 : 500;
    json(res, status, { error: status === 500 ? "internal_error" : redact(error instanceof Error ? error.message : error) });
  }
};

const server = tlsOptions
  ? https.createServer(tlsOptions, requestHandler)
  : http.createServer(requestHandler);

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

server.on("upgrade", async (req, socket, head) => {
  try {
    const url = new URL(req.url || "/", publicBaseUrl);
    if (url.pathname !== "/agent") {
      socket.destroy();
      return;
    }

    const device = await authenticateDeviceRequest(req);
    if (!device) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (regionalRelayEnabled()) {
      const relayId = currentNodeId();
      if (!currentNodeIsRelay() || !relayId || device.assignedRelayId !== relayId) {
        socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
        socket.destroy();
        return;
      }

      const relay = await db.query(
        `select 1
           from relay_nodes
          where id=$1
            and enabled
            and not drain
            and last_seen_at>now()-interval '45 seconds'
          limit 1`,
        [relayId],
      );
      if (!relay.rowCount) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      void hub.register(device.deviceId, ws);
    });
  } catch {
    socket.destroy();
  }
});

server.listen(port, host, () => {
  startRelayHeartbeat();
  process.stdout.write(
    `WebRising Commender gateway listening on ${nativeTlsEnabled ? "https" : "http"}://${host}:${port}\n`,
  );
});

async function shutdown() {
  server.close();
  for (const client of wss.clients) client.close(1001, "shutdown");
  await db.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
