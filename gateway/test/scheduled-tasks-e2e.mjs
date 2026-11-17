// WECOMMANDER scheduled tasks end to end: REST contract, roles, a fake agent
// running device tasks (task_start/task_status), offline devices, the desktop
// app's claim/result flow for SSH targets, audit records, and the scheduler's
// claim racing against other instances. Starts its own gateway (spare port,
// 1-second scheduler) against DATABASE_URL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.SCHEDULED_TASKS_E2E_PORT || 8798);
const base = `http://127.0.0.1:${port}`;
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gateway = spawn(process.execPath, [path.join(here, "../dist/index.js")], {
  env: {
    ...process.env, PORT: String(port), HOST: "127.0.0.1", PUBLIC_BASE_URL: base,
    DEPLOYMENT_MODE: "self_hosted", SCHEDULED_TASKS_INTERVAL_MS: "1000", SCHEDULED_TASKS_DISABLED: "false",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

async function call(token, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { authorization: "Bearer " + token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function until(what, fn, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(250);
  }
}

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/health/live")).ok) break; } catch {} await sleep(250); }
  await db.connect();
  const suffix = crypto.randomBytes(4).toString("hex");
  const org = (await db.query("insert into organizations(name) values($1) returning id", ["sched " + suffix])).rows[0].id;
  const token = async (role) => {
    const t = "wrc_" + crypto.randomBytes(30).toString("base64url");
    await db.query("insert into api_tokens(organization_id,name,role,token_hash,created_by) values($1,$2,$3,$4,'test')",
      [org, role, role, sha256(t)]);
    return t;
  };
  const owner = await token("owner");
  const viewer = await token("viewer");
  const operator = await token("operator");
  const device = async (name) => {
    const id = crypto.randomUUID(); const secret = crypto.randomBytes(32).toString("base64url");
    await db.query("insert into devices(id,organization_id,name,token_hash) values($1,$2,$3,$4)", [id, org, name, sha256(secret)]);
    return { id, secret };
  };

  // A fake agent that runs background tasks.
  const online = await device("sched-online");
  const offline = await device("sched-offline");
  const seen = [];
  const tasks = new Map();
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/agent", {
    headers: { "x-device-id": online.id, Authorization: `Bearer ${online.secret}` },
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ type: "hello", deviceId: online.id, hostname: "sched", os: "linux", version: "ci", capabilities: ["system"] }));
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type !== "request") return;
    seen.push(msg);
    const reply = (data) => ws.send(JSON.stringify({ type: "result", requestId: msg.requestId, ok: true, data }));
    const fail = (message) => ws.send(JSON.stringify({ type: "result", requestId: msg.requestId, ok: false, error: { code: "denied", message } }));
    if (msg.action.kind === "task_start") {
      if (typeof msg.approvalToken !== "string") return fail("approval token required for high-risk action");
      if (msg.action.command.startsWith("blocked")) return fail("device_policy_denied: command execution is disabled on this device");
      const taskId = crypto.randomUUID();
      tasks.set(taskId, msg.action.command);
      return reply({ taskId, status: "running" });
    }
    if (msg.action.kind === "task_status") {
      const command = tasks.get(msg.action.taskId);
      if (!command) return fail("task not found");
      const failed = command.startsWith("fail");
      return reply({ taskId: msg.action.taskId, status: "completed", error: null, result: {
        exitCode: failed ? 3 : 0, success: !failed,
        stdout: `ran ${command}\npassword=hunter2 in /home/alice/app\n`, stderr: failed ? "boom\n" : "",
      } });
    }
    fail("unexpected " + msg.action.kind);
  });
  await sleep(300);

  // Roles: every role reads, only owner/admin write.
  assert.equal((await call(viewer, "GET", "/api/scheduled-tasks")).status, 200);
  const body = { name: "Nightly backup", target: { kind: "device", deviceId: online.id }, command: "echo backup",
    schedule: { kind: "cron", expr: "0 3 * * *" }, timezone: "Europe/Istanbul" };
  assert.equal((await call(viewer, "POST", "/api/scheduled-tasks", body)).status, 403);
  assert.equal((await call(operator, "POST", "/api/scheduled-tasks", body)).status, 403);

  // Preview and validation errors (400 {error, message}).
  const preview = await call(viewer, "POST", "/api/scheduled-tasks/preview", { schedule: { kind: "cron", expr: "*/5 * * * *" }, timezone: "America/New_York" });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.next.length, 5);
  for (const bad of [{ schedule: { kind: "cron", expr: "61 * * * *" } }, { schedule: { kind: "cron", expr: "* * *" } },
    { schedule: { kind: "interval", minutes: 1 } }, { schedule: { kind: "cron", expr: "0 0 * * *" }, timezone: "Mars/Base" },
    { schedule: { kind: "cron", expr: "0 0 31 2 *" } }]) {
    const r = await call(owner, "POST", "/api/scheduled-tasks/preview", bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok(r.body.error && r.body.message, JSON.stringify(r.body));
  }
  assert.equal((await call(owner, "POST", "/api/scheduled-tasks", { ...body, command: "" })).status, 400);
  assert.equal((await call(owner, "POST", "/api/scheduled-tasks", { ...body, target: { kind: "device", deviceId: crypto.randomUUID() } })).body.error, "unknown_device");
  assert.equal((await call(owner, "POST", "/api/scheduled-tasks", { ...body, schedule: { kind: "once", at: "2020-01-01T00:00:00Z" } })).body.error, "invalid_schedule");

  // CRUD.
  const created = await call(owner, "POST", "/api/scheduled-tasks", body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const nightly = created.body.item;
  assert.equal(nightly.notify, "failure");
  assert.equal(nightly.timeoutSec, 600);
  assert.equal(nightly.enabled, true);
  assert.match(nightly.nextRunAt, /T00:00:00\.000Z$/, "03:00 Istanbul is 00:00 UTC");
  const renamed = await call(owner, "PATCH", `/api/scheduled-tasks/${nightly.id}`, { name: "Nightly backup v2", enabled: false });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.item.name, "Nightly backup v2");
  assert.equal(renamed.body.item.nextRunAt, null);
  const reenabled = await call(owner, "PATCH", `/api/scheduled-tasks/${nightly.id}`, { enabled: true });
  assert.ok(reenabled.body.item.nextRunAt);
  assert.equal((await call(owner, "PATCH", `/api/scheduled-tasks/${nightly.id}`, {})).status, 400);
  assert.equal((await call(viewer, "PATCH", `/api/scheduled-tasks/${nightly.id}`, { name: "x" })).status, 403);

  // A one-off device task runs on the agent within seconds, output scrubbed.
  const soon = (s) => new Date(Date.now() + s * 1000).toISOString();
  const once = (await call(owner, "POST", "/api/scheduled-tasks", { ...body, name: "Once", command: "echo once",
    schedule: { kind: "once", at: soon(1) } })).body.item;
  const onceRun = await until("once run", async () => {
    const runs = (await call(viewer, "GET", `/api/scheduled-tasks/${once.id}/runs`)).body.items;
    return runs?.find((r) => r.status === "succeeded");
  });
  assert.equal(onceRun.exitCode, 0);
  assert.equal(onceRun.runner, "agent");
  assert.equal(onceRun.trigger, "schedule");
  assert.match(onceRun.output, /ran echo once/);
  assert.match(onceRun.output, /password=\[REDACTED\]/);
  assert.match(onceRun.output, /\/home\/…\/app/);
  const start = seen.find((m) => m.action.kind === "task_start" && m.action.command === "echo once");
  assert.equal(start.action.timeoutMs, 600_000);
  assert.equal(start.undoScope.actor, `scheduled-task:${once.id}`);
  const afterOnce = (await call(owner, "GET", "/api/scheduled-tasks")).body.items.find((t) => t.id === once.id);
  assert.equal(afterOnce.enabled, false, "a once task is disabled after its run");
  assert.equal(afterOnce.nextRunAt, null);
  assert.equal(afterOnce.lastRun.status, "succeeded");

  // Run now: a failing command, then a command the device's policy refuses.
  const failing = (await call(owner, "POST", "/api/scheduled-tasks", { ...body, name: "Failing", command: "fail now" })).body.item;
  assert.equal((await call(viewer, "POST", `/api/scheduled-tasks/${failing.id}/run`)).status, 403);
  const manual = await call(owner, "POST", `/api/scheduled-tasks/${failing.id}/run`);
  assert.equal(manual.status, 200);
  assert.equal(manual.body.run.trigger, "manual");
  const failedRun = await until("failed run", async () =>
    (await call(owner, "GET", `/api/scheduled-tasks/${failing.id}/runs`)).body.items.find((r) => r.status === "failed"));
  assert.equal(failedRun.exitCode, 3);
  assert.match(failedRun.output, /boom/);
  const refused = (await call(owner, "POST", "/api/scheduled-tasks", { ...body, name: "Refused", command: "blocked thing" })).body.item;
  await call(owner, "POST", `/api/scheduled-tasks/${refused.id}/run`);
  const refusedRun = await until("refused run", async () =>
    (await call(owner, "GET", `/api/scheduled-tasks/${refused.id}/runs`)).body.items.find((r) => r.status === "failed"));
  assert.match(refusedRun.error, /device_policy_denied/);

  // Offline device at due time: missed, and only one missed run per outage.
  const away = (await call(owner, "POST", "/api/scheduled-tasks", { ...body, name: "Away", command: "echo away",
    target: { kind: "device", deviceId: offline.id }, schedule: { kind: "once", at: soon(1) } })).body.item;
  const missed = await until("missed run", async () =>
    (await call(owner, "GET", `/api/scheduled-tasks/${away.id}/runs`)).body.items.find((r) => r.status === "missed"));
  assert.equal(missed.error, "device_offline");
  // Two more due times during the same outage add no further missed runs.
  await db.query("update scheduled_tasks set enabled=true, schedule='{\"kind\":\"interval\",\"minutes\":5}', next_run_at=now() where id=$1", [away.id]);
  await until("second due time", async () => (await db.query("select next_run_at>now() as moved from scheduled_tasks where id=$1", [away.id])).rows[0].moved);
  await db.query("update scheduled_tasks set next_run_at=now() where id=$1", [away.id]);
  await until("third due time", async () => (await db.query("select next_run_at>now() as moved from scheduled_tasks where id=$1", [away.id])).rows[0].moved);
  await sleep(500);
  const awayRuns = (await call(owner, "GET", `/api/scheduled-tasks/${away.id}/runs`)).body.items;
  assert.equal(awayRuns.filter((r) => r.status === "missed").length, 1, JSON.stringify(awayRuns));
  assert.equal(awayRuns.filter((r) => r.status === "queued").length, 0);

  // SSH targets: created and claimed by the desktop app (Center token).
  const userId = (await db.query("insert into users(email,password_hash,email_verified_at) values($1,'x',now()) returning id",
    [`sched-${suffix}@example.test`])).rows[0].id;
  await db.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')", [org, userId]);
  const centerToken = "wmc_" + crypto.randomBytes(30).toString("base64url");
  const centerId = (await db.query("insert into management_centers(organization_id,user_id,name,token_hash,platform) values($1,$2,'PC',$3,'windows') returning id",
    [org, userId, sha256(centerToken)])).rows[0].id;
  const sshBody = { ...body, name: "Disk report", command: "df -h", schedule: { kind: "cron", expr: "0 0 1 1 *" },
    target: { kind: "ssh", centerId, hostId: "host-1", hostLabel: "web-1" } };
  assert.equal((await call(owner, "POST", "/api/scheduled-tasks", sshBody)).body.error, "ssh_task_app_only");
  const ssh = await call(centerToken, "POST", "/api/scheduled-tasks", sshBody);
  assert.equal(ssh.status, 201, JSON.stringify(ssh.body));
  const sshTask = ssh.body.item;
  assert.deepEqual(sshTask.target, sshBody.target);
  assert.equal((await call(owner, "PATCH", `/api/scheduled-tasks/${sshTask.id}`, { command: "rm -rf /" })).body.error, "ssh_task_app_only");
  assert.equal((await call(owner, "PATCH", `/api/scheduled-tasks/${sshTask.id}`, { name: "Disk report (web)" })).status, 200);
  assert.equal((await call(owner, "GET", "/api/center/scheduled-runs/claim")).status, 403, "claim needs a Center token");
  const queued = await call(centerToken, "POST", `/api/scheduled-tasks/${sshTask.id}/run`);
  assert.equal(queued.body.run.status, "queued");
  assert.equal(queued.body.run.runner, "center");
  const claim = await call(centerToken, "GET", "/api/center/scheduled-runs/claim");
  assert.equal(claim.status, 200);
  assert.equal(claim.body.items.length, 1);
  assert.equal(claim.body.items[0].run.status, "running");
  assert.equal(claim.body.items[0].task.command, "df -h");
  assert.equal((await call(centerToken, "GET", "/api/center/scheduled-runs/claim")).body.items.length, 0, "claimed once");
  const runId = claim.body.items[0].run.id;
  const result = await call(centerToken, "POST", `/api/center/scheduled-runs/${runId}/result`,
    { status: "succeeded", exitCode: 0, output: "x".repeat(70 * 1024) + "END" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await call(centerToken, "POST", `/api/center/scheduled-runs/${runId}/result`, { status: "failed", exitCode: 1 })).status, 404);
  const sshRun = (await call(owner, "GET", `/api/scheduled-tasks/${sshTask.id}/runs?limit=5`)).body.items[0];
  assert.equal(sshRun.status, "succeeded");
  assert.ok(Buffer.byteLength(sshRun.output) <= 64 * 1024, "output capped at 64 KiB");
  assert.match(sshRun.output, /^…\[\d+ bytes truncated\]\n/);
  assert.ok(sshRun.output.endsWith("END"), "the tail is kept");
  // An unclaimed SSH run expires as missed after 15 minutes.
  const late = await call(centerToken, "POST", `/api/scheduled-tasks/${sshTask.id}/run`);
  await db.query("update scheduled_task_runs set created_at=now()-interval '16 minutes' where id=$1", [late.body.run.id]);
  await until("expired app run", async () =>
    (await call(owner, "GET", `/api/scheduled-tasks/${sshTask.id}/runs`)).body.items.find((r) => r.id === late.body.run.id && r.status === "missed"));

  // Audit: changes by the caller, runs with origin scheduled-task:<id>; no approval requests.
  const audit = (await db.query("select actor,tool,outcome,detail from audit_logs where organization_id=$1", [org])).rows;
  for (const tool of ["scheduled_task.create", "scheduled_task.update", "scheduled_task.run_now"]) {
    assert.ok(audit.some((a) => a.tool === tool), tool);
  }
  assert.ok(audit.some((a) => a.tool === "scheduled_task.run" && a.actor === `scheduled-task:${once.id}` && a.outcome === "succeeded"));
  assert.ok(audit.some((a) => a.tool === "scheduled_task.create" && JSON.parse(a.detail).via?.centerId === centerId),
    "a change from the app records which app");
  assert.equal((await db.query("select count(*)::int as n from approval_requests where organization_id=$1", [org])).rows[0].n, 0);

  // Delete.
  assert.equal((await call(viewer, "DELETE", `/api/scheduled-tasks/${nightly.id}`)).status, 403);
  assert.equal((await call(owner, "DELETE", `/api/scheduled-tasks/${nightly.id}`)).status, 200);
  assert.equal((await call(owner, "DELETE", `/api/scheduled-tasks/${nightly.id}`)).status, 404);
  assert.ok(!(await call(owner, "GET", "/api/scheduled-tasks")).body.items.some((t) => t.id === nightly.id));

  // Another workspace sees nothing of this one.
  const otherOrg = (await db.query("insert into organizations(name) values($1) returning id", ["other " + suffix])).rows[0].id;
  const stranger = "wrc_" + crypto.randomBytes(30).toString("base64url");
  await db.query("insert into api_tokens(organization_id,name,role,token_hash,created_by) values($1,'x','owner',$2,'test')", [otherOrg, sha256(stranger)]);
  assert.equal((await call(stranger, "GET", "/api/scheduled-tasks")).body.items.length, 0);
  assert.equal((await call(stranger, "GET", `/api/scheduled-tasks/${failing.id}/runs`)).status, 404);
  assert.equal((await call(stranger, "POST", `/api/scheduled-tasks/${failing.id}/run`)).status, 404);

  // Several schedulers racing for the same due tasks: each due time runs once.
  const { ScheduledTaskStore } = await import("../dist/scheduled-tasks.js");
  const pools = [new pg.Pool({ connectionString: process.env.DATABASE_URL }), new pg.Pool({ connectionString: process.env.DATABASE_URL })];
  const raceIds = [];
  for (let i = 0; i < 25; i++) {
    raceIds.push((await db.query(
      `insert into scheduled_tasks(organization_id,name,target_kind,device_id,command,schedule,timezone,created_by,next_run_at)
       values($1,$2,'device',$3,'echo race','{"kind":"interval","minutes":60}','UTC','test',now()-interval '1 minute') returning id`,
      [org, "race " + i, offline.id])).rows[0].id);
  }
  const stores = pools.map((p) => new ScheduledTaskStore(p));
  const later = (task, at) => new Date(at.getTime() + 3_600_000);
  await Promise.all(stores.flatMap((s, i) => [0, 1, 2].map(() => s.claimDue(new Date(), "race-" + i, later, 5))));
  await until("all race tasks claimed", async () =>
    (await db.query("select count(*)::int as n from scheduled_tasks where id=any($1) and next_run_at<=now()", [raceIds])).rows[0].n === 0);
  const perTask = (await db.query(
    "select task_id,count(*)::int as n from scheduled_task_runs where task_id=any($1) group by task_id", [raceIds])).rows;
  assert.equal(perTask.length, 25);
  assert.ok(perTask.every((r) => r.n === 1), JSON.stringify(perTask));
  await Promise.all(pools.map((p) => p.end()));

  ws.close();
  console.log("scheduled tasks acceptance passed");
} finally {
  await db.end().catch(() => {});
  gateway.kill();
}
