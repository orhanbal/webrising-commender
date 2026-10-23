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
import { getPublicPlans, publicPaddleConfig, createPaddleCheckout, createPaddlePortal, consumePaddleWebhook } from "./paddle.js";
import { getDownloads } from "./downloads.js";
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
const publicBaseUrlInput = String(
  process.env.PUBLIC_BASE_URL || `http://localhost:${port}`,
).trim();
const parsedPublicBaseUrl = new URL(publicBaseUrlInput);
if (
  !["http:", "https:"].includes(parsedPublicBaseUrl.protocol) ||
  parsedPublicBaseUrl.username ||
  parsedPublicBaseUrl.password ||
  parsedPublicBaseUrl.pathname !== "/" ||
  parsedPublicBaseUrl.search ||
  parsedPublicBaseUrl.hash
) {
  throw new Error("PUBLIC_BASE_URL must be an http(s) origin without credentials, path, query or fragment");
}
const publicBaseUrl = parsedPublicBaseUrl.origin;
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
if (nativeTlsEnabled && parsedPublicBaseUrl.protocol !== "https:") {
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
const checkoutRateLimit = new FixedWindowRateLimiter();
const billingSupportRateLimit = new FixedWindowRateLimiter();
const consoleMutationAccountLimit = new FixedWindowRateLimiter();
const consoleMutationIpLimit = new FixedWindowRateLimiter();
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

function queryLimit(url: URL, fallback = 100, max = 200) {
  const value = Number(url.searchParams.get("limit") || fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
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

async function servePublicHtml(
  res: ServerResponse,
  fileName: "index.html" | "app.html",
  notFoundError: string,
) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, `../public/${fileName}`),
    path.resolve(here, `../../public/${fileName}`),
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
  json(res, 404, { error: notFoundError });
}

const brandSvgNames = new Set([
  "wecommander-white.svg",
  "wecommander-black.svg",
  "wecommander-favicon.svg",
]);

async function serveBrandSvg(res: ServerResponse, fileName: string) {
  if (!brandSvgNames.has(fileName)) {
    return void json(res, 404, { error: "asset_not_found" });
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../public/assets", fileName),
    path.resolve(here, "../../public/assets", fileName),
  ];
  for (const filePath of candidates) {
    try {
      const svg = await fs.readFile(filePath);
      res.writeHead(200, {
        ...securityHeaders(),
        "content-type": "image/svg+xml; charset=utf-8",
        "content-length": svg.length,
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      });
      res.end(svg);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return void json(res, 404, { error: "asset_not_found" });
}


const modernPages = new Set([
  "/", "/features", "/how-it-works", "/login", "/register", "/forgot-password", "/verify",
  "/reset-password", "/pricing", "/checkout", "/install", "/console", "/console/users", "/console/organizations", "/console/devices", "/console/operations", "/console/landing", "/console/billing", "/console/system", "/console/brand", "/dashboard", "/account", "/billing",
  "/devices", "/terminal", "/files", "/tasks", "/mcp", "/usage",
  "/privacy", "/terms",
]);
const modernExtensions: Record<string,string> = {
  ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8",
  ".svg":"image/svg+xml",
  ".png":"image/png", ".webp":"image/webp", ".woff2":"font/woff2",
};
function htmlEscape(value:string) {
  return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
async function serveModernFile(res: ServerResponse, fileName:string, isIndex=false, seo?:{title:string;description:string}) {
  const here=path.dirname(fileURLToPath(import.meta.url));
  for(const root of [path.resolve(here,"../public/modern"),path.resolve(here,"../../public/modern")]){
    const target=path.resolve(root,fileName);
    if(!isIndex && !target.startsWith(root+path.sep)) continue;
    const type=isIndex?"text/html; charset=utf-8":modernExtensions[path.extname(target)];
    if(!type)break;
    try{
      let body=await fs.readFile(target);
      if(isIndex && seo && (seo.title || seo.description)) {
        let html=body.toString("utf8");
        if(seo.title)html=html.replace(/<title>[^<]*<\/title>/i,"<title>"+htmlEscape(seo.title)+"</title>");
        if(seo.description)html=html.replace(/<meta name="description" content="[^"]*"\s*\/?\s*>/i,
          '<meta name="description" content="'+htmlEscape(seo.description)+'">');
        const canonical=htmlEscape(publicBaseUrl.replace(/\/$/,"")+"/");
        const safeTitle=htmlEscape(seo.title||"WECOMMANDER");
        const safeDescription=htmlEscape(seo.description||"Remote MCP and AI workspace");
        html=html.replace("</head>",'<link rel="canonical" href="'+canonical+'">'+
          '<meta property="og:type" content="website">'+
          '<meta property="og:title" content="'+safeTitle+'">'+
          '<meta property="og:description" content="'+safeDescription+'">'+
          '<meta property="og:url" content="'+canonical+'"></head>');
        body=Buffer.from(html);
      }
      res.writeHead(200,{
        ...securityHeaders(),
        "content-type":type,
        "content-length":body.length,
        "cache-control":isIndex?"no-store":"public, max-age=3600",
        "content-security-policy":
          "default-src 'self'; script-src 'self' https://cdn.paddle.com; "+
          "style-src 'self' 'unsafe-inline' https://cdn.paddle.com; "+
          "img-src 'self' data: https:; font-src 'self' data:; "+
          "connect-src 'self' https://*.paddle.com wss:; "+
          "frame-src https://*.paddle.com; "+
          "base-uri 'self'; form-action 'self' https://*.paddle.com; frame-ancestors 'none'",
      });
      res.end(body);
      return true;
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error}
  }
  return false;
}
async function serveLanding(res: ServerResponse) {
  return servePublicHtml(res, "index.html", "landing-not-found");
}

async function serveConsole(res: ServerResponse) {
  return servePublicHtml(res, "app.html", "console-not-found");
}

const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url || "/", publicBaseUrl);

    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      const name = url.pathname.slice("/assets/".length);
      if (brandSvgNames.has(name)) return void (await serveBrandSvg(res, name));
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(302, { location: "/api/public/brand/favicon", ...securityHeaders() });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/modern/assets/")) {
      if (await serveModernFile(res,url.pathname.slice("/modern/".length))) return;
      return void json(res,404,{error:"asset_not_found"});
    }
    if (req.method === "GET" && modernPages.has(url.pathname)) {
      let seo:{title:string;description:string}|undefined;
      if(url.pathname==="/") {
        seo={
          title:"WECOMMANDER · AI Remote Workspace",
          description:"WECOMMANDER — securely connect devices and manage files, terminals and workflows with your AI tools.",
        };
        try{
          const result=await db.query<{seo_title:string;seo_description:string}>(
            "select seo_title,seo_description from site_content_revisions where locale='en' and state='published' limit 1");
          if(result.rows[0])seo={
            title:result.rows[0].seo_title||seo.title,
            description:result.rows[0].seo_description||seo.description,
          };
        }catch { /* Public landing retains safe default metadata if the CMS is unavailable. */ }
      }
      if (await serveModernFile(res,"index.html",true,seo)) return;
      if (url.pathname === "/") return void (await serveLanding(res));
      return void json(res,503,{error:"modern_frontend_not_built"});
    }
    if (req.method === "GET" && url.pathname === "/legacy") return void (await serveLanding(res));
    if (req.method === "GET" && (url.pathname === "/app" || url.pathname === "/app/")) {
      if (await serveModernFile(res,"index.html",true)) return;
      return void (await serveConsole(res));
    }
    if (req.method === "GET" && (url.pathname === "/advanced" || url.pathname === "/advanced/")) {
      return void (await serveConsole(res));
    }
    if (req.method === "GET" && url.pathname === "/health/live") return void json(res, 200, { status: "ok", service: "commender-gateway" });
    if (req.method === "GET" && url.pathname === "/health") {
      const databaseReady = await ready();
      return void json(res, databaseReady ? 200 : 503, {
        status: databaseReady ? "ok" : "error",
        database: databaseReady ? "ok" : "error",
        transport: nativeTlsEnabled ? "https" : "http",
      });
    }

    if (req.method === "GET" && url.pathname === "/api/public/downloads") {
      return void json(res,200,await getDownloads());
    }
    if (req.method === "GET" && url.pathname === "/api/public/plans") {
      return void json(res,200,{mode:deploymentMode,plans:await getPublicPlans(),paddle:publicPaddleConfig()});
    }
    if (req.method === "POST" && url.pathname === "/webhooks/paddle") {
      const raw=await readBody(req);
      const signature=Array.isArray(req.headers["paddle-signature"])?
        String(req.headers["paddle-signature"][0]||""):String(req.headers["paddle-signature"]||"");
      return void json(res,200,await consumePaddleWebhook(raw,signature));
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/public/brand/")) {
      const kind=url.pathname.slice("/api/public/brand/".length);
      const fallbacks:Record<string,string>={logo_light:"wecommander-white.svg",logo_dark:"wecommander-black.svg",favicon:"wecommander-favicon.svg"};
      if(!Object.hasOwn(fallbacks,kind))return void json(res,404,{error:"not_found"});
      const asset=await db.query<{content_type:string;content:Buffer}>(
        "select content_type,content from platform_brand_assets where kind=$1",[kind]);
      if(!asset.rows[0]){res.writeHead(302,{location:"/assets/"+fallbacks[kind],...securityHeaders(),"cache-control":"no-store"});res.end();return;}
      res.writeHead(200,{...securityHeaders(),"content-type":asset.rows[0].content_type,"content-length":asset.rows[0].content.length,"cache-control":"no-store","x-content-type-options":"nosniff"});
      res.end(asset.rows[0].content);return;
    }
    if (req.method === "GET" && url.pathname === "/api/public/legal") {
      const page=z.enum(["privacy","terms"]).parse(url.searchParams.get("page"));
      const locale=url.searchParams.get("locale")==="tr"?"tr":"en";
      const result=await db.query(
        "select id,page,locale,title,body from legal_page_revisions where page=$1 and locale=$2 and state='published' limit 1",
        [page,locale],
      );
      return void json(res,200,{item:result.rows[0]||null});
    }
    if (req.method === "GET" && url.pathname === "/api/public/site-content") {
      const locale = url.searchParams.get("locale")==="tr"?"tr":"en";
      const published = await db.query(
        "select id,hero_title,hero_subtitle,overrides,seo_title,seo_description from site_content_revisions where locale=$1 and state='published' limit 1",
        [locale],
      );
      return void json(res,200,{item:published.rows[0]||null});
    }
    if (req.method === "GET" && url.pathname === "/api/public/config") {
      return void json(res, 200, {
        deploymentMode,
        signupEnabled:
          deploymentMode === "saas" &&
          publicSignupEnabled() &&
          mailConfigured(),
        passwordResetEnabled: mailConfigured(),
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
      const verifyUrl = `${publicBaseUrl}/verify#verify=${encodeURIComponent(token)}`;

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
            subject: "Verify your WECOMMANDER account",
            text:
              `Verify your WECOMMANDER account by opening this link:\n\n${verifyUrl}\n\n` +
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
        const resetUrl = `${publicBaseUrl}/reset-password#reset=${encodeURIComponent(token)}`;

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
              subject: "Reset your WECOMMANDER password",
              text:
                `Reset your WECOMMANDER password by opening this link:\n\n${resetUrl}\n\n` +
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

    if (url.pathname.startsWith("/api/console/")) {
      if (!principal || principal.authKind !== "session" || !principal.userId) {
        return void json(res, 403, { error: "platform_admin_session_required" });
      }
      const access = await db.query(
        `select 1 from platform_administrators p
           join users u on u.id=p.user_id
          where p.user_id=$1 and p.revoked_at is null and u.disabled_at is null
          limit 1`, [principal.userId],
      );
      if (!access.rowCount) return void json(res, 403, { error: "platform_admin_required" });
      if (req.method !== "GET" && req.method !== "HEAD") {
        const accountGuard=consoleMutationAccountLimit.hit(principal.userId,30,10*60_000);
        const ipGuard=consoleMutationIpLimit.hit(remoteKey(req),120,10*60_000);
        if(!accountGuard.allowed||!ipGuard.allowed){
          res.setHeader("Retry-After",String(Math.max(accountGuard.retryAfterSeconds,ipGuard.retryAfterSeconds)));
          return void json(res,429,{error:"rate_limited"});
        }
      }
      if (req.method === "GET" && url.pathname === "/api/console/me") {
        return void json(res, 200, {
          email: principal.email,
          platformRole: "super_admin",
          userId: principal.userId,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/console/overview") {
        const metrics = await db.query<{
          users: string; organizations: string; devices: string; active_devices: string;
        }>(`select
          (select count(*) from users)::text as users,
          (select count(*) from organizations)::text as organizations,
          (select count(*) from devices where revoked_at is null)::text as devices,
          (select count(*) from devices where revoked_at is null and last_seen_at > now() - interval '2 minutes')::text as active_devices`);
        return void json(res, 200, {
          users: Number(metrics.rows[0]?.users || 0),
          organizations: Number(metrics.rows[0]?.organizations || 0),
          devices: Number(metrics.rows[0]?.devices || 0),
          activeDevices: Number(metrics.rows[0]?.active_devices || 0),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/console/users/set-disabled") {
        const payload=z.object({userId:z.string().uuid(),disabled:z.boolean(),currentPassword:z.string().min(12).max(256)}).parse(await readJson(req));
        if (payload.userId===principal.userId) return void json(res,403,{error:"cannot_modify_own_admin_account"});
        const owner=await db.query<{password_hash:string}>("select password_hash from users where id=$1 and disabled_at is null",[principal.userId]);
        if(!owner.rows[0]||!(await verifyPassword(payload.currentPassword,owner.rows[0].password_hash)))
          return void json(res,403,{error:"reauthentication_failed"});
        const client=await db.connect();
        try {
          await client.query("begin");
          const user=await client.query("select id from users where id=$1 for update",[payload.userId]);
          if(!user.rowCount){await client.query("rollback");return void json(res,404,{error:"user_not_found"});}
          const platform=await client.query("select 1 from platform_administrators where user_id=$1 and revoked_at is null",[payload.userId]);
          if(platform.rowCount){await client.query("rollback");return void json(res,403,{error:"cannot_modify_platform_admin"});}
          await client.query("update users set disabled_at=$2 where id=$1",[payload.userId,payload.disabled?new Date():null]);
          if(payload.disabled)await client.query("update browser_sessions set revoked_at=coalesce(revoked_at,now()) where user_id=$1 and revoked_at is null",[payload.userId]);
          await client.query("insert into platform_admin_audit(actor_user_id,action,detail) values($1,$2,$3)",
             [principal.userId,payload.disabled?"user.disable":"user.enable","user:"+payload.userId]);
          await client.query("commit");
        }catch(error){await client.query("rollback");throw error}finally{client.release()}
        return void json(res,200,{ok:true});
      }
      if (req.method === "GET" && url.pathname === "/api/console/users/sessions") {
        const userId=z.string().uuid().parse(url.searchParams.get("userId"));
        const sessions=await db.query(
          `select s.id,s.organization_id,o.name as organization_name,s.created_at,s.last_seen_at,s.expires_at,s.revoked_at
            from browser_sessions s join organizations o on o.id=s.organization_id
            where s.user_id=$1 order by s.created_at desc limit 100`,[userId]);
        return void json(res,200,{items:sessions.rows});
      }
      if (req.method === "POST" && url.pathname === "/api/console/users/sessions/revoke") {
        const payload=z.object({sessionId:z.string().uuid(),currentPassword:z.string().min(12).max(256)}).parse(await readJson(req));
        const operator=await db.query<{password_hash:string}>(
          "select password_hash from users where id=$1 and disabled_at is null",[principal.userId]);
        if(!operator.rows[0]||!(await verifyPassword(payload.currentPassword,operator.rows[0].password_hash)))
          return void json(res,403,{error:"reauthentication_failed"});
        const client=await db.connect();
        try{
          await client.query("begin");
          const session=await client.query<{user_id:string}>(
            "select user_id from browser_sessions where id=$1 for update",[payload.sessionId]);
          if(!session.rows[0]){await client.query("rollback");return void json(res,404,{error:"session_not_found"});}
          if(session.rows[0].user_id===principal.userId){await client.query("rollback");return void json(res,403,{error:"cannot_revoke_own_session_here"});}
          const platform=await client.query(
            "select 1 from platform_administrators where user_id=$1 and revoked_at is null",[session.rows[0].user_id]);
          if(platform.rowCount){await client.query("rollback");return void json(res,403,{error:"platform_admin_protected"});}
          await client.query(
            "update browser_sessions set revoked_at=coalesce(revoked_at,now()) where id=$1",[payload.sessionId]);
          await client.query(
            "insert into platform_admin_audit(actor_user_id,action,detail) values($1,'session.revoke',$2)",
            [principal.userId,"session:"+payload.sessionId],
          );
          await client.query("commit");
        }catch(error){await client.query("rollback");throw error}finally{client.release()}
        return void json(res,200,{ok:true});
      }
      if (req.method === "GET" && url.pathname === "/api/console/users") {
        const limit = Math.min(100,Math.max(1,Number(url.searchParams.get("limit")||25)||25));
        const offset = Math.min(100000,Math.max(0,Number(url.searchParams.get("offset")||0)||0));
        const search = (url.searchParams.get("q")||"").trim().slice(0,160);
        const records = await db.query(
          `select u.id,u.email,u.created_at,u.last_login_at,
              (u.disabled_at is not null) as disabled,
              (u.email_verified_at is not null) as verified,
              count(m.organization_id)::int as workspace_count
           from users u left join organization_members m on m.user_id=u.id
           where ($1::text='' or u.email ilike '%'||$1||'%')
           group by u.id order by u.created_at desc limit $2 offset $3`,
          [search,limit,offset],
        );
        return void json(res,200,{items:records.rows,limit,offset});
      }
      if (req.method === "POST" && url.pathname === "/api/console/organizations/quotas") {
        const limit=z.number().int().min(0).max(1000000).nullable().optional();
        const payload=z.object({organizationId:z.string().uuid(),maxDevices:limit,maxMembers:limit,maxApiTokens:limit,currentPassword:z.string().min(12).max(256)}).parse(await readJson(req));
        const adminPassword=await db.query<{password_hash:string}>("select password_hash from users where id=$1 and disabled_at is null",[principal.userId]);
        if(!adminPassword.rows[0]||!(await verifyPassword(payload.currentPassword,adminPassword.rows[0].password_hash)))return void json(res,403,{error:"reauthentication_failed"});
        const limits:Record<string,number|null>={};
        for(const key of ["maxDevices","maxMembers","maxApiTokens"] as const)if(Object.hasOwn(payload,key)&&payload[key]!==undefined)limits[key]=payload[key]!;
        const client=await db.connect();
        try{
          await client.query("begin");
          const org=await client.query("select 1 from organizations where id=$1 for update",[payload.organizationId]);
          if(!org.rowCount){await client.query("rollback");return void json(res,404,{error:"organization_not_found"});}
          await client.query(`insert into organization_quota_overrides(organization_id,limits,updated_by)
            values($1,$2::jsonb,$3) on conflict(organization_id)
            do update set limits=excluded.limits,updated_by=excluded.updated_by,updated_at=now()`,
            [payload.organizationId,JSON.stringify(limits),principal.userId]);
          await client.query("insert into platform_admin_audit(actor_user_id,action,detail) values($1,'organization.quota_override',$2)",
            [principal.userId,"organization:"+payload.organizationId]);
          await client.query("commit");
        }catch(error){await client.query("rollback");throw error}finally{client.release()}
        return void json(res,200,{ok:true});
      }
      if (req.method === "GET" && url.pathname === "/api/console/organizations/members") {
        const organizationId=z.string().uuid().parse(url.searchParams.get("organizationId"));
        const organization=await db.query("select 1 from organizations where id=$1",[organizationId]);
        if(!organization.rowCount)return void json(res,404,{error:"organization_not_found"});
        const members=await db.query(
          `select m.user_id,u.email,m.role,m.created_at,(u.disabled_at is not null) as disabled
             from organization_members m join users u on u.id=m.user_id
            where m.organization_id=$1 order by m.created_at asc limit 250`,
          [organizationId],
        );
        return void json(res,200,{items:members.rows});
      }
      if (req.method === "POST" && url.pathname === "/api/console/organizations/members/role") {
        const payload=z.object({
          organizationId:z.string().uuid(),userId:z.string().uuid(),
          role:z.enum(["viewer","operator","admin"]),
          currentPassword:z.string().min(12).max(256),
        }).parse(await readJson(req));
        if(payload.userId===principal.userId)return void json(res,403,{error:"cannot_modify_self"});
        const operator=await db.query<{password_hash:string}>(
          "select password_hash from users where id=$1 and disabled_at is null",[principal.userId]);
        if(!operator.rows[0]||!(await verifyPassword(payload.currentPassword,operator.rows[0].password_hash)))
          return void json(res,403,{error:"reauthentication_failed"});
        const client=await db.connect();
        try{
          await client.query("begin");
          const organization=await client.query("select id from organizations where id=$1 for update",[payload.organizationId]);
          if(!organization.rowCount){await client.query("rollback");return void json(res,404,{error:"organization_not_found"});}
          const member=await client.query<{role:Role}>(
            "select role from organization_members where organization_id=$1 and user_id=$2 for update",
            [payload.organizationId,payload.userId]);
          if(!member.rows[0]){await client.query("rollback");return void json(res,404,{error:"membership_not_found"});}
          if(member.rows[0].role==="owner"){await client.query("rollback");return void json(res,403,{error:"owner_role_protected"});}
          const platform=await client.query(
            "select 1 from platform_administrators where user_id=$1 and revoked_at is null",[payload.userId]);
          if(platform.rowCount){await client.query("rollback");return void json(res,403,{error:"platform_admin_protected"});}
          await client.query(
            "update organization_members set role=$3 where organization_id=$1 and user_id=$2",
            [payload.organizationId,payload.userId,payload.role],
          );
          await client.query(
            "insert into platform_admin_audit(actor_user_id,action,detail) values($1,'membership.role_change',$2)",
            [principal.userId,"organization:"+payload.organizationId+" user:"+payload.userId+" role:"+payload.role],
          );
          await client.query("commit");
        }catch(error){await client.query("rollback");throw error}finally{client.release()}
        return void json(res,200,{ok:true});
      }
      if (req.method === "GET" && url.pathname === "/api/console/organizations") {
        const records = await db.query(
          `select o.id,o.name,o.created_at,count(distinct m.user_id)::int as members,
              count(distinct d.id)::int as devices, coalesce(q.limits,'{}'::jsonb) as quota_overrides
           from organizations o
           left join organization_quota_overrides q on q.organization_id=o.id
           left join organization_members m on m.organization_id=o.id
           left join devices d on d.organization_id=o.id and d.revoked_at is null
           group by o.id,q.limits order by o.created_at desc limit 100`,
        );
        return void json(res,200,{items:records.rows});
      }
      if (req.method === "GET" && url.pathname === "/api/console/devices") {
        const records = await db.query(
          `select d.id,d.name,d.platform,d.agent_version,d.last_seen_at,
                  d.revoked_at,o.name as organization_name
             from devices d join organizations o on o.id=d.organization_id
            order by d.created_at desc limit 100`,
        );
        return void json(res,200,{items:records.rows});
      }
      if (req.method === "GET" && url.pathname === "/api/console/audit") {
        const records = await db.query(
          `select item_id,tool,outcome,risk,created_at,organization_name from (
 select 'tenant:'||a.id::text as item_id,a.tool,a.outcome,a.risk,a.created_at,o.name as organization_name
 from audit_logs a left join organizations o on o.id=a.organization_id
 union all
 select 'platform:'||p.id::text as item_id,p.action as tool,'success'::text as outcome,'high'::text as risk,p.created_at,'WECOMMANDER Platform'::text as organization_name
 from platform_admin_audit p
 ) combined order by created_at desc limit 100`,
        );
        return void json(res,200,{items:records.rows});
      }
      if (req.method === "POST" && url.pathname === "/api/console/plans/limits") {
        const payload=z.object({
          key:z.string().min(1).max(100),
          maxDevices:z.number().int().min(0).nullable(),
          maxMembers:z.number().int().min(0).nullable(),
          maxApiTokens:z.number().int().min(0).nullable(),
          currentPassword:z.string().min(12).max(256),
        }).parse(await readJson(req));
        const passwordRow=await db.query<{password_hash:string}>("select password_hash from users where id=$1 and disabled_at is null",[principal.userId]);
        if(!passwordRow.rows[0]||!(await verifyPassword(payload.currentPassword,passwordRow.rows[0].password_hash)))
          return void json(res,403,{error:"reauthentication_failed"});
        const client=await db.connect();
        try {
          await client.query("begin");
          const plan=await client.query("select key from billing_plans where key=$1 for update",[payload.key]);
          if(!plan.rowCount){await client.query("rollback");return void json(res,404,{error:"plan_not_found"});}
          await client.query(`update billing_plans set max_devices=$2,max_members=$3,max_api_tokens=$4,updated_at=now() where key=$1`,
             [payload.key,payload.maxDevices,payload.maxMembers,payload.maxApiTokens]);
          await client.query("insert into platform_admin_audit(actor_user_id,action,detail) values($1,'billing.plan_limits',$2)",
             [principal.userId,"plan:"+payload.key]);
          await client.query("commit");
        }catch(error){await client.query("rollback");throw error}finally{client.release()}
        return void json(res,200,{ok:true});
      }
      if (req.method === "GET" && url.pathname === "/api/console/billing/requests") {
        const items=await db.query(
          `select r.id,r.type,r.message,r.status,r.resolution_note,r.created_at,r.reviewed_at,
              o.name as organization,u.email as requested_by_email
           from billing_support_requests r
           join organizations o on o.id=r.organization_id
           join users u on u.id=r.requested_by
           order by case when r.status='pending' then 0 when r.status='in_review' then 1 else 2 end,
                    r.created_at desc limit 200`);
        return void json(res,200,{items:items.rows});
      }
      if (req.method === "POST" && url.pathname === "/api/console/billing/requests/review") {
        const body=z.object({
          id:z.string().uuid(),status:z.enum(["in_review","closed"]),
          note:z.string().trim().min(10).max(2000),
          currentPassword:z.string().min(12).max(256),
        }).parse(await readJson(req));
        const operator=await db.query<{password_hash:string}>(
          "select password_hash from users where id=$1 and disabled_at is null",[principal.userId]);
        if(!operator.rows[0]||!(await verifyPassword(body.currentPassword,operator.rows[0].password_hash)))
          return void json(res,403,{error:"reauthentication_failed"});
        const client=await db.connect();
        try{
          await client.query("begin");
          const request=await client.query<{status:string,type:string}>(
            "select status,type from billing_support_requests where id=$1 for update",[body.id]);
          if(!request.rows[0]){await client.query("rollback");return void json(res,404,{error:"request_not_found"});}
          if(request.rows[0].status==="closed"){await client.query("rollback");return void json(res,409,{error:"request_already_closed"});}
          await client.query(
            `update billing_support_requests set status=$2,resolution_note=$3,reviewed_by=$4,
                  reviewed_at=now(),updated_at=now() where id=$1`,
            [body.id,body.status,body.note,principal.userId]);
          await client.query(
            "insert into platform_admin_audit(actor_user_id,action,detail) values($1,'billing.support_request_review',$2)",
            [principal.userId,"request:"+body.id+" status:"+body.status],
          );
          await client.query("commit");
        }catch(error){await client.query("rollback");throw error}finally{client.release()}
        return void json(res,200,{ok:true,providerActionPerformed:false});
      }
      if (req.method === "GET" && url.pathname === "/api/console/billing") {
        const plans=await db.query("select key,name,max_devices,max_members,max_api_tokens,active from billing_plans order by name");
        const subscriptions=await db.query(
          `select o.name as organization,s.plan_key,s.status,s.provider,s.current_period_end,s.cancel_at_period_end
           from organization_subscriptions s join organizations o on o.id=s.organization_id
           order by o.name limit 100`);
        return void json(res,200,{plans:plans.rows,subscriptions:subscriptions.rows});
      }
      if (req.method === "POST" && url.pathname === "/api/console/brand/upload") {
        const payload=z.object({
          kind:z.enum(["logo_light","logo_dark","favicon"]),
          mime:z.enum(["image/png","image/webp"]),
          base64:z.string().min(32).max(750000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
          currentPassword:z.string().min(12).max(256),
        }).parse(await readJson(req));
        const verify=await db.query<{password_hash:string}>("select password_hash from users where id=$1 and disabled_at is null",[principal.userId]);
        if(!verify.rows[0]||!(await verifyPassword(payload.currentPassword,verify.rows[0].password_hash)))
          return void json(res,403,{error:"reauthentication_failed"});
        const bytes=Buffer.from(payload.base64,"base64");
        if(bytes.length>500000)return void json(res,413,{error:"asset_too_large"});
        const png=bytes.length>24&&bytes.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex"));
        const webp=bytes.length>16&&bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WEBP";
        if(!(payload.mime==="image/png"?png:webp))return void json(res,400,{error:"invalid_image_header"});
        const client=await db.connect();
        try{
          await client.query("begin");
          await client.query(`insert into platform_brand_assets(kind,content_type,content,uploaded_by)
            values($1,$2,$3,$4) on conflict(kind)
            do update set content_type=excluded.content_type,content=excluded.content,uploaded_by=excluded.uploaded_by,updated_at=now()`,
            [payload.kind,payload.mime,bytes,principal.userId]);
          await client.query("insert into platform_admin_audit(actor_user_id,action,detail) values($1,'brand.update',$2)",[principal.userId,payload.kind]);
          await client.query("commit");
        }catch(error){await client.query("rollback");throw error}finally{client.release()}
        return void json(res,200,{ok:true});
      }
      if (req.method === "GET" && url.pathname === "/api/console/system") {
        const counts=await db.query(
          `select count(*) filter (where sent_at is null and failed_at is null)::int as pending,
             count(*) filter (where sent_at is not null)::int as delivered,
             count(*) filter (where failed_at is not null)::int as failed from mail_outbox`);
        const operations=await db.query(
          `select
            (select count(*)::int from relay_nodes) as relay_nodes,
            (select count(*)::int from relay_nodes where enabled and not drain and last_seen_at>now()-interval '2 minutes') as healthy_relays,
            (select count(*)::int from browser_sessions where revoked_at is null and expires_at>now()) as active_sessions,
            (select count(*)::int from approval_requests where status='pending') as pending_approvals`);
        return void json(res,200,{
          mailConfigured:mailConfigured(),
          signupEnabled:deploymentMode==="saas"&&publicSignupEnabled()&&mailConfigured(),
          deploymentMode,mailQueue:counts.rows[0],
          database:"connected",operations:operations.rows[0],checkedAt:new Date().toISOString(),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/console/legal") {
        const page=z.enum(["privacy","terms"]).parse(url.searchParams.get("page"));
        const locale=url.searchParams.get("locale")==="tr"?"tr":"en";
        const result=await db.query(
          "select id,page,locale,title,body,state,created_at from legal_page_revisions where page=$1 and locale=$2 order by id desc limit 30",
          [page,locale],
        );
        return void json(res,200,{items:result.rows});
      }
      if (req.method === "POST" && url.pathname === "/api/console/legal") {
        const body=z.object({
          page:z.enum(["privacy","terms"]),locale:z.enum(["en","tr"]),
          title:z.string().trim().min(1).max(160),body:z.string().trim().min(20).max(30000),
        }).parse(await readJson(req));
        const result=await db.query(
          "insert into legal_page_revisions(page,locale,title,body,created_by) values($1,$2,$3,$4,$5) returning id",
          [body.page,body.locale,body.title,body.body,principal.userId],
        );
        await db.query("insert into platform_admin_audit(actor_user_id,action,detail) values($1,'legal.draft',$2)",
          [principal.userId,body.page+":"+body.locale+":"+result.rows[0].id]);
        return void json(res,201,{id:result.rows[0].id});
      }
      if (req.method === "POST" && url.pathname === "/api/console/legal/publish") {
        const payload=z.object({
          id:z.union([z.number().int().positive().safe(),z.string().regex(/^[1-9][0-9]*$/).max(20)]),
          currentPassword:z.string().min(12).max(256),
        }).parse(await readJson(req));
        const publisher=await db.query<{password_hash:string}>(
          "select password_hash from users where id=$1 and disabled_at is null",[principal.userId]);
        if(!publisher.rows[0]||!(await verifyPassword(payload.currentPassword,publisher.rows[0].password_hash)))
          return void json(res,403,{error:"reauthentication_failed"});
        const client=await db.connect();
        try{
          await client.query("begin");
          await client.query("select pg_advisory_xact_lock(hashtext('wecommander:legal:publish'))");
          const selected=await client.query<{page:string;locale:string}>(
            "select page,locale from legal_page_revisions where id=$1 for update",[payload.id]);
          if(!selected.rows[0]){await client.query("rollback");return void json(res,404,{error:"revision_not_found"});}
          await client.query(
            "update legal_page_revisions set state='draft' where page=$1 and locale=$2 and state='published'",
            [selected.rows[0].page,selected.rows[0].locale]);
          await client.query("update legal_page_revisions set state='published' where id=$1",[payload.id]);
          await client.query("insert into platform_admin_audit(actor_user_id,action,detail) values($1,'legal.publish',$2)",
            [principal.userId,selected.rows[0].page+":"+selected.rows[0].locale+":"+payload.id]);
          await client.query("commit");
        }catch(error){await client.query("rollback");throw error}finally{client.release()}
        return void json(res,200,{ok:true});
      }
      if (req.method === "GET" && url.pathname === "/api/console/site-content") {
        const locale = url.searchParams.get("locale")==="tr"?"tr":"en";
        const revisions=await db.query(
          "select id,locale,hero_title,hero_subtitle,overrides,seo_title,seo_description,state,created_at from site_content_revisions where locale=$1 order by created_at desc,id desc limit 30",[locale]);
        return void json(res,200,{items:revisions.rows});
      }
      if (req.method === "POST" && url.pathname === "/api/console/site-content") {
        const payload=z.object({
          locale:z.enum(["en","tr"]),heroTitle:z.string().trim().min(1).max(160),
          heroSubtitle:z.string().trim().min(1).max(500),
          overrides:z.record(z.string().max(300),z.string().max(800)).refine(data=>Object.keys(data).length<=150).default({}),
          seoTitle:z.string().trim().max(70).default(''),seoDescription:z.string().trim().max(170).default(''),
        }).parse(await readJson(req));
        const saved=await db.query(
          "insert into site_content_revisions(locale,hero_title,hero_subtitle,overrides,seo_title,seo_description,created_by) values($1,$2,$3,$4::jsonb,$5,$6,$7) returning id",
          [payload.locale,payload.heroTitle,payload.heroSubtitle,JSON.stringify(payload.overrides),payload.seoTitle,payload.seoDescription,principal.userId],
        );
        await db.query("insert into platform_admin_audit(actor_user_id,action,detail) values($1,'cms.draft',$2)",
          [principal.userId,"revision:"+saved.rows[0].id]);
        return void json(res,201,{id:saved.rows[0].id});
      }
      if (req.method === "POST" && url.pathname === "/api/console/site-content/publish") {
        const payload=z.object({id:z.union([z.number().int().positive().safe(),z.string().regex(/^[1-9][0-9]*$/).max(20)]),currentPassword:z.string().min(12).max(256)}).parse(await readJson(req));
        const publisher=await db.query<{password_hash:string}>(
          "select password_hash from users where id=$1 and disabled_at is null",[principal.userId]);
        if(!publisher.rows[0]||!(await verifyPassword(payload.currentPassword,publisher.rows[0].password_hash)))
          return void json(res,403,{error:"reauthentication_failed"});
        const client=await db.connect();
        try {
          await client.query("begin");
          await client.query("select pg_advisory_xact_lock(hashtext('wecommander:cms:publish'))");
          const revision=await client.query<{locale:string}>("select locale from site_content_revisions where id=$1 for update",[payload.id]);
          if(!revision.rows[0]){await client.query("rollback");return void json(res,404,{error:"revision_not_found"});}
          await client.query("update site_content_revisions set state='draft' where locale=$1 and state='published'",[revision.rows[0].locale]);
          await client.query("update site_content_revisions set state='published' where id=$1",[payload.id]);
          await client.query("insert into platform_admin_audit(actor_user_id,action,detail) values($1,'cms.publish',$2)",
            [principal.userId,"revision:"+payload.id]);
          await client.query("commit");
        } catch(error) {await client.query("rollback");throw error;} finally{client.release();}
        return void json(res,200,{ok:true});
      }
      return void json(res, 404, { error: "not_found" });
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

    if (req.method === "POST" && url.pathname === "/api/billing/paddle/checkout") {
      if (!requireRole(principal!,"owner",res)) return;
      const limit=checkoutRateLimit.hit(principal!.organizationId,8,15*60_000);
      if(!limit.allowed){
        res.setHeader("Retry-After",String(limit.retryAfterSeconds));
        return void json(res,429,{error:"rate_limited"});
      }
      const body=z.object({planKey:z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/)}).parse(await readJson(req));
      return void json(res,201,await createPaddleCheckout(principal!.organizationId,body.planKey));
    }
    if (req.method === "POST" && url.pathname === "/api/billing/paddle/portal") {
      if (!requireRole(principal!,"owner",res)) return;
      return void json(res,200,await createPaddlePortal(principal!.organizationId));
    }
    if (req.method === "GET" && url.pathname === "/api/billing/support-requests") {
      if (!requireRole(principal!,"viewer",res)) return;
      const items=await db.query(
        `select id,type,message,status,resolution_note,created_at,reviewed_at
           from billing_support_requests where organization_id=$1
          order by created_at desc limit 50`,
        [principal!.organizationId],
      );
      return void json(res,200,{items:items.rows});
    }
    if (req.method === "POST" && url.pathname === "/api/billing/support-requests") {
      if(!requireRole(principal!,"owner",res))return;
      if(principal!.authKind!=="session"||!principal!.userId)
        return void json(res,403,{error:"browser_owner_session_required"});
      const rate=billingSupportRateLimit.hit(principal!.organizationId,5,60*60_000);
      if(!rate.allowed){
        res.setHeader("Retry-After",String(rate.retryAfterSeconds));
        return void json(res,429,{error:"rate_limited"});
      }
      const body=z.object({type:z.enum(["cancellation","refund"]),message:z.string().trim().min(5).max(2000)}).parse(await readJson(req));
      const subscription=await db.query(
        "select 1 from organization_subscriptions where organization_id=$1 and provider='paddle'",
        [principal!.organizationId],
      );
      if(!subscription.rowCount)return void json(res,409,{error:"paddle_subscription_required"});
      const saved=await db.query(
        `insert into billing_support_requests(organization_id,requested_by,type,message)
         values($1,$2,$3,$4) on conflict do nothing returning id,status,created_at`,
        [principal!.organizationId,principal!.userId,body.type,body.message],
      );
      if(!saved.rows[0])return void json(res,409,{error:"request_already_open"});
      return void json(res,201,{item:saved.rows[0]});
    }
    if (req.method === "GET" && url.pathname === "/api/billing") {
      if (!requireRole(principal!, "viewer", res)) return;
      return void json(res, 200, await billingSnapshot(principal!.organizationId));
    }

    if (req.method === "GET" && url.pathname === "/api/usage") {
      if (!requireRole(principal!, "viewer", res)) return;
      const organizationId = principal!.organizationId;
      const [snapshot, current, history, reset, daily, topTools] = await Promise.all([
        billingSnapshot(organizationId),
        db.query<{ month_calls: string; days_elapsed: string }>(
          `select
             count(*) filter (
               where created_at >= date_trunc('month',now())
                 and (tool not like '%.%' or tool like 'direct.%')
             )::text as month_calls,
             greatest(1,extract(day from now()))::text as days_elapsed
             from audit_logs
            where organization_id=$1`,
          [organizationId],
        ),
        db.query<{ month: string; calls: string }>(
          `with months as (
             select generate_series(
               date_trunc('month',now()) - interval '5 months',
               date_trunc('month',now()),
               interval '1 month'
             ) as month
           ),
           counts as (
             select date_trunc('month',created_at) as month,count(*)::bigint as calls
               from audit_logs
              where organization_id=$1
                and created_at >= date_trunc('month',now()) - interval '5 months'
                and (tool not like '%.%' or tool like 'direct.%')
              group by 1
           )
           select to_char(months.month,'YYYY-MM') as month,
                  coalesce(counts.calls,0)::text as calls
             from months
             left join counts using(month)
            order by months.month asc`,
          [organizationId],
        ),
        db.query<{ reset_at: string }>(
          "select (date_trunc('month',now()) + interval '1 month')::timestamptz::text as reset_at",
        ),
        db.query<{ day: string; calls: string }>(
          `with days as (
             select generate_series(
               date_trunc('day',now()) - interval '6 days',
               date_trunc('day',now()), interval '1 day'
             ) as day
           ),
           counts as (
             select date_trunc('day',created_at) as day,count(*)::bigint as calls
               from audit_logs
              where organization_id=$1
                and created_at >= date_trunc('day',now()) - interval '6 days'
                and (tool not like '%.%' or tool like 'direct.%')
              group by 1
           )
           select to_char(days.day,'YYYY-MM-DD') as day,
                  coalesce(counts.calls,0)::text as calls
             from days left join counts using(day)
            order by days.day asc`,
          [organizationId],
        ),
        db.query<{ tool: string; calls: string }>(
          `select tool,count(*)::text as calls
             from audit_logs
            where organization_id=$1
              and created_at >= date_trunc('month',now())
              and (tool not like '%.%' or tool like 'direct.%')
            group by tool order by count(*) desc, tool asc limit 25`,
          [organizationId],
        ),
      ]);

      const monthCalls = Number(current.rows[0]?.month_calls ?? 0);
      const daysElapsed = Math.max(1, Number(current.rows[0]?.days_elapsed ?? 1));
      const metadata = (snapshot.plan?.metadata ?? {}) as Record<string, unknown>;
      const configuredLimit = Number(
        metadata.monthlyToolCalls ??
        metadata.maxToolCalls ??
        metadata.toolCallLimit ??
        Number.NaN,
      );
      let limit: number | null;
      if (snapshot.mode === "self_hosted" || snapshot.plan?.key === "pro") {
        limit = null;
      } else if (Number.isFinite(configuredLimit) && configuredLimit >= 0) {
        limit = configuredLimit;
      } else if (snapshot.plan?.key === "free") {
        limit = 10_000;
      } else {
        limit = snapshot.entitled ? null : 0;
      }

      return void json(res, 200, {
        monthCalls,
        dailyAverage: Math.round(monthCalls / daysElapsed),
        limit,
        resetAt: reset.rows[0]?.reset_at ?? null,
        months: history.rows.map((row) => ({
          month: row.month,
          calls: Number(row.calls ?? 0),
        })),
        daily: daily.rows.map((row) => ({
          day: row.day,
          calls: Number(row.calls ?? 0),
        })),
        topTools: topTools.rows.map((row) => ({
          tool: row.tool,
          calls: Number(row.calls ?? 0),
        })),
      });
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
        `select id::text,attempts,next_attempt_at,sent_at,failed_at,last_error,created_at
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
        status: z.enum(["trialing", "active", "past_due", "paused", "canceled"]),
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
      }).parse(await readJson(req));
      if (!roleAtLeast(principal!, body.role)) {
        return void json(res, 403, { error: "cannot_grant_role", requestedRole: body.role });
      }

      const organizationId = principal!.organizationId;
      const email = normalizeEmail(body.email);
      const token = "wrci_" + randomToken(32);
      const client = await db.connect();
      try {
        await client.query("begin");
        await client.query("select id from organizations where id=$1 for update", [organizationId]);

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
        await client.query("commit");
        await auditControl(
          principal!,
          null,
          "invitation.create",
          "medium",
          "success",
          JSON.stringify({ invitationId: created.rows[0]!.id, email, role: body.role }),
        );
        return void json(res, 201, {
          item: created.rows[0],
          inviteToken: token,
          inviteUrl: `${publicBaseUrl}/app#invite=${encodeURIComponent(token)}`,
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
      const limit = queryLimit(url, 100, 200);
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

    // Viewer-safe activity feed: do not expose audit detail, actor or risk metadata.
    if (req.method === "GET" && url.pathname === "/api/activity") {
      if (!requireRole(principal!, "viewer", res)) return;
      const limit = queryLimit(url, 6, 30);
      const recent = await db.query(
        `select a.tool,a.outcome,a.created_at,a.device_id,d.name as device_name
           from audit_logs a
           left join devices d on d.id=a.device_id and d.organization_id=a.organization_id
          where a.organization_id=$1
          order by a.created_at desc limit $2`,
        [principal!.organizationId, limit],
      );
      return void json(res, 200, { items: recent.rows });
    }

    if (req.method === "GET" && url.pathname === "/api/audit") {
      if (!requireRole(principal!, "admin", res)) return;
      const limit = queryLimit(url, 100, 200);
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
    `WECOMMANDER gateway listening on ${nativeTlsEnabled ? "https" : "http"}://${host}:${port}\n`,
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
