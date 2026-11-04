import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { hashPassword } from "../dist/browser-auth.js";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const resource = base + "/mcp";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const password = "oauth-acceptance-password-2026";
const email = "oauth-acceptance-" + crypto.randomUUID() + "@example.test";
const org = await db.query("insert into organizations(name) values('OAuth acceptance') returning id");
const user = await db.query(
  "insert into users(email,password_hash,email_verified_at) values($1,$2,now()) returning id",
  [email, await hashPassword(password)],
);
await db.query(
  "insert into organization_members(organization_id,user_id,role) values($1,$2,'operator')",
  [org.rows[0].id, user.rows[0].id],
);

async function postJson(path, body) {
  return fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
function tokenRequest(body) {
  return fetch(base + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

try {
  const metadataResponse = await fetch(base + "/.well-known/oauth-protected-resource");
  assert.equal(metadataResponse.status, 200);
  const meta = await metadataResponse.json();
  assert.equal(meta.resource, resource);
  assert.deepEqual(meta.authorization_servers, [base]);

  const authorizationResponse = await fetch(base + "/.well-known/oauth-authorization-server");
  const authorization = await authorizationResponse.json();
  assert.equal(authorization.issuer, base);
  assert.ok(authorization.code_challenge_methods_supported.includes("S256"));
  assert.equal(authorization.token_endpoint_auth_methods_supported[0], "none");

  const unauth = await fetch(resource, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get("www-authenticate") || "", /oauth-protected-resource/);

  const badRegistration = await postJson("/oauth/register", {
    client_name: "unsafe", redirect_uris: ["http://unsafe.example/callback"],
    grant_types: ["authorization_code"],
  });
  assert.equal(badRegistration.status, 400);
  const invalidResponseType = await postJson("/oauth/register", {
    client_name: "unsupported response",
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    response_types: ["token"],
  });
  assert.equal(invalidResponseType.status, 400);
  const registered = await postJson("/oauth/register", {
    client_name: "ChatGPT CI connector",
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  assert.equal(registered.status, 201);
  const registeredClient = await registered.json();
  assert.match(registeredClient.client_id, /^wrcoc_/);

  const login = await postJson("/api/auth/login", { email, password });
  assert.equal(login.status, 200);
  const loggedIn = await login.json();
  const cookie = login.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
  assert.ok(cookie.includes("commender_session="));

  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const params = {
    response_type: "code",
    client_id: registeredClient.client_id,
    redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    scope: "mcp:tools",
    state: "ci-state-987",
  };
  const query = new URLSearchParams(params);
  const consent = await fetch(base + "/oauth/authorize?" + query, { headers: { Cookie: cookie } });
  assert.equal(consent.status, 200);
  assert.match(await consent.text(), /Erişime izin ver/);
  // The consent POST answers with a 302 to the client; browsers enforce CSP
  // form-action on that redirect, so the client's origin must be allowed.
  assert.match(consent.headers.get("content-security-policy") || "",
    /form-action 'self' https:\/\/chatgpt\.com;/);
  const duplicateQuery = await fetch(base + "/oauth/authorize?" + query + "&client_id=" +
    encodeURIComponent(params.client_id), { headers: { Cookie: cookie } });
  assert.equal(duplicateQuery.status, 400, "duplicated GET authorization parameter must fail closed");

  const noCsrf = await fetch(base + "/oauth/authorize", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, decision: "allow" }),
  });
  assert.equal(noCsrf.status, 403);

  const grant = await fetch(base + "/oauth/authorize", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, csrf_token: loggedIn.csrfToken, decision: "allow" }),
    redirect: "manual",
  });
  assert.equal(grant.status, 302);
  const callback = new URL(grant.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), params.state);
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const wrongVerifier = await tokenRequest({
    grant_type: "authorization_code", client_id: params.client_id,
    code, redirect_uri: params.redirect_uri, code_verifier: "x".repeat(64), resource,
  });
  assert.equal(wrongVerifier.status, 400);

  const wrongResource = await tokenRequest({
    grant_type: "authorization_code", client_id: params.client_id,
    code, redirect_uri: params.redirect_uri, code_verifier: verifier,
    resource: base + "/admin",
  });
  assert.equal(wrongResource.status, 400);

  const issued = await tokenRequest({
    grant_type: "authorization_code", client_id: params.client_id,
    code, redirect_uri: params.redirect_uri, code_verifier: verifier, resource,
  });
  assert.equal(issued.status, 200);
  const tokens = await issued.json();
  assert.match(tokens.access_token, /^wrco_/);
  assert.match(tokens.refresh_token, /^wrcr_/);

  const replay = await tokenRequest({
    grant_type: "authorization_code", client_id: params.client_id,
    code, redirect_uri: params.redirect_uri, code_verifier: verifier, resource,
  });
  assert.equal(replay.status, 400);

  // Claude-style client: asks for client_secret_post, omits the RFC 8707
  // resource parameter and authenticates at the token endpoint with HTTP
  // Basic. It is registered as a public PKCE client bound to the MCP resource.
  {
    const claudeRedirect = "https://claude.ai/api/mcp/auth_callback";
    const rejectedMethod = await postJson("/oauth/register", {
      client_name: "jwt client", redirect_uris: [claudeRedirect], token_endpoint_auth_method: "private_key_jwt",
    });
    assert.equal(rejectedMethod.status, 400, "unsupported client auth methods stay rejected");
    const claudeRegistration = await postJson("/oauth/register", {
      client_name: "Claude", redirect_uris: [claudeRedirect],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post", scope: "mcp:tools",
    });
    assert.equal(claudeRegistration.status, 201);
    const claudeClient = await claudeRegistration.json();
    assert.equal(claudeClient.token_endpoint_auth_method, "none");
    assert.equal(claudeClient.client_secret, undefined);
    const claudeVerifier = crypto.randomBytes(48).toString("base64url");
    const claudeParams = {
      response_type: "code", client_id: claudeClient.client_id, redirect_uri: claudeRedirect,
      code_challenge: crypto.createHash("sha256").update(claudeVerifier).digest("base64url"),
      code_challenge_method: "S256", scope: "mcp:tools", state: "claude-state",
    };
    const claudeGrant = await fetch(base + "/oauth/authorize", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...claudeParams, csrf_token: loggedIn.csrfToken, decision: "allow" }),
      redirect: "manual",
    });
    assert.equal(claudeGrant.status, 302);
    const claudeCode = new URL(claudeGrant.headers.get("location")).searchParams.get("code");
    const basic = "Basic " + Buffer.from(encodeURIComponent(claudeClient.client_id) + ":").toString("base64");
    const claudeToken = await fetch(base + "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic },
      body: new URLSearchParams({ grant_type: "authorization_code", code: claudeCode, redirect_uri: claudeRedirect, code_verifier: claudeVerifier }),
    });
    assert.equal(claudeToken.status, 200, await claudeToken.clone().text());
    const claudeTokens = await claudeToken.json();
    const claudeList = await fetch(resource, {
      method: "POST",
      headers: { Authorization: "Bearer " + claudeTokens.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(claudeList.status, 200, "token without explicit resource is bound to the MCP resource");
    const otherResource = await fetch(base + "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: claudeTokens.refresh_token, resource: base + "/admin" }),
    });
    assert.equal(otherResource.status, 400, "a refresh for another resource is still refused");
    const claudeRefresh = await fetch(base + "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: claudeTokens.refresh_token }),
    });
    assert.equal(claudeRefresh.status, 200);
  }

  async function mcp(accessToken) {
    return fetch(resource, {
      method: "POST",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  }
  const tools = await mcp(tokens.access_token);
  assert.equal(tools.status, 200);
  const listed = await tools.json();
  assert.ok(listed.result.tools.some((t) => t.name === "devices_list"));
  assert.ok(listed.result.tools.every((t) => t.securitySchemes?.[0]?.type === "oauth2"));
  const restApi = await fetch(base + "/api/devices", { headers: { Authorization: "Bearer " + tokens.access_token } });
  assert.equal(restApi.status, 401, "OAuth MCP token may not access REST routes");

  const rotate = await tokenRequest({
    grant_type: "refresh_token", client_id: params.client_id,
    refresh_token: tokens.refresh_token, resource,
  });
  assert.equal(rotate.status, 200);
  const rotated = await rotate.json();
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  const oldRefresh = await tokenRequest({
    grant_type: "refresh_token", client_id: params.client_id,
    refresh_token: tokens.refresh_token, resource,
  });
  assert.equal(oldRefresh.status, 400);
  const withNewAccess = await mcp(rotated.access_token);
  assert.equal(withNewAccess.status, 200);

  const revoke = await fetch(base + "/oauth/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: params.client_id, token: rotated.refresh_token }),
  });
  assert.equal(revoke.status, 200);
  const afterRevoke = await mcp(rotated.access_token);
  assert.equal(afterRevoke.status, 401);
  console.log("OAuth DCR + browser consent + PKCE + MCP + refresh + revoke acceptance PASSED");
} finally {
  await db.query("delete from organizations where id=$1", [org.rows[0].id]);
  await db.end();
}
