import crypto from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { consumeApproval } from "./approvals.js";
import { db, defaultOrganizationId, migrate, ready } from "./db.js";
import { handleMcp } from "./mcp.js";
import { actionRisk, type AgentAction } from "./protocol.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { AgentHub } from "./relay.js";
import { isControlAuthorized, issueApproval, randomToken, redact, sha256 } from "./security.js";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8787);
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, "");
const bodyLimit = 2 * 1024 * 1024;
const hub = new AgentHub();
const enrollRateLimit = new FixedWindowRateLimiter();
const pairingRateLimit = new FixedWindowRateLimiter();

await migrate();

function json(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  res.end(body);
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > bodyLimit) throw Object.assign(new Error("body-too-large"), { status: 413 });
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(req: IncomingMessage, res: ServerResponse) {
  if (isControlAuthorized(req.headers.authorization)) return true;
  json(res, 401, { error: "unauthorized" });
  return false;
}

function remoteKey(req: IncomingMessage) {
  return req.socket.remoteAddress || "unknown";
}

async function auditControl(
  deviceId: string | null,
  tool: string,
  risk: string,
  outcome: string,
  detail = "",
) {
  const orgId = await defaultOrganizationId();
  await db.query(
    "insert into audit_logs(organization_id,actor,device_id,tool,risk,outcome,detail) values($1,'control-api',$2,$3,$4,$5,$6)",
    [orgId, deviceId, tool, risk, outcome, detail],
  );
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
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(body);
      return;
    } catch {}
  }
  json(res, 404, { error: "console-not-found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", publicBaseUrl);

    if (req.method === "GET" && url.pathname === "/") return void (await serveConsole(res));
    if (req.method === "GET" && url.pathname === "/health/live") return void json(res, 200, { status: "ok", service: "commender-gateway" });
    if (req.method === "GET" && url.pathname === "/health") {
      const databaseReady = await ready();
      return void json(res, databaseReady ? 200 : 503, {
        status: databaseReady ? "ok" : "error",
        database: databaseReady ? "ok" : "error",
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

        const deviceId = crypto.randomUUID();
        const token = randomToken(32);
        await client.query(
          "insert into devices(id,organization_id,name,hostname,platform,token_hash) values($1,$2,$3,$4,$5,$6)",
          [deviceId, code.organization_id, body.name || body.hostname || "Unnamed device", body.hostname, body.platform, sha256(token)],
        );
        await client.query("update pairing_codes set used_at=now() where id=$1", [code.id]);
        await client.query("commit");

        const wsUrl = publicBaseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/agent";
        return void json(res, 201, { deviceId, deviceToken: token, gatewayWsUrl: wsUrl });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") {
      if (!authorized(req, res)) return;
    }

    if (req.method === "POST" && url.pathname === "/api/pairing") {
      const rate = pairingRateLimit.hit(remoteKey(req), 30, 60_000);
      if (!rate.allowed) {
        res.setHeader("Retry-After", String(rate.retryAfterSeconds));
        return void json(res, 429, { error: "rate_limited" });
      }

      const orgId = await defaultOrganizationId();
      await db.query("delete from pairing_codes where expires_at < now() or used_at is not null");
      const code = randomToken(24);
      await db.query(
        "insert into pairing_codes(organization_id,code_hash,expires_at) values($1,$2,now()+interval '10 minutes')",
        [orgId, sha256(code)],
      );
      return void json(res, 201, { pairingCode: code, expiresInSeconds: 600 });
    }

    if (req.method === "GET" && url.pathname === "/api/devices") {
      const orgId = await defaultOrganizationId();
      const result = await db.query(
        "select id,name,hostname,platform,agent_version,capabilities,last_seen_at,created_at,revoked_at from devices where organization_id=$1 order by created_at desc",
        [orgId],
      );
      return void json(res, 200, { items: result.rows.map((row) => ({ ...row, online: hub.isOnline(row.id) })) });
    }

    const disconnectMatch = url.pathname.match(/^\/api\/devices\/([0-9a-f-]{36})\/disconnect$/i);
    if (req.method === "POST" && disconnectMatch) {
      const deviceId = disconnectMatch[1]!;
      const orgId = await defaultOrganizationId();
      const exists = await db.query(
        "select 1 from devices where id=$1 and organization_id=$2 and revoked_at is null",
        [deviceId, orgId],
      );
      if (!exists.rowCount) return void json(res, 404, { error: "device_not_found" });
      const disconnected = hub.disconnect(deviceId);
      return void json(res, 200, { ok: true, disconnected });
    }

    const deviceMatch = url.pathname.match(/^\/api\/devices\/([0-9a-f-]{36})$/i);
    if (req.method === "PATCH" && deviceMatch) {
      const deviceId = deviceMatch[1]!;
      const body = z.object({ name: z.string().trim().min(1).max(120) }).parse(await readJson(req));
      const orgId = await defaultOrganizationId();
      const updated = await db.query(
        "update devices set name=$3 where id=$1 and organization_id=$2 and revoked_at is null returning id,name",
        [deviceId, orgId, body.name],
      );
      if (!updated.rowCount) return void json(res, 404, { error: "device_not_found" });
      await auditControl(deviceId, "device.rename", "medium", "success", JSON.stringify({ name: body.name }));
      return void json(res, 200, { item: updated.rows[0] });
    }

    const revokeMatch = url.pathname.match(/^\/api\/devices\/([0-9a-f-]{36})\/revoke$/i);
    if (req.method === "POST" && revokeMatch) {
      const deviceId = revokeMatch[1]!;
      const orgId = await defaultOrganizationId();
      const revoked = await db.query(
        "update devices set revoked_at=coalesce(revoked_at,now()) where id=$1 and organization_id=$2 returning id,revoked_at",
        [deviceId, orgId],
      );
      if (!revoked.rowCount) return void json(res, 404, { error: "device_not_found" });
      hub.disconnect(deviceId);
      await auditControl(deviceId, "device.revoke", "high", "success");
      return void json(res, 200, { ok: true, item: revoked.rows[0] });
    }

    if (req.method === "POST" && url.pathname === "/api/approvals") {
      const body = z.object({
        deviceId: z.string().uuid(),
        action: z.string().min(2).max(80),
        ttlSeconds: z.number().int().min(15).max(600).optional(),
      }).parse(await readJson(req));
      const orgId = await defaultOrganizationId();
      const exists = await db.query("select 1 from devices where id=$1 and organization_id=$2 and revoked_at is null", [body.deviceId, orgId]);
      if (!exists.rowCount) return void json(res, 404, { error: "device_not_found" });

      let approvalRisk;
      try {
        approvalRisk = actionRisk(body.action);
      } catch {
        return void json(res, 400, { error: "invalid_action" });
      }
      if (approvalRisk !== "high") {
        return void json(res, 400, { error: "approval_not_required" });
      }

      const { token, claim } = issueApproval(body.deviceId, body.action, body.ttlSeconds);
      await db.query(
        "insert into approvals(organization_id,device_id,action,nonce,expires_at) values($1,$2,$3,$4,to_timestamp($5))",
        [orgId, body.deviceId, body.action, claim.nonce, claim.exp],
      );
      return void json(res, 201, { approvalToken: token, expiresAt: new Date(claim.exp * 1000).toISOString() });
    }

    if (req.method === "POST" && url.pathname === "/api/device/request") {
      const body = z.object({
        deviceId: z.string().uuid(),
        action: z.record(z.string(), z.unknown()),
        approvalToken: z.string().optional(),
      }).parse(await readJson(req));
      const action = body.action as AgentAction;
      if (typeof action.kind !== "string") return void json(res, 400, { error: "invalid_action" });

      const orgId = await defaultOrganizationId();
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

      if (risk === "high" && !(await consumeApproval(body.approvalToken, body.deviceId, action.kind))) {
        return void json(res, 403, { error: "approval_required", action: action.kind });
      }
      try {
        const data = await hub.request(body.deviceId, action, body.approvalToken);
        return void json(res, 200, { ok: true, data });
      } catch (error) {
        return void json(res, 502, { ok: false, error: redact(error instanceof Error ? error.message : error) });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/audit") {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
      const result = await db.query(
        "select id,actor,device_id,tool,risk,outcome,detail,created_at from audit_logs order by created_at desc limit $1",
        [limit],
      );
      return void json(res, 200, { items: result.rows });
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      const payload = await readJson(req);
      if (Array.isArray(payload)) {
        const results = (await Promise.all(payload.map((item) => handleMcp(item, hub)))).filter(Boolean);
        return void json(res, 200, results);
      }
      const result = await handleMcp(payload, hub);
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
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

server.on("upgrade", async (req, socket, head) => {
  try {
    const url = new URL(req.url || "/", publicBaseUrl);
    if (url.pathname !== "/agent") {
      socket.destroy();
      return;
    }

    const deviceId = String(req.headers["x-device-id"] || "");
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!deviceId || !token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const result = await db.query<{ token_hash: string }>(
      "select token_hash from devices where id=$1 and revoked_at is null",
      [deviceId],
    );
    if (!result.rows[0] || result.rows[0].token_hash !== sha256(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      void hub.register(deviceId, ws);
    });
  } catch {
    socket.destroy();
  }
});

server.listen(port, host, () => {
  process.stdout.write(`WebRising Commender gateway listening on ${host}:${port}\n`);
});

async function shutdown() {
  server.close();
  for (const client of wss.clients) client.close(1001, "shutdown");
  await db.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
