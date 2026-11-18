// Hybrid Access H3/H4 end to end (docs/HYBRID_ACCESS.md §5): a remote MCP
// client reaches a saved SSH host through a fake desktop app (Center token)
// that publishes its shared hosts, long-polls for calls and answers them the
// way wecommander-core's mcp.remoteCall does. Covers targets_list, personal
// scoping, reads without approval, approvals bound to the exact call (single
// use, owner only), readonly, unsupported tools, offline computers (fail
// closed, approval given back) and the audit log. Starts its own gateway
// (spare port) against DATABASE_URL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.SSH_CONNECTOR_E2E_PORT || 8797);
const base = `http://127.0.0.1:${port}`;
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gateway = spawn(process.execPath, [path.join(here, "../dist/index.js")], {
  env: {
    ...process.env, PORT: String(port), HOST: "127.0.0.1", PUBLIC_BASE_URL: base,
    DEPLOYMENT_MODE: "self_hosted", SCHEDULED_TASKS_DISABLED: "true", CONNECTOR_CLAIM_WITHIN_MS: "2000",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

async function http(token, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { authorization: "Bearer " + token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
let rpcId = 0;
async function rpc(token, method, params) {
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  assert.equal(r.status, 200);
  return r.json();
}
async function tool(token, name, args) {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? "";
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { isError: r.result?.isError === true, data };
}

// The fake app: publishes, claims and answers like wecommander-core.
const app = { running: false, seen: [], answer: null, loop: null };
function startApp(centerToken) {
  app.running = true;
  app.loop = (async () => {
    while (app.running) {
      const claim = await http(centerToken, "GET", "/api/center/connector/claim?waitMs=500");
      assert.equal(claim.status, 200, JSON.stringify(claim.body));
      for (const call of claim.body.items) {
        app.seen.push(call);
        const reply = app.answer(call);
        const posted = await http(centerToken, "POST", `/api/center/connector/calls/${call.id}/result`, reply);
        assert.equal(posted.status, 200, JSON.stringify(posted.body));
      }
    }
  })();
}
async function stopApp() {
  app.running = false;
  await app.loop;
}

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/health/live")).ok) break; } catch {} await sleep(250); }
  await db.connect();
  const suffix = crypto.randomBytes(4).toString("hex");
  const org = (await db.query("insert into organizations(name) values($1) returning id", ["ssh connector " + suffix])).rows[0].id;
  const user = async (role) => {
    const id = (await db.query("insert into users(email,password_hash,email_verified_at) values($1,'x',now()) returning id",
      [`${role}-${suffix}@example.test`])).rows[0].id;
    await db.query("insert into organization_members(organization_id,user_id,role) values($1,$2,$3)", [org, id, role]);
    return id;
  };
  const token = async (role, userId) => {
    const t = "wrc_" + crypto.randomBytes(30).toString("base64url");
    await db.query("insert into api_tokens(organization_id,name,role,token_hash,created_by) values($1,$2,$3,$4,$5)",
      [org, role, role, sha256(t), "user:" + userId]);
    return t;
  };
  const center = async (userId, name) => {
    const t = "wmc_" + crypto.randomBytes(30).toString("base64url");
    const id = (await db.query("insert into management_centers(organization_id,user_id,name,token_hash,platform) values($1,$2,$3,$4,'windows') returning id",
      [org, userId, name, sha256(t)])).rows[0].id;
    return { id, token: t };
  };
  const ownerId = await user("owner");
  const otherId = await user("admin");
  const owner = await token("owner", ownerId);
  const viewer = await token("viewer", ownerId);
  const otherAdmin = await token("admin", otherId);
  const pc = await center(ownerId, "Ayşe's PC");
  const otherPc = await center(otherId, "Other PC");

  // Publishing: Center tokens only, validated.
  const targets = [
    { hostId: "host-1", name: "web-1", preset: "approval", sudo: "never" },
    { hostId: "host-ro", name: "ro-1", preset: "readonly", sudo: "never" },
  ];
  assert.equal((await http(owner, "PUT", "/api/center/connector/targets", { targets })).status, 403);
  assert.equal((await http(pc.token, "PUT", "/api/center/connector/targets", { targets: [{ hostId: "", name: "x", preset: "approval" }] })).status, 400);
  assert.equal((await http(pc.token, "PUT", "/api/center/connector/targets", { targets: [{ hostId: "a", name: "x", preset: "yolo" }] })).status, 400);
  const published = await http(pc.token, "PUT", "/api/center/connector/targets", { targets });
  assert.equal(published.status, 200);
  const web = published.body.items.find((t) => t.hostId === "host-1").targetId;
  const ro = published.body.items.find((t) => t.hostId === "host-ro").targetId;
  assert.match(web, /^ssh-[0-9a-f]{24}$/);
  assert.equal((await http(otherPc.token, "PUT", "/api/center/connector/targets", { targets: [{ hostId: "host-x", name: "theirs", preset: "approval", sudo: "never" }] })).status, 200);

  // Tool list: targets_list, and SSH-capable tools take target instead of device_id.
  const listed = (await rpc(owner, "tools/list")).result.tools;
  const tl = listed.find((t) => t.name === "targets_list");
  assert.ok(tl && tl.annotations.readOnlyHint === true);
  const fsList = listed.find((t) => t.name === "fs_list");
  assert.equal(fsList.inputSchema.properties.target.type, "string");
  assert.ok(!fsList.inputSchema.required.includes("device_id"));
  assert.ok(listed.find((t) => t.name === "terminal_start").inputSchema.required.includes("device_id"));

  // targets_list: the owner's own SSH targets only, never host ids or addresses.
  let r = await tool(owner, "targets_list", {});
  assert.equal(r.isError, false);
  const ssh = r.data.targets.filter((t) => t.kind === "ssh");
  assert.deepEqual(ssh.map((t) => t.name).sort(), ["ro-1", "web-1"]);
  assert.equal(ssh.find((t) => t.target_id === web).online, true);
  assert.equal(ssh.find((t) => t.target_id === ro).capabilities.exec, false);
  assert.equal(ssh.find((t) => t.target_id === web).capabilities.path_policy, "none");
  assert.ok(!JSON.stringify(r.data).includes("host-1"), "host ids are not shown");
  r = await tool(otherAdmin, "targets_list", {});
  assert.deepEqual(r.data.targets.filter((t) => t.kind === "ssh").map((t) => t.name), ["theirs"]);
  // Someone else's target is not found (same answer as unknown).
  assert.equal((await tool(otherAdmin, "fs_list", { target: web, path: "/" })).data.error, "target_not_found");

  // Reads: no approval, routed to the app with the host id; read size capped.
  app.answer = (call) => call.tool === "fs_read"
    ? { ok: true, result: { path: call.args.path, encoding: "utf8", content: "hello" } }
    : { ok: true, result: { exitCode: 0, output: "ran\npassword=hunter2\n", timedOut: false, truncated: false } };
  startApp(pc.token);
  r = await tool(viewer, "fs_read", { target: web, path: "/etc/hostname", max_bytes: 99_999_999 });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.content, "hello");
  const read = app.seen.at(-1);
  assert.equal(read.hostId, "host-1");
  assert.equal(read.args.target, "host-1");
  assert.equal(read.args.max_bytes, 1024 * 1024);
  assert.equal(read.approved, false);
  // The Desktop Commander alias works on the target too.
  assert.equal((await tool(viewer, "read_file", { target: web, path: "/etc/hostname" })).data.content, "hello");

  // Commands: viewers cannot; operators need the owner's approval of the exact call.
  assert.equal((await tool(viewer, "process_exec", { target: web, command: "uptime" })).data.error, "forbidden");
  const before = app.seen.length;
  r = await tool(owner, "process_exec", { target: web, command: "systemctl restart web", cwd: "/srv" });
  assert.equal(r.data.error, "approval_required", JSON.stringify(r.data));
  const requestId = r.data.approval_request_id;
  assert.equal(app.seen.length, before, "nothing ran before approval");
  // The same call again reuses the pending request.
  assert.equal((await tool(owner, "process_exec", { target: web, command: "systemctl restart web", cwd: "/srv" })).data.approval_request_id, requestId);
  // Listed for the owner (app) with the exact command; device_id stays a string.
  const pending = (await http(pc.token, "GET", "/api/approval-requests")).body.items;
  const item = pending.find((p) => p.id === requestId);
  assert.ok(item, "owner sees the request");
  assert.equal(item.device_id, "");
  assert.equal(item.target_kind, "ssh");
  assert.equal(item.target_label, "web-1");
  assert.equal(item.action.command, "systemctl restart web");
  assert.ok(!(await http(otherPc.token, "GET", "/api/approval-requests")).body.items.some((p) => p.id === requestId),
    "another member does not see it");
  assert.equal((await http(otherPc.token, "POST", `/api/approval-requests/${requestId}/approve`, {})).body.error, "approval_owner_only");
  assert.equal((await http(pc.token, "POST", `/api/approval-requests/${requestId}/approve`, {})).status, 200);
  // One byte changed: not covered.
  r = await tool(owner, "process_exec", { target: web, command: "systemctl restart wed", cwd: "/srv" });
  assert.equal(r.data.error, "approval_required");
  assert.notEqual(r.data.approval_request_id, requestId);
  // Another client (token) cannot use it either.
  const owner2 = await token("owner", ownerId);
  assert.equal((await tool(owner2, "process_exec", { target: web, command: "systemctl restart web", cwd: "/srv" })).data.error, "approval_required");
  // The approved call runs once, output masked.
  r = await tool(owner, "process_exec", { target: web, command: "systemctl restart web", cwd: "/srv" });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.ok(r.data.output.includes("password=[REDACTED]") && !r.data.output.includes("hunter2"));
  const ran = app.seen.at(-1);
  assert.deepEqual([ran.tool, ran.approved, ran.args.command, ran.args.cwd, ran.args.timeout_ms],
    ["process_exec", true, "systemctl restart web", "/srv", 30000]);
  // Replay: needs a new approval.
  r = await tool(owner, "process_exec", { target: web, command: "systemctl restart web", cwd: "/srv" });
  assert.equal(r.data.error, "approval_required");
  assert.notEqual(r.data.approval_request_id, requestId);

  // H4 writes: approval bound to the content's SHA-256; size limit.
  const content = Buffer.from("new config\n").toString("base64");
  r = await tool(owner, "fs_write", { target: web, path: "/srv/app.conf", content_base64: content });
  assert.equal(r.data.error, "approval_required");
  const writeItem = (await http(pc.token, "GET", "/api/approval-requests")).body.items.find((p) => p.id === r.data.approval_request_id);
  assert.equal(writeItem.action.sha256, sha256(Buffer.from("new config\n")));
  assert.equal(writeItem.action.size, 11);
  assert.equal(writeItem.action.content_base64, undefined, "the approval shows the hash, not the content");
  await http(pc.token, "POST", `/api/approval-requests/${r.data.approval_request_id}/approve`, {});
  assert.equal((await tool(owner, "fs_write", { target: web, path: "/srv/app.conf", content_base64: Buffer.from("other").toString("base64") })).data.error,
    "approval_required", "other content, other approval");
  app.answer = (call) => ({ ok: true, result: { path: call.args.path, size: 11 } });
  r = await tool(owner, "fs_write", { target: web, path: "/srv/app.conf", content_base64: content });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(app.seen.at(-1).args.content_base64, content);
  const big = Buffer.alloc(1024 * 1024 + 1).toString("base64");
  assert.equal((await tool(owner, "fs_write", { target: web, path: "/srv/big", content_base64: big })).data.error, "file_too_large");

  // Readonly target and unsupported tools are refused before anything is queued.
  const n = app.seen.length;
  assert.equal((await tool(owner, "process_exec", { target: ro, command: "uptime" })).data.error, "readonly_preset");
  assert.equal((await tool(owner, "fs_delete", { target: ro, path: "/tmp/x" })).data.error, "readonly_preset");
  assert.equal((await tool(owner, "terminal_start", { target: web })).data.error, "unsupported_for_target");
  assert.equal(app.seen.length, n);

  // An error from the computer comes back as a tool error.
  app.answer = () => ({ ok: false, error: "host_key_untrusted", message: "the server's host key is not trusted on this computer" });
  r = await tool(owner, "fs_list", { target: web, path: "/" });
  assert.deepEqual([r.isError, r.data.error], [true, "host_key_untrusted"]);

  // The app stops: an approved change fails closed and its approval is kept.
  r = await tool(owner, "fs_delete", { target: web, path: "/srv/old", recursive: true });
  const deleteRequest = r.data.approval_request_id;
  await http(pc.token, "POST", `/api/approval-requests/${deleteRequest}/approve`, {});
  await stopApp();
  r = await tool(owner, "fs_delete", { target: web, path: "/srv/old", recursive: true });
  assert.equal(r.data.error, "connector_offline", JSON.stringify(r.data));
  assert.match(r.data.message, /Bu sunucuya erişen bilgisayar şu an kapalı/);
  assert.equal((await db.query("select status from approval_requests where id=$1", [deleteRequest])).rows[0].status, "approved");
  // Long gone: refused at once, before any approval is asked.
  await db.query("update management_centers set connector_seen_at=now()-interval '10 minutes' where id=$1", [pc.id]);
  r = await tool(owner, "targets_list", {});
  assert.equal(r.data.targets.find((t) => t.target_id === web).online, false);
  r = await tool(owner, "process_exec", { target: web, command: "uptime" });
  assert.equal(r.data.error, "connector_offline");
  // A result for a call that is not this computer's is refused.
  assert.equal((await http(pc.token, "POST", `/api/center/connector/calls/${crypto.randomUUID()}/result`, { ok: true, result: {} })).status, 404);
  assert.equal((await http(pc.token, "POST", `/api/center/connector/calls/${crypto.randomUUID()}/result`, { ok: "maybe" })).status, 400);
  // Answered calls are not kept (no command text, content or output at rest).
  assert.equal((await db.query("select count(*)::int as n from connector_calls where organization_id=$1", [org])).rows[0].n, 0);

  // Audit: target, tool and decision; never the command or content.
  const audit = (await db.query("select tool,outcome,detail from audit_logs where organization_id=$1 order by id", [org])).rows;
  const execs = audit.filter((a) => a.tool === "process_exec");
  for (const outcome of ["approval_pending", "approval_consumed", "success", "denied"]) {
    assert.ok(execs.some((a) => a.outcome === outcome), `audit ${outcome}`);
  }
  assert.ok(execs.every((a) => !a.detail.includes("systemctl")), "no command text in the audit");
  assert.ok(audit.some((a) => a.tool === "fs_delete" && a.outcome === "error" && JSON.parse(a.detail).reason === "connector_offline"));
  assert.ok(audit.some((a) => a.tool === "approval_request.approve" && JSON.parse(a.detail).target === web));
  assert.ok(audit.filter((a) => a.tool === "fs_write").every((a) => !a.detail.includes(content)));
  assert.ok(audit.some((a) => a.tool === "process_exec" && JSON.parse(a.detail).target === web && JSON.parse(a.detail).targetLabel === "web-1"));

  // Unpublishing removes the target.
  assert.equal((await http(pc.token, "PUT", "/api/center/connector/targets", { targets: [] })).status, 200);
  assert.equal((await tool(owner, "fs_list", { target: web, path: "/" })).data.error, "target_not_found");
  console.log("ssh connector acceptance passed");
} finally {
  app.running = false;
  await db.end().catch(() => {});
  gateway.kill();
}
