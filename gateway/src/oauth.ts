import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "./db.js";
import { authenticateRequest, verifyBrowserCsrf } from "./auth.js";
import { csrfCookieName } from "./browser-auth.js";
import { randomToken, sha256 } from "./crypto-utils.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { oauthScope } from "./oauth-tokens.js";

const registerLimiter = new FixedWindowRateLimiter();
const tokenLimiter = new FixedWindowRateLimiter();
const authorizationLimiter = new FixedWindowRateLimiter();

type OAuthClient = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
};

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function failure(res: ServerResponse, status: number, error: string) {
  json(res, status, { error });
}

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c] || c);
}

function html(res: ServerResponse, body: string) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(
    '<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>WECOMMANDER · MCP Yetkilendirme</title>' +
    '<style>body{font:16px system-ui,sans-serif;background:#0e1421;color:#f4f6fa;display:grid;place-items:center;min-height:94vh}' +
    'main{box-sizing:border-box;width:min(450px,92vw);padding:28px;border:1px solid #34415b;border-radius:14px;background:#192237}' +
    'input,button{font:inherit;box-sizing:border-box;width:100%;padding:12px;margin:7px 0;border-radius:7px}' +
    'input{background:#0e1421;color:white;border:1px solid #65728c}button{background:#bfe5fd;color:#101722;border:0;cursor:pointer;font-weight:600}' +
    'p{line-height:1.5;color:#cdd8e7}code{word-break:break-all}small{color:#aebed0}</style><main>' +
    body + '</main></html>',
  );
}

async function bodyText(req: IncomingMessage, limit = 16_384): Promise<string> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const part of req) {
    const value = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += value.length;
    if (size > limit) throw new Error("body_too_large");
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

function form(req: IncomingMessage, text: string) {
  if (!String(req.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded")) throw new Error("invalid_content_type");
  const entries = new URLSearchParams(text);
  const values: Record<string, string> = Object.create(null);
  for (const [key, val] of entries) {
    if (key in values) throw new Error("duplicate_parameter");
    values[key] = val;
  }
  return values;
}

function getCookie(req: IncomingMessage, name: string) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i >= 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

function redirectAllowed(value: string) {
  if (!value || value.length > 1024) return false;
  try {
    const u = new URL(value);
    if (u.username || u.password || u.hash || !u.hostname) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

function validResource(value: string, origin: string) {
  return value === origin + "/mcp" || value === origin;
}

function baseEnabled(origin: string) {
  return process.env.MCP_OAUTH_ENABLED === "true" &&
    (origin.startsWith("https://") || origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"));
}

function clientIp(req: IncomingMessage) {
  return req.socket.remoteAddress || "unknown";
}

function safeClientName(name: unknown) {
  return typeof name === "string" && name.trim().length > 0 && name.length <= 120 ? name.trim() : "MCP client";
}

function validChallenge(value: string) {
  return /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

export function oauthChallenge(origin: string) {
  return 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource", error="invalid_token", error_description="Authentication required"';
}

export async function handleOAuthHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  origin: string,
): Promise<boolean> {
  if (!baseEnabled(origin)) return false;
  const path = url.pathname;
  const known = new Set([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/oauth/register",
    "/oauth/authorize",
    "/oauth/token",
    "/oauth/revoke",
  ]);
  if (!known.has(path)) return false;

  if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
    json(res, 200, {
      resource: origin + "/mcp",
      authorization_servers: [origin],
      scopes_supported: [oauthScope],
      bearer_methods_supported: ["header"],
    });
    return true;
  }
  if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
    json(res, 200, {
      issuer: origin,
      authorization_endpoint: origin + "/oauth/authorize",
      token_endpoint: origin + "/oauth/token",
      registration_endpoint: origin + "/oauth/register",
      revocation_endpoint: origin + "/oauth/revoke",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [oauthScope],
    });
    return true;
  }
  if (req.method === "POST" && path === "/oauth/register") {
    if (!registerLimiter.hit(clientIp(req), 20, 60 * 60_000).allowed) {
      failure(res, 429, "rate_limited"); return true;
    }
    try {
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw new Error("invalid_content_type");
      const body = JSON.parse(await bodyText(req)) as Record<string, unknown>;
      if (!body || typeof body !== "object" || !Array.isArray(body.redirect_uris) ||
          body.redirect_uris.length < 1 || body.redirect_uris.length > 8 ||
          body.redirect_uris.some((u) => typeof u !== "string" || !redirectAllowed(u)) ||
          new Set(body.redirect_uris).size !== body.redirect_uris.length ||
          (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") ||
          (body.grant_types !== undefined && JSON.stringify(body.grant_types) !== '["authorization_code","refresh_token"]' &&
           JSON.stringify(body.grant_types) !== '["authorization_code"]')) {
        failure(res, 400, "invalid_client_metadata"); return true;
      }
      const name = safeClientName(body.client_name);
      const clientId = "wrcoc_" + randomToken(24);
      await db.query(
        "insert into oauth_clients(client_id,client_name,redirect_uris) values($1,$2,$3::jsonb)",
        [clientId, name, JSON.stringify(body.redirect_uris)],
      );
      json(res, 201, {
        client_id: clientId,
        client_name: name,
        redirect_uris: body.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_id_issued_at: Math.floor(Date.now() / 1000),
      });
    } catch {
      failure(res, 400, "invalid_client_metadata");
    }
    return true;
  }
  if ((req.method === "GET" || req.method === "POST") && path === "/oauth/authorize") {
    if (!authorizationLimiter.hit(clientIp(req), 120, 10 * 60_000).allowed) {
      failure(res, 429, "rate_limited"); return true;
    }
    let p: Record<string, string>;
    try {
      p = req.method === "GET" ? Object.fromEntries(url.searchParams) : form(req, await bodyText(req));
    } catch {
      failure(res, 400, "invalid_request"); return true;
    }
    const clientId = p.client_id || "";
    const redirectUri = p.redirect_uri || "";
    const challenge = p.code_challenge || "";
    const resource = p.resource || "";
    const scope = p.scope || oauthScope;
    const state = p.state || "";
    if (p.response_type !== "code" || p.code_challenge_method !== "S256" ||
        !validChallenge(challenge) || !validResource(resource, origin) ||
        scope !== oauthScope || state.length > 2048 || !redirectAllowed(redirectUri)) {
      failure(res, 400, "invalid_request"); return true;
    }
    const clients = await db.query<OAuthClient>(
      "select client_id,client_name,redirect_uris from oauth_clients where client_id=$1",
      [clientId],
    );
    const client = clients.rows[0];
    if (!client || !client.redirect_uris.includes(redirectUri)) {
      failure(res, 400, "invalid_client"); return true;
    }
    const principal = await authenticateRequest(undefined, req.headers.cookie);
    if (!principal || principal.authKind !== "session" || !principal.userId || !principal.sessionId) {
      if (req.method === "POST") { failure(res, 401, "login_required"); return true; }
      html(res, '<h2>WECOMMANDER Girişi</h2><p>ChatGPT bağlantısı için mevcut hesabınızla giriş yapın.</p>' +
        '<form id="signin"><label>E-posta<input type="email" name="email" required autocomplete="username"></label>' +
        '<label>Parola<input type="password" name="password" required autocomplete="current-password" minlength="12"></label>' +
        '<button type="submit">Giriş yap ve devam et</button><p id="error" role="alert"></p></form>' +
        '<script>document.getElementById("signin").addEventListener("submit",async function(e){e.preventDefault();' +
        'const f=new FormData(e.target);const b={email:f.get("email"),password:f.get("password")};' +
        'const r=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify(b)});' +
        'if(r.ok){location.reload()}else{document.getElementById("error").textContent="Giriş başarısız. Bilgilerinizi kontrol edin."}})</script>');
      return true;
    }
    if (req.method === "GET") {
      const hidden = (name: string, val: string) =>
        '<input type="hidden" name="' + name + '" value="' + htmlEscape(val) + '">';
      html(res, '<h2>MCP erişim izni</h2><p><b>' + htmlEscape(client.client_name) +
        '</b> uygulamasına WECOMMANDER hesabınızın cihazlarını ve araçlarını kullanma erişimi verilsin mi?</p>' +
        '<p>Organizasyon rolünüz: <b>' + htmlEscape(principal.role) + '</b></p>' +
        '<p><small>Erişim alanı: ' + oauthScope + '. Yüksek riskli işlemler ayrıca onay gerektirir.</small></p>' +
        '<form method="post" action="/oauth/authorize">' +
        Object.entries({
          client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
          code_challenge_method: "S256", resource, scope, state, response_type: "code",
          csrf_token: getCookie(req, csrfCookieName),
        }).map(([name, val]) => hidden(name, val)).join("") +
        '<button type="submit" name="decision" value="allow">Erişime izin ver</button>' +
        '<button type="submit" name="decision" value="deny">Reddet</button></form>');
      return true;
    }
    if (!verifyBrowserCsrf(principal, p.csrf_token)) {
      failure(res, 403, "csrf_required"); return true;
    }
    if (p.decision === "deny") {
      const redirect = new URL(redirectUri);
      redirect.searchParams.set("error", "access_denied");
      if (state) redirect.searchParams.set("state", state);
      res.writeHead(302, { Location: redirect.href, "Cache-Control": "no-store" }); res.end(); return true;
    }
    if (p.decision !== "allow") { failure(res, 400, "invalid_request"); return true; }
    const code = "wrcc_" + randomToken(40);
    await db.query(
      "insert into oauth_codes(code_hash,client_id,user_id,organization_id,session_id,redirect_uri,code_challenge,resource,scope,expires_at) " +
      "values($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '5 minutes')",
      [sha256(code), clientId, principal.userId, principal.organizationId,
       principal.sessionId, redirectUri, challenge, resource, scope],
    );
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state) redirect.searchParams.set("state", state);
    res.writeHead(302, { Location: redirect.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    res.end();
    return true;
  }
  if (req.method === "POST" && path === "/oauth/token") {
    if (!tokenLimiter.hit(clientIp(req), 120, 10 * 60_000).allowed) {
      failure(res, 429, "rate_limited"); return true;
    }
    let p: Record<string, string>;
    try { p = form(req, await bodyText(req)); }
    catch { failure(res, 400, "invalid_request"); return true; }
    const clientId = p.client_id || "";
    const clients = await db.query("select 1 from oauth_clients where client_id=$1", [clientId]);
    if (!clients.rowCount || !validResource(p.resource || "", origin)) {
      failure(res, 400, "invalid_client"); return true;
    }
    if (p.grant_type === "authorization_code") {
      if (!/^wrcc_[A-Za-z0-9_-]{40,}$/.test(p.code || "") ||
          (p.code_verifier || "").length < 43 || (p.code_verifier || "").length > 128 ||
          !/^[A-Za-z0-9._~-]+$/.test(p.code_verifier || "")) {
        failure(res, 400, "invalid_grant"); return true;
      }
      const expected = crypto.createHash("sha256").update(p.code_verifier).digest("base64url");
      const client = await db.connect();
      try {
        await client.query("begin");
        const rows = await client.query<{
          user_id: string; organization_id: string; redirect_uri: string;
          code_challenge: string; resource: string; scope: string;
        }>(
          "select c.user_id,c.organization_id,c.redirect_uri,c.code_challenge,c.resource,c.scope " +
          "from oauth_codes c join browser_sessions s on s.id=c.session_id and s.revoked_at is null and s.expires_at>now() " +
          "join users u on u.id=c.user_id and u.disabled_at is null " +
          "join organization_members m on m.user_id=c.user_id and m.organization_id=c.organization_id " +
          "where c.code_hash=$1 and c.client_id=$2 and c.expires_at>now() for update of c",
          [sha256(p.code), clientId],
        );
        const row = rows.rows[0];
        if (!row || row.code_challenge !== expected || row.redirect_uri !== p.redirect_uri ||
            row.resource !== p.resource || row.scope !== oauthScope) {
          await client.query("rollback"); failure(res, 400, "invalid_grant"); return true;
        }
        await client.query("delete from oauth_codes where code_hash=$1", [sha256(p.code)]);
        const access = "wrco_" + randomToken(40);
        const refresh = "wrcr_" + randomToken(40);
        await client.query(
          "insert into oauth_sessions(client_id,user_id,organization_id,resource,scope,access_hash,refresh_hash,access_expires_at,refresh_expires_at) " +
          "values($1,$2,$3,$4,$5,$6,$7,now()+interval '1 hour',now()+interval '30 days')",
          [clientId, row.user_id, row.organization_id, row.resource, row.scope, sha256(access), sha256(refresh)],
        );
        await client.query("commit");
        json(res, 200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: oauthScope });
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally { client.release(); }
      return true;
    }
    if (p.grant_type === "refresh_token") {
      if (!/^wrcr_[A-Za-z0-9_-]{40,}$/.test(p.refresh_token || "")) {
        failure(res, 400, "invalid_grant"); return true;
      }
      const access = "wrco_" + randomToken(40);
      const refresh = "wrcr_" + randomToken(40);
      const updated = await db.query(
        "update oauth_sessions s set access_hash=$1,refresh_hash=$2,access_expires_at=now()+interval '1 hour' " +
        "where s.refresh_hash=$3 and s.client_id=$4 and s.resource=$5 and s.refresh_expires_at>now() and s.revoked_at is null " +
        "and exists(select 1 from users u join organization_members m on m.user_id=u.id and m.organization_id=s.organization_id " +
        "where u.id=s.user_id and u.disabled_at is null) returning s.id",
        [sha256(access), sha256(refresh), sha256(p.refresh_token), clientId, p.resource],
      );
      if (!updated.rowCount) { failure(res, 400, "invalid_grant"); return true; }
      json(res, 200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: oauthScope });
      return true;
    }
    failure(res, 400, "unsupported_grant_type");
    return true;
  }
  if (req.method === "POST" && path === "/oauth/revoke") {
    let p: Record<string, string>;
    try { p = form(req, await bodyText(req)); }
    catch { failure(res, 400, "invalid_request"); return true; }
    if (!p.client_id) { failure(res, 400, "invalid_client"); return true; }
    await db.query(
      "update oauth_sessions set revoked_at=now() where client_id=$1 and (refresh_hash=$2 or access_hash=$2)",
      [p.client_id, sha256(p.token || "")],
    );
    json(res, 200, {}); return true;
  }
  failure(res, 405, "method_not_allowed"); return true;
}
