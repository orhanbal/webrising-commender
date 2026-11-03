// RBAC matrix over MCP (parity 9A): for every advertised tool whose action is
// medium or high risk, a viewer's OAuth MCP token must get `forbidden` before
// anything is routed to a device, and the denial must be audited. An operator
// must not be refused by role for the same calls. Needs MCP_OAUTH_ENABLED=true
// and DATABASE_URL; no Agent is required (role checks precede routing).

import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { hashPassword } from "../dist/browser-auth.js";
import { actionRisk } from "../dist/protocol.js";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const resource = base + "/mcp";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const created = [];

async function user(orgId, role) {
  const email = `rbac-${role}-${crypto.randomUUID()}@example.test`, password = "rbac-matrix-password-2026";
  const u = await db.query("insert into users(email,password_hash,email_verified_at) values($1,$2,now()) returning id", [email, await hashPassword(password)]);
  await db.query("insert into organization_members(organization_id,user_id,role) values($1,$2,$3)", [orgId, u.rows[0].id, role]);
  return { email, password, id: u.rows[0].id };
}
async function token(u) {
  const reg = await (await fetch(base + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    client_name: "RBAC matrix", redirect_uris: ["http://127.0.0.1:33419/cb"], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }) })).json();
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: u.email, password: u.password }) });
  assert.equal(login.status, 200);
  const csrf = (await login.json()).csrfToken, cookie = login.headers.getSetCookie().map(s => s.split(";")[0]).join("; ");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const params = { response_type: "code", client_id: reg.client_id, redirect_uri: "http://127.0.0.1:33419/cb",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource, scope: "mcp:tools", state: "s" };
  const grant = await fetch(base + "/oauth/authorize", { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, csrf_token: csrf, decision: "allow" }) });
  const code = new URL(grant.headers.get("location")).searchParams.get("code");
  const tok = await (await fetch(base + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: reg.client_id, code, redirect_uri: params.redirect_uri, code_verifier: verifier, resource }) })).json();
  assert.match(tok.access_token, /^wrco_/);
  return tok.access_token;
}
let id = 0;
async function rpc(accessToken, method, params) {
  const r = await fetch(resource, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }) });
  assert.equal(r.status, 200);
  return r.json();
}
async function call(accessToken, name, args) {
  const r = await rpc(accessToken, "tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

try {
  const org = (await db.query("insert into organizations(name) values('RBAC matrix') returning id")).rows[0].id;
  created.push(org);
  const device = (await db.query(
    "insert into devices(id,organization_id,name,hostname,platform,token_hash) values($1,$2,'rbac-device','rbac-host','linux',$3) returning id",
    [crypto.randomUUID(), org, crypto.randomBytes(32).toString("hex")])).rows[0].id;
  const viewer = await token(await user(org, "viewer"));
  const operator = await token(await user(org, "operator"));

  const { tools } = (await rpc(viewer, "tools/list")).result;
  // Tools handled by the gateway itself (not AgentActions) have no risk class.
  const gatewayOnly = new Set(["devices_list", "get_recent_tool_calls", "get_usage_stats", "start_search", "get_more_search_results", "list_searches", "stop_search", "pause_search", "resume_search"]);
  const guarded = [];
  for (const t of tools) {
    if (gatewayOnly.has(t.name)) continue;
    let risk;
    try { risk = actionRisk(t.name); } catch { continue; }
    if (risk !== "low") guarded.push([t.name, risk]);
  }
  assert.ok(guarded.length >= 15, `only ${guarded.length} guarded tools found`);

  for (const [name, risk] of guarded) {
    const v = await call(viewer, name, { device_id: device, path: "/tmp/x", command: "id", session_id: "s", task_id: "t", pid: 1, content_base64: "", data_base64: "" });
    assert.equal(v.error, "forbidden", `viewer ${name} (${risk}): ${JSON.stringify(v)}`);
    assert.equal(v.required_role, "operator");
    const o = await call(operator, name, { device_id: device, path: "/tmp/x", command: "id", session_id: "s", task_id: "t", pid: 1, content_base64: "", data_base64: "" });
    assert.notEqual(o.error, "forbidden", `operator must not be role-denied for ${name}`);
  }
  const denied = await db.query(
    "select tool from audit_logs where device_id=$1 and outcome='denied' and detail='role_operator_required'", [device]);
  const deniedTools = new Set(denied.rows.map(r => r.tool));
  for (const [name] of guarded) assert.ok(deniedTools.has(name), `viewer denial of ${name} not audited`);
  console.log(`rbac-matrix-e2e: ${guarded.length} medium/high tools refused for viewer and audited; operator not role-denied`);
  console.log("rbac-matrix-e2e: ok");
} finally {
  for (const org of created) {
    try { await db.query("delete from organizations where id=$1", [org]); } catch {}
  }
  await db.end();
}
