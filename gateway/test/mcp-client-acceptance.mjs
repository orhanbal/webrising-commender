// MCP client acceptance: an AI client -> WECOMMANDER Gateway -> real Rust Agent.
//
// Identities are separated the way a real deployment separates them:
//   * the AI client holds only an OAuth 2.1/PKCE MCP access token of an
//     `operator` user (what Claude/ChatGPT obtain through the connector flow);
//   * a different `admin` user approves HIGH-risk operations from a browser
//     session; the AI token cannot reach the approval API;
//   * a user of another organization must not see or reach the device.
// The client speaks MCP Streamable HTTP as a conforming client does (Accept
// header, MCP-Protocol-Version after initialize, notification -> 202,
// event-stream GET/DELETE -> 405).
//
// Requires: running gateway with MCP_OAUTH_ENABLED=true, DATABASE_URL,
// built gateway dist/, Rust Agent binary (AGENT_BINARY or target/debug).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hashPassword } from "../dist/browser-auth.js";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const resource = base + "/mcp";
const PROTOCOL = "2025-06-18";
const here = path.dirname(fileURLToPath(import.meta.url));
const agentBinary = process.env.AGENT_BINARY
  || path.join(here, "../..", "target", "debug", process.platform === "win32" ? "webrising-commender.exe" : "webrising-commender");

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc-mcp-client-"));
const allowedRoot = path.join(tempRoot, "allowed");
const outsideDir = path.join(tempRoot, "outside");
fs.mkdirSync(path.join(allowedRoot, "projects"), { recursive: true });
fs.mkdirSync(outsideDir);
const SECRET = "TOP-SECRET-" + crypto.randomUUID();
fs.writeFileSync(path.join(allowedRoot, "projects", "readme.txt"), "hello from the allowed root\n");
fs.writeFileSync(path.join(outsideDir, "secret.txt"), SECRET + "\n");
let agent, agentLog = "";
const createdOrgs = [];
const step = msg => console.log(`mcp-client-acceptance: ${msg}`);

async function createUser(orgId, role) {
  const email = `mcp-acceptance-${role}-${crypto.randomUUID()}@example.test`;
  const password = "mcp-acceptance-password-2026";
  const user = await db.query(
    "insert into users(email,password_hash,email_verified_at) values($1,$2,now()) returning id",
    [email, await hashPassword(password)]);
  await db.query("insert into organization_members(organization_id,user_id,role) values($1,$2,$3)", [orgId, user.rows[0].id, role]);
  return { email, password, id: user.rows[0].id };
}
async function login(u) {
  const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: u.email, password: u.password }) });
  assert.equal(r.status, 200, "login");
  const body = await r.json();
  return { cookie: r.headers.getSetCookie().map(s => s.split(";")[0]).join("; "), csrf: body.csrfToken };
}
function sessionFetch(s, route, method = "GET", body) {
  return fetch(base + route, { method, headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function oauthToken(u) {
  const reg = await fetch(base + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    client_name: "MCP client acceptance", redirect_uris: ["http://127.0.0.1:33418/callback"],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
  assert.equal(reg.status, 201, "dynamic client registration");
  const client = await reg.json();
  const s = await login(u);
  const verifier = crypto.randomBytes(48).toString("base64url");
  const params = { response_type: "code", client_id: client.client_id, redirect_uri: "http://127.0.0.1:33418/callback",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    resource, scope: "mcp:tools", state: crypto.randomUUID() };
  const grant = await fetch(base + "/oauth/authorize", { method: "POST", redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, csrf_token: s.csrf, decision: "allow" }) });
  assert.equal(grant.status, 302, "consent grant");
  const code = new URL(grant.headers.get("location")).searchParams.get("code");
  const tok = await fetch(base + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: params.redirect_uri, code_verifier: verifier, resource }) });
  assert.equal(tok.status, 200, "token exchange");
  return (await tok.json()).access_token;
}

// A minimal conforming Streamable HTTP MCP client.
class McpClient {
  constructor(token) { this.token = token; this.id = 0; this.protocol = null; }
  headers() {
    return { authorization: `Bearer ${this.token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
      ...(this.protocol ? { "mcp-protocol-version": this.protocol } : {}) };
  }
  async post(message) {
    return fetch(resource, { method: "POST", headers: this.headers(), body: JSON.stringify(message) });
  }
  async request(method, params) {
    const r = await this.post({ jsonrpc: "2.0", id: ++this.id, method, ...(params ? { params } : {}) });
    assert.equal(r.status, 200, `${method} HTTP ${r.status}`);
    assert.match(r.headers.get("content-type") || "", /application\/json/);
    const body = await r.json();
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, this.id);
    return body;
  }
  async initialize() {
    const r = await this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "wecommander-acceptance", version: "1" } });
    assert.equal(r.result.protocolVersion, PROTOCOL);
    assert.ok(r.result.capabilities.tools, "tools capability");
    assert.equal(typeof r.result.serverInfo.name, "string");
    this.protocol = r.result.protocolVersion;
    const note = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.status, 202, "initialized notification must be accepted with 202");
    return r.result;
  }
  async call(name, args) {
    const r = await this.request("tools/call", { name, arguments: args });
    assert.ok(r.result && Array.isArray(r.result.content), `${name} returns MCP content`);
    const text = r.result.content.find(c => c.type === "text")?.text ?? "";
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { isError: r.result.isError === true, data, text };
  }
}

try {
  const org = (await db.query("insert into organizations(name) values('MCP client acceptance') returning id")).rows[0].id;
  const otherOrg = (await db.query("insert into organizations(name) values('MCP client acceptance (other tenant)') returning id")).rows[0].id;
  createdOrgs.push(org, otherOrg);
  const operator = await createUser(org, "operator");
  const admin = await createUser(org, "admin");
  const stranger = await createUser(otherOrg, "owner");
  const adminSession = await login(admin);

  // Pair a real Rust Agent into the organization with one allowed root.
  const pairing = await sessionFetch(adminSession, "/api/pairing", "POST", {});
  assert.equal(pairing.status, 201, "pairing code");
  const configPath = path.join(tempRoot, "agent.json");
  const enroll = spawnSync(agentBinary, ["--config", configPath, "enroll", "--control-url", base,
    "--pairing-code", (await pairing.json()).pairingCode, "--allowed-root", allowedRoot], { encoding: "utf8" });
  assert.equal(enroll.status, 0, `agent enrollment: ${enroll.stderr || enroll.stdout}`);
  const deviceId = JSON.parse(fs.readFileSync(configPath, "utf8")).deviceId;
  agent = spawn(agentBinary, ["--config", configPath, "run"], { stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: "info", XDG_DATA_HOME: path.join(tempRoot, "xdg") } });
  agent.stdout.on("data", d => { agentLog += d; });
  agent.stderr.on("data", d => { agentLog += d; });

  const aiToken = await oauthToken(operator);
  const ai = new McpClient(aiToken);

  // 1. Transport and initialize.
  const unauth = await fetch(resource, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get("www-authenticate") || "", /resource_metadata=/);
  await ai.initialize();
  for (const method of ["GET", "DELETE", "PUT", "PATCH"]) {
    const r = await fetch(resource, { method, headers: { authorization: `Bearer ${aiToken}`, accept: "text/event-stream" } });
    assert.equal(r.status, 405, `${method} /mcp must be 405`);
    assert.equal(r.headers.get("allow"), "POST");
  }
  // Unauthenticated transport probes get the OAuth challenge, not a 405.
  const anonSse = await fetch(resource, { headers: { accept: "text/event-stream" } });
  assert.equal(anonSse.status, 401, "unauthenticated event-stream GET must be challenged");
  assert.match(anonSse.headers.get("www-authenticate") || "", /resource_metadata=/);
  // Browser navigation to the /mcp dashboard page is unaffected.
  const page = await fetch(resource, { headers: { accept: "text/html" } });
  assert.notEqual(page.status, 405);
  assert.notEqual(page.status, 401);
  // Unsupported negotiated protocol version is rejected.
  const badVersion = await fetch(resource, { method: "POST", headers: { ...ai.headers(), "mcp-protocol-version": "1999-01-01" }, body: '{"jsonrpc":"2.0","id":99,"method":"ping"}' });
  assert.equal(badVersion.status, 400);
  assert.equal((await ai.request("ping")).error, undefined);
  const unknownMethod = await ai.request("resources/list");
  assert.equal(unknownMethod.error?.code, -32601);
  step("initialize, initialized->202, ping, 401 challenge (also for SSE GET), non-POST 405, browser page kept, bad MCP-Protocol-Version 400, -32601 PASSED");

  // 2. Tool schemas.
  const { tools } = (await ai.request("tools/list")).result;
  assert.ok(tools.length >= 40, `tool count ${tools.length}`);
  assert.equal(new Set(tools.map(t => t.name)).size, tools.length, "unique tool names");
  for (const t of tools) {
    assert.match(t.name, /^[a-z][a-z0-9_]{0,63}$/, `tool name ${t.name}`);
    assert.ok(t.description && t.description.length > 10, `${t.name} description`);
    assert.equal(t.inputSchema?.type, "object", `${t.name} inputSchema.type`);
    const props = t.inputSchema.properties || {};
    for (const r of t.inputSchema.required || []) assert.ok(r in props, `${t.name} requires undeclared ${r}`);
    for (const [k, v] of Object.entries(props)) assert.ok(v && typeof v === "object" && (v.type || v.enum || v.anyOf || v.oneOf), `${t.name}.${k} schema`);
  }
  for (const t of tools.filter(t => /HIGH risk/i.test(t.description))) assert.ok("approval_token" in (t.inputSchema.properties || {}), `${t.name} exposes approval_token`);
  step(`tools/list ${tools.length} tools, schemas valid PASSED`);

  // 3. Device discovery and read-only operations.
  const devices = await (async () => {
    for (let i = 0; i < 100; i++) {
      const d = (await ai.call("devices_list", {})).data;
      if (Array.isArray(d) && d.some(x => x.id === deviceId && x.online)) return d;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error("agent never came online: " + agentLog.slice(-2000));
  })();
  assert.equal(devices.length, 1, "only this organization's device");
  const sys = await ai.call("system_info", { device_id: deviceId });
  assert.equal(sys.isError, false);
  assert.equal(typeof sys.data.os, "string");
  const listed = await ai.call("fs_list", { device_id: deviceId, path: path.join(allowedRoot, "projects") });
  assert.deepEqual(listed.data.items.map(i => i.name), ["readme.txt"]);
  const read = await ai.call("fs_read", { device_id: deviceId, path: path.join(allowedRoot, "projects", "readme.txt") });
  assert.equal(read.data.content, "hello from the allowed root\n");
  step("devices_list, system_info, fs_list, fs_read inside allowed root PASSED");

  // 4. Unauthorized file access is refused without leaking content.
  for (const [name, args] of [
    ["fs_read", { path: path.join(outsideDir, "secret.txt") }],
    ["fs_list", { path: outsideDir }],
    ["fs_read", { path: path.join(allowedRoot, "..", "outside", "secret.txt") }],
    ["fs_write", { path: path.join(outsideDir, "planted.txt"), content_base64: Buffer.from("planted").toString("base64") }],
  ]) {
    const r = await ai.call(name, { device_id: deviceId, ...args });
    assert.equal(r.isError, true, `${name} ${args.path} must fail`);
    assert.match(String(r.data.error), /outside configured allowed roots/, `${name} must be refused by the allowed-root policy, got ${r.text}`);
    assert.ok(!r.text.includes(SECRET), "secret must not leak");
  }
  // Positive control: the same write inside the root succeeds, so the refusal above is the policy.
  const okWrite = await ai.call("fs_write", { device_id: deviceId, path: path.join(allowedRoot, "projects", "written.txt"), content_base64: Buffer.from("inside").toString("base64") });
  assert.equal(okWrite.isError, false, okWrite.text);
  assert.equal(fs.readFileSync(path.join(allowedRoot, "projects", "written.txt"), "utf8"), "inside");
  assert.ok(!fs.existsSync(path.join(outsideDir, "planted.txt")));
  step("outside-root read/list/traversal/write refused by policy, inside write allowed, no leak PASSED");

  // 5. HIGH risk: approval required; AI cannot approve; deny blocks; approve allows once.
  const pending = async (name, args) => {
    const r = await ai.call(name, { device_id: deviceId, ...args });
    assert.equal(r.isError, true, `${name} must not run without approval`);
    assert.equal(r.data.error, "approval_required");
    assert.match(r.data.approval_request_id, /^[0-9a-f-]{36}$/);
    return r.data.approval_request_id;
  };
  const catId = await pending("process_exec", { command: `cat ${path.join(outsideDir, "secret.txt")}` });
  const aiApprove = await fetch(`${base}/api/approval-requests/${catId}/approve`, { method: "POST", headers: { authorization: `Bearer ${aiToken}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(aiApprove.status, 401, "the AI's MCP token must not reach the approval API");
  const forged = await ai.call("process_exec", { device_id: deviceId, command: `cat ${path.join(outsideDir, "secret.txt")}`, approval_token: "forged.token.value" });
  assert.equal(forged.isError, true);
  assert.ok(!forged.text.includes(SECRET));
  assert.equal((await sessionFetch(adminSession, `/api/approval-requests/${catId}/deny`, "POST", {})).status, 200);
  const afterDeny = await ai.call("process_exec", { device_id: deviceId, command: `cat ${path.join(outsideDir, "secret.txt")}` });
  assert.equal(afterDeny.data.error, "approval_required", "denied operation stays blocked");
  assert.ok(!afterDeny.text.includes(SECRET));
  step("HIGH-risk without approval, AI self-approval (401), forged token, admin deny PASSED");

  const unameId = await pending("process_exec", { command: "uname -s" });
  assert.equal((await sessionFetch(adminSession, `/api/approval-requests/${unameId}/approve`, "POST", {})).status, 200);
  const other = await ai.call("process_exec", { device_id: deviceId, command: "uname -a" });
  assert.equal(other.data.error, "approval_required", "approval is bound to the exact command");
  const ran = await ai.call("process_exec", { device_id: deviceId, command: "uname -s" });
  assert.equal(ran.isError, false, ran.text);
  assert.equal(ran.data.exitCode, 0);
  assert.equal(ran.data.stdout.trim(), os.type() === "Darwin" ? "Darwin" : "Linux");
  const replay = await ai.call("process_exec", { device_id: deviceId, command: "uname -s" });
  assert.equal(replay.data.error, "approval_required", "an approval is consumed once");
  step("approved exact command ran once; different command and replay blocked PASSED");

  // 6. Long task survives client disconnect; a new client session reads it back.
  const taskCommand = "for i in 1 2 3; do echo tick $i; sleep 1; done; echo task-finished";
  const taskReq = await pending("task_start", { command: taskCommand, cwd: allowedRoot });
  assert.equal((await sessionFetch(adminSession, `/api/approval-requests/${taskReq}/approve`, "POST", {})).status, 200);
  const started = await ai.call("task_start", { device_id: deviceId, command: taskCommand, cwd: allowedRoot });
  assert.equal(started.isError, false, started.text);
  const taskId = started.data.taskId;
  assert.match(taskId, /^[0-9a-f-]{36}$/);
  const resumed = new McpClient(await oauthToken(operator)); // new OAuth client + new MCP session
  await resumed.initialize();
  let status;
  for (let i = 0; i < 100; i++) {
    status = (await resumed.call("task_status", { device_id: deviceId, task_id: taskId })).data;
    if (status.status !== "running") break;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.equal(status.status, "completed", JSON.stringify(status));
  assert.equal(status.result.exitCode, 0);
  assert.equal(status.result.stdout, "tick 1\ntick 2\ntick 3\ntask-finished\n");
  assert.ok((await resumed.call("task_list", { device_id: deviceId })).data.items.some(t => t.taskId === taskId));
  step("approved task started, disconnected, status recovered from a new client PASSED");

  // 7. Tenant isolation.
  const strangerClient = new McpClient(await oauthToken(stranger));
  await strangerClient.initialize();
  assert.deepEqual((await strangerClient.call("devices_list", {})).data, []);
  for (const [name, args] of [["system_info", {}], ["fs_read", { path: path.join(allowedRoot, "projects", "readme.txt") }]]) {
    const r = await strangerClient.call(name, { device_id: deviceId, ...args });
    assert.equal(r.isError, true, `cross-tenant ${name} must fail`);
    assert.ok(!r.text.includes("hello from the allowed root"));
  }
  step("cross-tenant discovery and access refused PASSED");

  // 8. Audit trail attributes every step to the right identity.
  const audit = await sessionFetch(adminSession, "/api/audit?limit=200");
  assert.equal(audit.status, 200);
  const rows = (await audit.json()).items.filter(r => r.device_id === deviceId);
  const has = (tool, outcome, actor) => rows.some(r => r.tool === tool && r.outcome === outcome && (!actor || r.actor === actor));
  const aiActor = rows.find(r => r.tool === "fs_read" && r.outcome === "success")?.actor;
  assert.ok(aiActor, "AI tool calls are audited");
  assert.notEqual(aiActor, `user:${admin.id}`);
  for (const [tool, outcome] of [["fs_read", "error"], ["process_exec", "approval_pending"], ["process_exec", "approval_consumed"],
    ["process_exec", "success"], ["task_start", "approval_consumed"], ["task_start", "success"]])
    assert.ok(has(tool, outcome, aiActor), `audit ${tool}/${outcome} by AI identity`);
  assert.ok(has("approval_request.deny", "success", `user:${admin.id}`), "deny audited as admin");
  assert.ok(has("approval_request.approve", "success", `user:${admin.id}`), "approve audited as admin");
  assert.ok(!JSON.stringify(rows).includes(SECRET), "audit must not contain file secrets");
  assert.ok(!rows.some(r => r.actor && r.actor.includes(stranger.id)), "stranger has no audited access to this device");
  step(`audit: ${rows.length} device events, AI actor ${aiActor}, approvals by admin PASSED`);

  console.log("mcp-client-acceptance: ALL PASSED");
} catch (error) {
  console.error(agentLog.slice(-4000));
  throw error;
} finally {
  if (agent && agent.exitCode === null) {
    const exited = new Promise(resolve => agent.once("exit", resolve));
    agent.kill("SIGTERM");
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  if (createdOrgs.length) {
    try { await db.query("delete from organizations where id = any($1::uuid[])", [createdOrgs]); } catch (error) { console.error(`cleanup: organizations kept (${error.code || error.message})`); }
  }
  await db.end();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
