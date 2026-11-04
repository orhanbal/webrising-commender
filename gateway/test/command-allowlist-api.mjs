// Command allowlist REST rules and approval e-mail notification against a
// running gateway (TEST_BASE_URL) and its PostgreSQL (DATABASE_URL).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { hashPassword } from "../dist/browser-auth.js";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const suffix = crypto.randomBytes(4).toString("hex");
const password = "allowlist-acceptance-" + suffix;

const org = (await db.query("insert into organizations(name) values($1) returning id", ["allowlist " + suffix])).rows[0].id;
async function user(role) {
  const email = `allow-${role}-${suffix}@example.test`;
  const id = (await db.query("insert into users(email,password_hash,email_verified_at) values($1,$2,now()) returning id",
    [email, await hashPassword(password)])).rows[0].id;
  await db.query("insert into organization_members(organization_id,user_id,role) values($1,$2,$3)", [org, id, role]);
  return email;
}
const ownerEmail = await user("owner");
const viewerEmail = await user("viewer");
const device = crypto.randomUUID();
await db.query("insert into devices(id,organization_id,name,token_hash) values($1,$2,'allowlist-device',$3)",
  [device, org, sha256(crypto.randomUUID())]);
const apiToken = "wrc_" + crypto.randomBytes(30).toString("base64url");
await db.query("insert into api_tokens(organization_id,name,role,token_hash,created_by) values($1,'allowlist','owner',$2,'test')",
  [org, sha256(apiToken)]);

async function login(email) {
  const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, organizationId: org }) });
  assert.equal(r.status, 200);
  const body = await r.json();
  return { Cookie: r.headers.getSetCookie().map((v) => v.split(";")[0]).join("; "), "X-CSRF-Token": body.csrfToken, "content-type": "application/json" };
}
const owner = await login(ownerEmail);
const viewer = await login(viewerEmail);
const route = `/api/devices/${device}/command-allowlist`;
const add = (headers, pattern) => fetch(base + route, { method: "POST", headers, body: JSON.stringify({ pattern }) });

try {
  assert.equal((await add(viewer, "df -h")).status, 403, "viewers cannot change the allowlist");
  const tokenAdd = await add({ authorization: "Bearer " + apiToken, "content-type": "application/json" }, "df -h");
  assert.equal(tokenAdd.status, 403, "API tokens (and AI clients) cannot widen the allowlist");
  assert.equal((await add({ Cookie: owner.Cookie, "content-type": "application/json" }, "df -h")).status, 403, "CSRF required");
  for (const bad of ["bash", "sudo ls", "docker", "df -h; rm -rf /", "rm -rf", "python3 -c", "ls *"]) {
    const r = await add(owner, bad);
    assert.equal(r.status, 400, bad);
    assert.equal((await r.json()).error, "pattern_not_allowed");
  }
  const created = await add(owner, "  df   -h ");
  assert.equal(created.status, 201);
  const entry = (await created.json()).item;
  assert.equal(entry.pattern, "df -h", "patterns are normalised");
  assert.equal((await add(owner, "df -h")).status, 409, "duplicates are refused");
  const listed = await (await fetch(base + route, { headers: owner })).json();
  assert.deepEqual(listed.items.map((x) => x.pattern), ["df -h"]);
  const otherDevice = await fetch(base + `/api/devices/${crypto.randomUUID()}/command-allowlist`, { headers: owner });
  assert.equal(otherDevice.status, 404);
  const audit = await db.query("select count(*)::int as n from audit_logs where organization_id=$1 and tool='command_allowlist.add'", [org]);
  assert.equal(audit.rows[0].n, 1);
  assert.equal((await fetch(base + route + "/" + entry.id, { method: "DELETE", headers: owner })).status, 200);
  assert.equal((await fetch(base + route + "/" + entry.id, { method: "DELETE", headers: owner })).status, 404);

  // Approval notification: a new HIGH-risk request mails admins/owners once.
  const mails = async () => (await db.query("select count(*)::int as n from mail_outbox where recipient_hash=$1",
    [sha256(ownerEmail.toLowerCase())])).rows[0].n;
  const viewerMails = async () => (await db.query("select count(*)::int as n from mail_outbox where recipient_hash=$1",
    [sha256(viewerEmail.toLowerCase())])).rows[0].n;
  const beforeMails = await mails();
  const exec = async () => (await (await fetch(base + "/mcp", {
    method: "POST", headers: { authorization: "Bearer " + apiToken, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "process_exec", arguments: { device_id: device, command: "id" } } }),
  })).json());
  const first = JSON.parse((await exec()).result.content[0].text);
  assert.equal(first.error, "approval_required");
  let after = beforeMails;
  for (let i = 0; i < 40 && after === beforeMails; i++) { await new Promise((r) => setTimeout(r, 100)); after = await mails(); }
  assert.equal(after, beforeMails + 1, "owner is e-mailed about the pending approval");
  const second = JSON.parse((await exec()).result.content[0].text);
  assert.equal(second.approval_request_id, first.approval_request_id, "identical pending request is reused");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await mails(), beforeMails + 1, "no second mail for the same pending request");
  assert.equal(await viewerMails(), 0, "viewers are not notified");
  // Trust levels: only an admin browser session; "full" needs the password,
  // mails admins, and skips per-call approval until it expires.
  const trust = (headers, body) => fetch(base + `/api/devices/${device}/trust`, { method: "PUT", headers, body: JSON.stringify(body) });
  assert.equal((await trust(viewer, { level: "full", currentPassword: password })).status, 403, "viewer");
  assert.equal((await trust({ authorization: "Bearer " + apiToken, "content-type": "application/json" }, { level: "full" })).status, 403, "API token");
  assert.equal((await trust(owner, { level: "full" })).status, 403, "full needs the password");
  assert.equal((await trust(owner, { level: "full", currentPassword: "wrong-password-0000" })).status, 403);
  assert.equal((await trust(owner, { level: "bogus" })).status, 400);
  const mailsBeforeTrust = await mails();
  const fullRes = await trust(owner, { level: "full", minutes: 60, currentPassword: password });
  assert.equal(fullRes.status, 200);
  const full = (await fullRes.json()).item;
  assert.equal(full.trust_level, "full");
  assert.ok(new Date(full.trust_full_until) > new Date());
  for (let i = 0; i < 40 && (await mails()) === mailsBeforeTrust; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await mails(), mailsBeforeTrust + 1, "owner is e-mailed when full trust is enabled");
  const callExec = async (command) => JSON.parse((await (await fetch(base + "/mcp", {
    method: "POST", headers: { authorization: "Bearer " + apiToken, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "process_exec", arguments: { device_id: device, command } } }),
  })).json()).result.content[0].text);
  const trusted = await callExec("id -u");
  assert.notEqual(trusted.error, "approval_required", "full trust skips per-call approval (device is offline here)");
  const trustedAudit = await db.query("select count(*)::int as n from audit_logs where device_id=$1 and outcome='trusted_full'", [device]);
  assert.equal(trustedAudit.rows[0].n, 1);
  await db.query("update devices set trust_full_until=now()-interval '1 second' where id=$1", [device]);
  assert.equal((await callExec("id -g")).error, "approval_required", "expired full trust falls back to standard");
  const listedDevices = await (await fetch(base + "/api/devices", { headers: owner })).json();
  assert.equal(listedDevices.items.find((d) => d.id === device).trust_level, "standard");
  // strict ignores the allowlist
  assert.equal((await add(owner, "uname -s")).status, 201);
  assert.equal((await trust(owner, { level: "strict" })).status, 200);
  assert.equal((await callExec("uname -s")).error, "approval_required", "strict ignores the allowlist");
  const trustAudit = await db.query("select count(*)::int as n from audit_logs where device_id=$1 and tool='device.trust_level'", [device]);
  assert.equal(trustAudit.rows[0].n, 2);
  // Device deletion: only revoked devices, only from an admin browser session; audit kept.
  const delRoute = base + `/api/devices/${device}`;
  assert.equal((await fetch(delRoute, { method: "DELETE", headers: owner })).status, 409, "revoke before delete");
  assert.equal((await fetch(delRoute, { method: "DELETE", headers: { authorization: "Bearer " + apiToken } })).status, 403);
  assert.equal((await fetch(base + `/api/devices/${device}/revoke`, { method: "POST", headers: owner, body: "{}" })).status, 200);
  assert.equal((await fetch(delRoute, { method: "DELETE", headers: viewer })).status, 403, "viewer");
  assert.equal((await fetch(delRoute, { method: "DELETE", headers: owner })).status, 200);
  assert.equal((await db.query("select 1 from devices where id=$1", [device])).rowCount, 0);
  assert.ok((await db.query("select count(*)::int n from audit_logs where device_id=$1", [device])).rows[0].n > 0, "audit history kept");
  console.log("command allowlist API + approval notification acceptance passed");
} finally {
  await db.end();
}
