// Security Gate: isolated negative authorization and approval-boundary checks.
// This is an adversarial regression test, NEVER a production penetration test.
// It deliberately creates ephemeral organizations and fake offline devices.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { hashPassword } from "../dist/browser-auth.js";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const databaseUrl = process.env.DATABASE_URL || "";
const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
if (process.env.SECURITY_GATE_ISOLATED !== "true" ||
    !loopback.has(new URL(base).hostname) ||
    !databaseUrl || !loopback.has(new URL(databaseUrl).hostname)) {
  throw new Error("Security Gate refuses non-isolated targets: set SECURITY_GATE_ISOLATED=true and use localhost gateway + PostgreSQL");
}
if (!process.env.CONTROL_API_KEY) throw new Error("CONTROL_API_KEY is required for fixture approvals");

const db = new pg.Client({ connectionString: databaseUrl });
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const randomToken = () => "wrc_" + crypto.randomBytes(30).toString("base64url");
const orgIds = [], userIds = [];
let rpcId = 0;
let passed = 0;

function check(condition, description) {
  assert.ok(condition, description);
  passed++;
  console.log("PASS " + description);
}
async function request(route, method = "GET", headers = {}, body) {
  return fetch(base + route, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
}
function bearer(token) { return { authorization: "Bearer " + token }; }
async function rpc(token, name, args) {
  const response = await request("/mcp", "POST",
    { ...bearer(token), accept: "application/json, text/event-stream" },
    { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
  assert.equal(response.status, 200, "MCP " + name + " HTTP status");
  const payload = await response.json();
  assert.ok(payload.result?.content?.[0]?.text, "MCP " + name + " should return tool content");
  return JSON.parse(payload.result.content[0].text);
}
async function fixture(name) {
  const org = (await db.query(
    "insert into organizations(name) values($1) returning id",
    ["Security Gate " + name + " " + crypto.randomUUID()])).rows[0].id;
  orgIds.push(org);
  const password = "security-gate-" + crypto.randomBytes(20).toString("hex");
  const email = "security-gate-" + crypto.randomUUID() + "@example.test";
  const user = (await db.query(
    "insert into users(email,password_hash,email_verified_at) values($1,$2,now()) returning id",
    [email, await hashPassword(password)])).rows[0].id;
  userIds.push(user);
  await db.query(
    "insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",
    [org, user]);
  const token = randomToken();
  await db.query(
    "insert into api_tokens(organization_id,name,role,token_hash,created_by) values($1,$2,'owner',$3,$4)",
    [org, "security-gate-owner", sha256(token), "user:" + user]);
  const device = crypto.randomUUID();
  await db.query(
    "insert into devices(id,organization_id,name,hostname,platform,token_hash) values($1,$2,$3,'test-host','linux',$4)",
    [device, org, "security-gate-" + name, sha256(crypto.randomUUID())]);
  return { org, user, email, password, token, device };
}
async function session(fixtureItem) {
  const response = await request("/api/auth/login", "POST", {},
    { email: fixtureItem.email, password: fixtureItem.password, organizationId: fixtureItem.org });
  assert.equal(response.status, 200, "fixture owner login");
  const body = await response.json();
  const cookie = response.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
  assert.ok(cookie && body.csrfToken, "session cookie and CSRF");
  return { cookie, csrf: body.csrfToken };
}

await db.connect();
try {
  const a = await fixture("A");
  const b = await fixture("B");
  const aSecondDevice = crypto.randomUUID();
  await db.query(
    "insert into devices(id,organization_id,name,hostname,platform,token_hash) values($1,$2,'security-gate-A2','test-host','linux',$3)",
    [aSecondDevice, a.org, sha256(crypto.randomUUID())]);

  check((await request("/api/devices")).status === 401, "REST refuses anonymous device access");
  check((await request("/api/devices", "GET", bearer("invalid-token"))).status === 401,
    "REST refuses fake token");
  check((await request("/mcp", "POST", { accept: "application/json" },
    { jsonrpc: "2.0", id: 1, method: "tools/list" })).status === 401,
    "MCP refuses anonymous tool discovery");

  const aDevices = await (await request("/api/devices", "GET", bearer(a.token))).json();
  const bDevices = await (await request("/api/devices", "GET", bearer(b.token))).json();
  check(aDevices.items.some((d) => d.id === a.device) &&
    !aDevices.items.some((d) => d.id === b.device) &&
    bDevices.items.some((d) => d.id === b.device) &&
    !bDevices.items.some((d) => d.id === a.device), "REST device lists are tenant-scoped");

  const aTargets = await rpc(a.token, "targets_list", {});
  check(aTargets.targets.some((d) => d.target_id === a.device) &&
    !aTargets.targets.some((d) => d.target_id === b.device), "MCP target discovery is tenant-scoped");

  const aReadsB = await rpc(a.token, "fs_read", { device_id: b.device, path: "/tmp/secret" });
  const bExecA = await rpc(b.token, "process_exec", { device_id: a.device, command: "id" });
  check(aReadsB.error === "device_not_found" && bExecA.error === "device_not_found",
    "cross-tenant MCP read/exec denied before dispatch");

  check((await request("/api/devices/" + b.device + "/command-allowlist", "GET", bearer(a.token))).status === 404,
    "foreign device's command allowlist is inaccessible");

  const sess = await session(a);
  check((await request("/api/devices/" + b.device + "/trust", "PUT",
    { cookie: sess.cookie, "x-csrf-token": sess.csrf }, { level: "standard" })).status === 404,
    "foreign device cannot be modified using an authenticated browser session");
  check((await request("/api/devices/" + a.device + "/trust", "PUT",
    { cookie: sess.cookie }, { level: "standard" })).status === 403,
    "browser mutation without CSRF refused");

  const ownerToken = bearer(a.token);
  check((await request("/api/devices/" + a.device + "/trust", "PUT",
    ownerToken, { level: "full" })).status === 403,
    "API token cannot enable full trust");
  check((await request("/api/devices/" + a.device + "/run-as", "PUT",
    ownerToken, { runAs: "root" })).status === 403,
    "API token cannot enable root");
  check((await request("/api/trust/autonomy", "POST",
    ownerToken, { enable: true, minutes: 5 })).status === 403,
    "API token cannot enable autonomous mode");
  check((await request("/api/devices/" + a.device + "/command-allowlist", "POST",
    ownerToken, { pattern: "id" })).status === 403,
    "API token cannot widen command allowlist");

  const action = { kind: "process_exec", command: "printf gate", cwd: "/tmp" };
  const approvalResponse = await request("/api/approvals", "POST",
    ownerToken, { deviceId: a.device, action, ttlSeconds: 60 });
  assert.equal(approvalResponse.status, 201, "approval fixture is issuable only for isolated device");
  const approval = (await approvalResponse.json()).approvalToken;
  assert.ok(approval, "fixture approval token");
  const changedCommand = await rpc(a.token, "process_exec",
    { device_id: a.device, command: "printf changed", cwd: "/tmp", approval_token: approval });
  check(changedCommand.error === "approval_required",
    "approval cannot authorize modified command parameters");
  const otherDevice = await rpc(a.token, "process_exec",
    { device_id: aSecondDevice, command: "printf gate", cwd: "/tmp", approval_token: approval });
  check(otherDevice.error === "approval_required",
    "approval cannot authorize another device in same tenant");
  const forged = await rpc(a.token, "process_exec",
    { device_id: a.device, command: "printf gate", cwd: "/tmp", approval_token: "forged.approval.token" });
  check(forged.error === "approval_required", "forged approval token is refused");

  const viewerToken = randomToken();
  await db.query(
    "insert into api_tokens(organization_id,name,role,token_hash,created_by) values($1,'security-gate-viewer','viewer',$2,$3)",
    [a.org, sha256(viewerToken), "user:" + a.user]);
  const viewerExec = await rpc(viewerToken, "process_exec", { device_id: a.device, command: "id" });
  check(viewerExec.error === "forbidden", "viewer cannot invoke critical commands");

  const audit = await db.query(
    "select count(*)::int as n from audit_logs where organization_id=$1 and device_id=$2 and tool='process_exec' and outcome='denied' and detail='missing_or_invalid_approval'",
    [a.org, a.device]);
  check(audit.rows[0].n >= 2, "rejected forged/mismatched approvals are audited");

  console.log("Security Gate boundaries: " + passed + " adversarial assertions passed");
} finally {
  for (const id of orgIds.reverse()) {
    try { await db.query("delete from organizations where id=$1", [id]); }
    catch (error) { console.error("Security Gate organization cleanup failed:", error.message); process.exitCode = 1; }
  }
  for (const id of userIds.reverse()) {
    try { await db.query("delete from users where id=$1", [id]); }
    catch (error) { console.error("Security Gate user cleanup failed:", error.message); process.exitCode = 1; }
  }
  await db.end();
}
