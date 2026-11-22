// AI permissions of SSH targets end to end (docs/AI_PERMISSIONS.md, Hybrid
// Access): trust strict/standard/full with expiry, run as root only with the
// computer's sudo setting (two keys), the safety net, the per-target
// allowlist, readonly winning over everything, re-authentication, browser
// session only, owner-only scoping and the audit log. A fake desktop app
// (Center token) publishes the hosts and answers the calls like
// wecommander-core's mcp.remoteCall. Starts its own gateway (spare port)
// against DATABASE_URL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hashPassword } from "../dist/browser-auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.SSH_PERMISSIONS_E2E_PORT || 8798);
const base = `http://127.0.0.1:${port}`;
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gateway = spawn(process.execPath, [path.join(here, "../dist/index.js")], {
  env: {
    ...process.env, PORT: String(port), HOST: "127.0.0.1", PUBLIC_BASE_URL: base,
    DEPLOYMENT_MODE: "self_hosted", SCHEDULED_TASKS_DISABLED: "true", CONNECTOR_CLAIM_WITHIN_MS: "2000",
    TRUST_EXPIRY_INTERVAL_MS: "300",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

async function http(headers, method, url, body) {
  const auth = typeof headers === "string" ? { authorization: "Bearer " + headers } : headers;
  const res = await fetch(base + url, {
    method,
    headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
let rpcId = 0;
async function tool(token, name, args) {
  const r = await (await fetch(base + "/mcp", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  })).json();
  const text = r.result?.content?.[0]?.text ?? "";
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { isError: r.result?.isError === true, data };
}

const app = { running: false, seen: [], loop: null };
function startApp(centerToken) {
  app.running = true;
  app.loop = (async () => {
    while (app.running) {
      const claim = await http(centerToken, "GET", "/api/center/connector/claim?waitMs=500");
      assert.equal(claim.status, 200, JSON.stringify(claim.body));
      for (const call of claim.body.items) {
        app.seen.push(call);
        await http(centerToken, "POST", `/api/center/connector/calls/${call.id}/result`,
          { ok: true, result: { exitCode: 0, output: "ok", runAs: call.args.run_as === "root" ? "root" : "user" } });
      }
    }
  })();
}

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/health/live")).ok) break; } catch {} await sleep(250); }
  await db.connect();
  const suffix = crypto.randomBytes(4).toString("hex");
  const password = "ssh-permissions-" + suffix;
  const org = (await db.query("insert into organizations(name) values($1) returning id", ["ssh permissions " + suffix])).rows[0].id;
  const user = async (role) => {
    const email = `ssh-perm-${role}-${suffix}@example.test`;
    const id = (await db.query("insert into users(email,password_hash,email_verified_at) values($1,$2,now()) returning id",
      [email, await hashPassword(password)])).rows[0].id;
    await db.query("insert into organization_members(organization_id,user_id,role) values($1,$2,$3)", [org, id, role]);
    return { id, email };
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
  const login = async (email) => {
    const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, organizationId: org }) });
    assert.equal(r.status, 200);
    const body = await r.json();
    return { Cookie: r.headers.getSetCookie().map((v) => v.split(";")[0]).join("; "), "X-CSRF-Token": body.csrfToken };
  };
  const owner = await user("owner");
  const other = await user("admin");
  const ownerMcp = await token("owner", owner.id);
  const pc = await center(owner.id, "Ayşe's PC");
  const ownerSession = await login(owner.email);
  const otherSession = await login(other.email);

  const publish = (targets) => http(pc.token, "PUT", "/api/center/connector/targets", { targets });
  const shared = [
    { hostId: "host-web", name: "web-1", preset: "approval", sudo: "never" },
    { hostId: "host-db", name: "db-1", preset: "approval", sudo: "sudoers" },
    { hostId: "host-ro", name: "ro-1", preset: "readonly", sudo: "sudoers" },
  ];
  const ids = Object.fromEntries((await publish(shared)).body.items.map((t) => [t.hostId, t.targetId]));
  const [web, dbTarget, ro] = [ids["host-web"], ids["host-db"], ids["host-ro"]];
  startApp(pc.token);

  // The panel lists the user's own SSH targets, grouped data, no host ids.
  let list = await http(ownerSession, "GET", "/api/ssh-targets");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items.map((t) => t.name).sort(), ["db-1", "ro-1", "web-1"]);
  const item = (id) => list.body.items.find((t) => t.target_id === id);
  assert.deepEqual([item(web).trust_level, item(web).run_as, item(web).safety_net, item(web).root_capable, item(web).center_name],
    ["standard", "user", true, false, "Ayşe's PC"]);
  assert.equal(item(dbTarget).root_capable, true);
  assert.ok(!JSON.stringify(list.body).includes("host-web"), "host ids stay on the server");
  assert.deepEqual((await http(otherSession, "GET", "/api/ssh-targets")).body.items, [], "personal: another admin sees none");

  // Who may change: browser session (CSRF) of the computer's owner, admin role.
  const route = (id, what) => `/api/ssh-targets/${id}/${what}`;
  assert.equal((await http(ownerMcp, "PUT", route(web, "trust"), { level: "full", currentPassword: password })).body.error,
    "browser_session_required", "an AI client cannot widen its own permissions");
  assert.equal((await http({ Cookie: ownerSession.Cookie }, "PUT", route(web, "trust"), { level: "full", currentPassword: password })).status, 403, "CSRF");
  assert.equal((await http(otherSession, "PUT", route(web, "trust"), { level: "full", currentPassword: password })).status, 404, "not their computer");
  // The signed-in desktop app may change trust too, but every raise needs the
  // password there (its stored token alone must never widen AI's room), and
  // the command allowlist stays browser-only.
  assert.equal((await http(pc.token, "PUT", route(web, "trust"), { level: "strict" })).status, 200, "app: narrowing needs no password");
  assert.equal((await http(pc.token, "PUT", route(web, "trust"), { level: "standard" })).body.error, "reauthentication_failed",
    "app: strict → standard needs the password");
  assert.equal((await http(pc.token, "PUT", route(web, "trust"), { level: "standard", currentPassword: password })).status, 200);
  assert.equal((await http(pc.token, "PUT", route(web, "run-as"), { runAs: "user" })).status, 200, "app: back to user needs no password");
  assert.equal((await http(pc.token, "POST", route(web, "command-allowlist"), { pattern: "df -h" })).body.error, "center_scope",
    "app: the command allowlist stays in the browser");
  // Re-authentication to widen.
  assert.equal((await http(ownerSession, "PUT", route(web, "trust"), { level: "full" })).body.error, "reauthentication_failed");
  assert.equal((await http(ownerSession, "PUT", route(web, "trust"), { level: "full", currentPassword: "wrong-password-123" })).body.error, "reauthentication_failed");

  // Standard: a command waits for approval.
  let r = await tool(ownerMcp, "process_exec", { target: web, command: "systemctl restart web" });
  assert.equal(r.data.error, "approval_required");

  // Full trust (no time limit): no approval, the call is marked approved.
  assert.equal((await http(ownerSession, "PUT", route(web, "trust"), { level: "full", currentPassword: password })).status, 200);
  if (process.env.SMTP_HOST && process.env.MAIL_OUTBOX_KEY) {
    // Widening is mailed to the admins and owners.
    let mails = 0;
    for (let i = 0; i < 20 && !mails; i++) {
      mails = (await db.query("select count(*)::int as n from mail_outbox where recipient_hash=$1", [sha256(owner.email.toLowerCase())])).rows[0].n;
      if (!mails) await sleep(250);
    }
    assert.ok(mails >= 1, "full trust on an SSH target is e-mailed");
  }
  r = await tool(ownerMcp, "process_exec", { target: web, command: "systemctl restart web" });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  let ran = app.seen.at(-1);
  assert.deepEqual([ran.tool, ran.approved, ran.args.run_as], ["process_exec", true, undefined]);
  r = await tool(ownerMcp, "fs_delete", { target: web, path: "/srv/old" });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  // targets_list shows it.
  const tl = (await tool(ownerMcp, "targets_list", {})).data.targets;
  const webView = tl.find((t) => t.target_id === web);
  assert.deepEqual([webView.trust, webView.run_as, webView.safety_net, webView.root_capable], ["full", "user", true, false]);

  // Readonly wins over full trust.
  assert.equal((await http(ownerSession, "PUT", route(ro, "trust"), { level: "full", currentPassword: password })).status, 200);
  let n = app.seen.length;
  assert.equal((await tool(ownerMcp, "process_exec", { target: ro, command: "uptime" })).data.error, "readonly_preset");
  assert.equal((await tool(ownerMcp, "fs_write", { target: ro, path: "/x", content_base64: "eA==" })).data.error, "readonly_preset");
  assert.equal(app.seen.length, n);

  // Safety net: refused under full trust, nothing reaches the computer.
  r = await tool(ownerMcp, "process_exec", { target: web, command: "sudo rm -rf --no-preserve-root /" });
  assert.equal(r.data.error, "safety_net_blocked");
  assert.equal(app.seen.length, n);
  // Turning it off needs the password; on again does not.
  assert.equal((await http(ownerSession, "PUT", route(web, "safety-net"), { enabled: false })).body.error, "reauthentication_failed");
  assert.equal((await http(ownerSession, "PUT", route(web, "safety-net"), { enabled: true, allowPower: true })).body.error, "reauthentication_failed");
  assert.equal((await http(ownerSession, "PUT", route(web, "safety-net"), { enabled: false, currentPassword: password })).status, 200);
  assert.equal((await tool(ownerMcp, "process_exec", { target: web, command: "reboot" })).isError, false);
  assert.equal((await http(ownerSession, "PUT", route(web, "safety-net"), { enabled: true })).status, 200);
  assert.equal((await tool(ownerMcp, "process_exec", { target: web, command: "reboot" })).data.error, "safety_net_blocked");

  // Run as root: refused while the computer does not allow sudo for the host.
  assert.equal((await http(ownerSession, "PUT", route(web, "run-as"), { runAs: "root" })).body.error, "reauthentication_failed");
  r = await http(ownerSession, "PUT", route(web, "run-as"), { runAs: "root", currentPassword: password });
  assert.deepEqual([r.status, r.body.error], [409, "target_not_root_capable"]);
  // Allowed on the computer (sudo: sudoers): root, bound into the approval.
  assert.equal((await http(ownerSession, "PUT", route(dbTarget, "run-as"), { runAs: "root", currentPassword: password })).status, 200);
  r = await tool(ownerMcp, "process_exec", { target: dbTarget, command: "id -u" });
  assert.equal(r.data.error, "approval_required");
  const pending = (await http(pc.token, "GET", "/api/approval-requests")).body.items.find((p) => p.id === r.data.approval_request_id);
  assert.equal(pending.action.runAs, "root", "the person sees and approves root");
  assert.equal((await http(pc.token, "POST", `/api/approval-requests/${r.data.approval_request_id}/approve`, {})).status, 200);
  r = await tool(ownerMcp, "process_exec", { target: dbTarget, command: "id -u" });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  ran = app.seen.at(-1);
  assert.deepEqual([ran.approved, ran.args.run_as, r.data.runAs], [true, "root", "root"]);
  // The computer takes sudo away: root falls back to user (audited).
  await publish(shared.map((t) => t.hostId === "host-db" ? { ...t, sudo: "never" } : t));
  list = await http(ownerSession, "GET", "/api/ssh-targets");
  assert.deepEqual([item(dbTarget).run_as, item(dbTarget).root_capable], ["user", false]);
  assert.equal((await db.query("select count(*)::int as n from audit_logs where organization_id=$1 and tool='ssh_target.run_as' and outcome='fallback'", [org])).rows[0].n, 1);

  // Standard + allowlist: an allowlisted command runs without approval.
  assert.equal((await http(ownerSession, "PUT", route(web, "trust"), { level: "standard" })).status, 200, "narrowing needs no password");
  assert.equal((await http(ownerSession, "POST", route(web, "command-allowlist"), { pattern: "sudo ls" })).body.error, "pattern_not_allowed");
  assert.equal((await http(ownerMcp, "POST", route(web, "command-allowlist"), { pattern: "df -h" })).body.error, "browser_session_required");
  const added = await http(ownerSession, "POST", route(web, "command-allowlist"), { pattern: "df  -h" });
  assert.equal(added.status, 201);
  assert.equal(added.body.item.pattern, "df -h");
  r = await tool(ownerMcp, "process_exec", { target: web, command: "df -h /" });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(app.seen.at(-1).approved, true);
  assert.equal((await tool(ownerMcp, "process_exec", { target: web, command: "df -h / ; id" })).data.error, "approval_required");
  assert.equal((await http(ownerSession, "PUT", route(web, "trust"), { level: "strict" })).status, 200);
  assert.equal((await tool(ownerMcp, "process_exec", { target: web, command: "df -h /" })).data.error, "approval_required", "strict ignores the allowlist");
  assert.equal((await http(ownerSession, "GET", route(web, "command-allowlist"))).body.items.length, 1);
  assert.equal((await http(ownerSession, "DELETE", route(web, "command-allowlist") + "/" + added.body.item.id)).status, 200);

  // Time-limited full trust expires back to standard (audited, actor system).
  assert.equal((await http(ownerSession, "PUT", route(web, "trust"), { level: "full", minutes: 5, currentPassword: password })).status, 200);
  await db.query("update connector_targets set trust_full_until=now()-interval '1 second' where target_id=$1", [web]);
  assert.equal((await tool(ownerMcp, "process_exec", { target: web, command: "uptime" })).data.error, "approval_required", "expired full acts as standard at once");
  for (let i = 0; i < 40; i++) {
    if ((await db.query("select trust_level from connector_targets where target_id=$1", [web])).rows[0].trust_level === "standard") break;
    await sleep(250);
  }
  assert.equal((await db.query("select trust_level from connector_targets where target_id=$1", [web])).rows[0].trust_level, "standard");

  // Audit: every change by the owner, the decisions of the calls.
  const audit = (await db.query("select actor,tool,outcome,detail from audit_logs where organization_id=$1 order by id", [org])).rows;
  for (const t of ["ssh_target.trust_level", "ssh_target.run_as", "ssh_target.safety_net", "ssh_command_allowlist.add", "ssh_command_allowlist.remove"]) {
    assert.ok(audit.some((a) => a.tool === t && a.outcome === "success"), t);
  }
  assert.ok(audit.some((a) => a.tool === "ssh_target.run_as" && a.outcome === "denied"));
  assert.ok(audit.some((a) => a.tool === "ssh_target.trust_level" && a.outcome === "expired" && a.actor === "system"));
  for (const outcome of ["trusted_full", "allowlisted", "denied"]) {
    assert.ok(audit.some((a) => a.tool === "process_exec" && a.outcome === outcome), outcome);
  }
  assert.ok(audit.some((a) => a.tool === "process_exec" && a.outcome === "denied" && JSON.parse(a.detail).reason === "safety_net"));

  // Unsharing drops the permissions; sharing again starts at the defaults.
  await publish(shared.filter((t) => t.hostId !== "host-ro"));
  await publish(shared);
  list = await http(ownerSession, "GET", "/api/ssh-targets");
  assert.deepEqual([item(ro).trust_level, item(ro).run_as, item(ro).safety_net], ["standard", "user", true]);
  console.log("ssh permissions acceptance passed");
} finally {
  app.running = false;
  await app.loop?.catch(() => {});
  await db.end().catch(() => {});
  gateway.kill();
}
