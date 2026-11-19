import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
process.env.CONTROL_API_KEY ??= "test-control-key-0123456789-0123456789";
process.env.APPROVAL_SIGNING_SECRET ??= "test-approval-secret-0123456789-012345";

const { callTimeoutMs, isSshTargetId, normalize, parseResult, parseTargets, SSH_CHANGE_TOOLS, SSH_TARGET_TOOLS, sshTargetCall, sshTargetId, targetView } = await import("./ssh-connector.js");
const { db } = await import("./db.js");

test("target ids are opaque, stable and per computer", () => {
  const a = sshTargetId("center-1", "host-1");
  assert.equal(a, sshTargetId("center-1", "host-1"));
  assert.notEqual(a, sshTargetId("center-2", "host-1"));
  assert.ok(isSshTargetId(a) && !a.includes("host-1"));
  assert.ok(!isSshTargetId(crypto.randomUUID()));
  assert.ok(!isSshTargetId("ssh-xyz"));
});

test("published targets are validated; timed acts as approval remotely", () => {
  assert.deepEqual(parseTargets({ targets: [{ hostId: "h", name: " Web\n1 ", preset: "timed", sudo: "never" }] }),
    [{ hostId: "h", name: "Web 1", preset: "approval", sudo: "never" }]);
  for (const bad of [{}, { targets: "x" }, { targets: [{ hostId: "", name: "a", preset: "approval" }] },
    { targets: [{ hostId: "h", name: "a", preset: "root" }] }, { targets: [{ hostId: "h", name: "a", preset: "approval", sudo: "always" }] },
    { targets: [{ hostId: "h", name: "a", preset: "approval" }, { hostId: "h", name: "b", preset: "approval" }] }]) {
    assert.equal(parseTargets(bad), null, JSON.stringify(bad));
  }
});

test("approvals are bound to the exact operation; writes by size and hash", () => {
  const exec = normalize("process_exec", { command: "df -h" }, "ssh-t") as any;
  assert.deepEqual(exec.action, { kind: "process_exec", target: "ssh-t", command: "df -h", cwd: null, timeoutMs: 30000 });
  assert.deepEqual(exec.args, { command: "df -h", timeout_ms: 30000 });
  const clamped = normalize("process_exec", { command: "x", timeout_ms: 9e9, cwd: "/srv" }, "ssh-t") as any;
  assert.deepEqual([clamped.action.timeoutMs, clamped.action.cwd], [600000, "/srv"]);
  assert.equal((normalize("process_exec", { command: " " }, "t") as any).error, "invalid_arguments");
  const content = Buffer.from("hello").toString("base64");
  const write = normalize("fs_write", { path: "/a", content_base64: content }, "ssh-t") as any;
  assert.equal(write.action.sha256, crypto.createHash("sha256").update("hello").digest("hex"));
  assert.equal(write.action.size, 5);
  assert.equal(write.action.content_base64, undefined);
  assert.equal(write.args.content_base64, content);
  assert.equal((normalize("fs_write", { path: "/a", content_base64: "%%%" }, "t") as any).error, "invalid_arguments");
  assert.equal((normalize("fs_write", { path: "/a", content_base64: Buffer.alloc(1024 * 1024 + 1).toString("base64") }, "t") as any).error, "file_too_large");
  assert.equal((normalize("fs_delete", { path: "/a", expected_sha256: "zz" }, "t") as any).error, "invalid_arguments");
  assert.deepEqual((normalize("fs_move", { source: "/a", destination: "/b" }, "t") as any).action,
    { kind: "fs_move", target: "t", source: "/a", destination: "/b" });
  assert.equal((normalize("fs_read", { path: "/a", max_bytes: 1e12 }, "t") as any).args.max_bytes, 1024 * 1024);
  assert.equal((normalize("fs_list", { path: "/" }, "t") as any).action, null);
});

test("results from the computer are checked; messages are masked", () => {
  assert.deepEqual(parseResult({ ok: true, result: { a: 1 } }), { ok: true, result: { a: 1 } });
  assert.deepEqual(parseResult({ ok: false, error: "fs_error", message: "token=abc123 failed" }),
    { ok: false, error: "fs_error", message: "token=[REDACTED] failed" });
  assert.equal(parseResult({ ok: false, error: "Not A Code" }), null);
  assert.equal(parseResult({ ok: "yes" }), null);
});

test("target view shows no host id or address", () => {
  const view = targetView({ target_id: "ssh-x", center_id: "c", host_id: "secret-host-id", name: "web", preset: "readonly",
    sudo: "never", center_name: "PC", online: true });
  assert.ok(!JSON.stringify(view).includes("secret-host-id"));
  assert.deepEqual([view.capabilities.exec, view.capabilities.write, view.capabilities.path_policy], [false, false, "none"]);
});

const SERVER_TOOLS = ["server_cleanup_scan", "server_cleanup_run", "server_process_signal", "server_timers_list",
  "docker_containers_list", "docker_container_logs", "docker_container_action"];
const SERVER_CHANGES = ["server_cleanup_run", "server_process_signal", "docker_container_action"];

test("SSH targets have the agent's server tools; their changes need approval", () => {
  for (const name of SERVER_TOOLS) assert.ok((SSH_TARGET_TOOLS as readonly string[]).includes(name), name);
  for (const name of SERVER_CHANGES) assert.ok(SSH_CHANGE_TOOLS.has(name), name);
  for (const name of ["server_cleanup_scan", "server_timers_list", "docker_containers_list", "docker_container_logs", "server_overview"]) {
    assert.ok(!SSH_CHANGE_TOOLS.has(name), name);
  }
  for (const name of SSH_CHANGE_TOOLS) assert.ok((SSH_TARGET_TOOLS as readonly string[]).includes(name), name);
  assert.ok(targetView({ target_id: "ssh-x", center_id: "c", host_id: "h", name: "web", preset: "approval",
    sudo: "never", center_name: "PC", online: true }).tools.includes("docker_container_action"));
});

test("server changes are bound to the exact operation and checked like the agent's", () => {
  const cleanup = normalize("server_cleanup_run", { ids: ["apt-cache", "docker-build@u1000"] }, "ssh-t") as any;
  assert.deepEqual(cleanup.action, { kind: "server_cleanup_run", target: "ssh-t", ids: ["apt-cache", "docker-build@u1000"] });
  assert.deepEqual(cleanup.args, { ids: ["apt-cache", "docker-build@u1000"] });
  const signal = normalize("server_process_signal", { pid: 42, name: "nginx", action: "term" }, "ssh-t") as any;
  assert.deepEqual(signal.action, { kind: "server_process_signal", target: "ssh-t", pid: 42, name: "nginx", action: "term", confirmDatabase: false });
  assert.deepEqual(signal.args, { pid: 42, name: "nginx", action: "term", confirm_database: false });
  const docker = normalize("docker_container_action", { container: "/web@u1000", action: "restart" }, "ssh-t") as any;
  assert.deepEqual(docker.action, { kind: "docker_container_action", target: "ssh-t", daemon: "u1000", container: "web", action: "restart" });
  assert.deepEqual(docker.args, { daemon: "u1000", container: "web", action: "restart" });
  assert.deepEqual((normalize("docker_container_action", { container: "0123456789ab", daemon: "u7", action: "stop" }, "t") as any).args,
    { daemon: "u7", container: "0123456789ab", action: "stop" });
  for (const [tool, args] of [
    ["server_cleanup_run", { ids: [] }],
    ["server_cleanup_run", { ids: "apt-cache" }],
    ["server_cleanup_run", { ids: ["apt-cache; rm -rf /"] }],
    ["server_cleanup_run", { ids: ["docker-build@root"] }],
    ["server_cleanup_run", { ids: Array(21).fill("journal") }],
    ["server_process_signal", { pid: 1, name: "init", action: "kill" }],
    ["server_process_signal", { pid: 4194305, name: "x", action: "kill" }],
    ["server_process_signal", { pid: "42", name: "x", action: "kill" }],
    ["server_process_signal", { pid: 42, name: "", action: "kill" }],
    ["server_process_signal", { pid: 42, name: "a\nb", action: "kill" }],
    ["server_process_signal", { pid: 42, name: "x", action: "stop" }],
    ["docker_container_action", { container: "web", action: "rm" }],
    ["docker_container_action", { container: "web", action: "prune" }],
    ["docker_container_action", { container: "web;id", action: "stop" }],
    ["docker_container_action", { container: "$(id)", action: "stop" }],
    ["docker_container_action", { container: "web'x", action: "stop" }],
    ["docker_container_action", { container: "web@u1000", daemon: "system", action: "stop" }],
    ["docker_container_action", { container: "web", daemon: "u0", action: "stop" }],
    ["docker_container_action", { container: "web@x@y", action: "stop" }],
    ["docker_container_logs", { container: "web", tail: 0 }],
    ["docker_container_logs", { container: "web", tail: "10" }],
    ["docker_container_logs", { container: "web", tail: 2001 }],
    ["docker_container_logs", { container: "web", since: "1h; id" }],
    ["docker_container_logs", { container: "web", since: 10 }],
    ["docker_container_logs", { container: "-web" }],
    ["docker_containers_list", { daemon: "x;id" }],
  ] as const) {
    assert.equal((normalize(tool, args as any, "t") as any).error, "invalid_arguments", `${tool} ${JSON.stringify(args)}`);
  }
});

test("server reads need no approval; logs tail is bounded", () => {
  for (const tool of ["server_cleanup_scan", "server_timers_list", "docker_containers_list"]) {
    assert.equal((normalize(tool, {}, "t") as any).action, null, tool);
  }
  const logs = normalize("docker_container_logs", { container: "web" }, "t") as any;
  assert.deepEqual([logs.action, logs.args], [null, { daemon: "system", container: "web", tail: 200 }]);
  assert.deepEqual((normalize("docker_container_logs", { container: "0123456789ab@u1000", tail: 2000, since: "1h30m" }, "t") as any).args,
    { daemon: "u1000", container: "0123456789ab", tail: 2000, since: "1h30m" });
  assert.deepEqual((normalize("docker_containers_list", { daemon: "u1000" }, "t") as any).args, { daemon: "u1000" });
  assert.equal(callTimeoutMs("server_cleanup_run", {}), 1_800_000);
  assert.equal(callTimeoutMs("fs_read", {}), 60_000);
  assert.equal(callTimeoutMs("process_exec", { timeout_ms: 5000 }), 5000);
});

/** db.query answered in memory: one SSH target, approvals and the call queue. */
function fakeDb(preset: "readonly" | "approval", result: unknown, approved = false) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const original = db.query;
  (db as any).query = async (sql: string, params: unknown[] = []) => {
    seen.push({ sql, params });
    if (sql.includes("from connector_targets t")) {
      return { rows: [{ target_id: TARGET, center_id: "center-1", host_id: "host-1", name: "web",
        preset, sudo: "never", center_name: "PC", online: true }], rowCount: 1 };
    }
    if (sql.includes("with candidate as")) return approved ? { rows: [{ id: "appr-ok" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.startsWith("select id,expires_at from approval_requests")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("insert into approval_requests")) return { rows: [{ id: "appr-1", expires_at: new Date(0) }], rowCount: 1 };
    if (sql.includes("insert into connector_calls")) return { rows: [{ id: "call-1" }], rowCount: 1 };
    if (sql.startsWith("select status,result")) {
      return { rows: [{ status: "done", result: { ok: true, result }, unclaimed: false, late: false }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  return { seen, restore: () => { (db as any).query = original; } };
}

const principal = { organizationId: "org-1", actor: "user:u", role: "operator", global: false, authKind: "oauth", userId: "u" } as any;
const TARGET = "ssh-0123456789abcdef01234567";

test("a server change on an SSH target asks for approval and queues nothing", async () => {
  for (const [tool, args] of [
    ["server_cleanup_run", { ids: ["journal"] }],
    ["server_process_signal", { pid: 42, name: "nginx", action: "kill" }],
    ["docker_container_action", { container: "web", action: "stop" }],
  ] as const) {
    const fake = fakeDb("approval", {});
    const audits: string[] = [];
    try {
      const out = await sshTargetCall(principal, tool, args as any, TARGET, async (_t, risk, outcome) => { audits.push(`${risk}:${outcome}`); });
      assert.equal(out.isError, true, tool);
      assert.equal((out.data as any).error, "approval_required", tool);
      assert.equal((out.data as any).approval_request_id, "appr-1");
      const insert = fake.seen.find((q) => q.sql.startsWith("insert into approval_requests"))!;
      assert.equal(insert.params[5], tool, "action_kind is the tool");
      assert.equal(JSON.parse(String(insert.params[6])).kind, tool);
      assert.ok(!fake.seen.some((q) => q.sql.includes("insert into connector_calls")), `${tool}: nothing queued`);
      assert.deepEqual(audits, ["high:approval_pending"]);
    } finally {
      fake.restore();
    }
  }
});

test("an approved server change is queued once, marked approved, with the canonical arguments", async () => {
  const fake = fakeDb("approval", { daemon: "u1000", action: "restart", ok: true }, true);
  const audits: string[] = [];
  try {
    const out = await sshTargetCall(principal, "docker_container_action", { container: "web@u1000", action: "restart" }, TARGET,
      async (_t, risk, outcome) => { audits.push(`${risk}:${outcome}`); });
    assert.equal(out.isError, false);
    const consume = fake.seen.find((q) => q.sql.includes("with candidate as"))!;
    assert.deepEqual(JSON.parse(String(consume.params[4])),
      { kind: "docker_container_action", target: TARGET, daemon: "u1000", container: "web", action: "restart" });
    const insert = fake.seen.find((q) => q.sql.includes("insert into connector_calls"))!;
    assert.equal(insert.params[6], true);
    assert.deepEqual(JSON.parse(String(insert.params[5])), { daemon: "u1000", container: "web", action: "restart", target: "host-1" });
    assert.ok(!fake.seen.some((q) => q.sql.startsWith("insert into approval_requests")));
    assert.deepEqual(audits, ["high:approval_consumed", "high:success"]);
  } finally {
    fake.restore();
  }
});

test("a server change on a readonly SSH target is refused before anything else", async () => {
  for (const tool of SERVER_CHANGES) {
    const fake = fakeDb("readonly", {});
    try {
      const args = tool === "server_cleanup_run" ? { ids: ["journal"] }
        : tool === "server_process_signal" ? { pid: 42, name: "nginx", action: "term" } : { container: "web", action: "start" };
      const out = await sshTargetCall(principal, tool, args, TARGET, async () => undefined);
      assert.equal((out.data as any).error, "readonly_preset", tool);
      assert.ok(!fake.seen.some((q) => q.sql.includes("approval_requests") || q.sql.includes("connector_calls")), tool);
    } finally {
      fake.restore();
    }
  }
});

test("server reads on an SSH target run without approval, also on readonly", async () => {
  const fake = fakeDb("readonly", { daemons: [] });
  try {
    const out = await sshTargetCall(principal, "docker_containers_list", {}, TARGET, async () => undefined);
    assert.equal(out.isError, false);
    assert.deepEqual(out.data, { daemons: [] });
    const insert = fake.seen.find((q) => q.sql.includes("insert into connector_calls"))!;
    assert.equal(insert.params[4], "docker_containers_list");
    assert.equal(insert.params[6], false, "not approved: no approval needed");
    assert.ok(!fake.seen.some((q) => q.sql.includes("approval_requests")));
  } finally {
    fake.restore();
  }
  // A viewer may read but not change.
  const f2 = fakeDb("approval", {});
  try {
    const out = await sshTargetCall({ ...principal, role: "viewer" }, "docker_container_action", { container: "web", action: "restart" }, TARGET, async () => undefined);
    assert.equal((out.data as any).error, "forbidden");
  } finally {
    f2.restore();
  }
});
