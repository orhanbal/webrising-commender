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
type Perms = { trust?: string; run_as?: string; sudo?: string; safety_net?: boolean; safety_net_allow_power?: boolean; allowlist?: string[] };
function fakeDb(preset: "readonly" | "approval", result: unknown, approved = false, perms: Perms = {}) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const original = db.query;
  (db as any).query = async (sql: string, params: unknown[] = []) => {
    seen.push({ sql, params });
    if (sql.includes("from connector_targets t")) {
      return { rows: [{ target_id: TARGET, center_id: "center-1", host_id: "host-1", name: "web",
        preset, sudo: perms.sudo ?? "never", center_name: "PC", online: true, trust: perms.trust ?? "standard",
        trust_full_until: null, run_as: perms.run_as ?? "user", safety_net: perms.safety_net ?? true,
        safety_net_allow_power: perms.safety_net_allow_power ?? false }], rowCount: 1 };
    }
    if (sql.includes("from connector_target_command_allowlist")) {
      const rows = (perms.allowlist ?? []).map((pattern, i) => ({ id: "allow-" + i, pattern }));
      return { rows, rowCount: rows.length };
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

// ---- AI permissions of SSH targets (docs/AI_PERMISSIONS.md) ---------------

async function sshCall(tool: string, args: Record<string, unknown>, perms: Perms, preset: "readonly" | "approval" = "approval", approved = false) {
  const fake = fakeDb(preset, { exitCode: 0, output: "ok" }, approved, perms);
  const audits: Array<{ outcome: string; detail: Record<string, unknown> }> = [];
  try {
    const out = await sshTargetCall(principal, tool, args, TARGET, async (_t, _risk, outcome, detail) => { audits.push({ outcome, detail }); });
    const insert = fake.seen.find((q) => q.sql.includes("insert into connector_calls"));
    return {
      out, audits, seen: fake.seen,
      queued: insert ? { args: JSON.parse(String(insert.params[5])), approved: insert.params[6] } : null,
      approvalAsked: fake.seen.some((q) => q.sql.startsWith("insert into approval_requests")),
    };
  } finally {
    fake.restore();
  }
}

test("full trust: an SSH command or change runs without approval, queued as approved", async () => {
  for (const [tool, args] of [
    ["process_exec", { command: "systemctl restart nginx" }],
    ["fs_write", { path: "/etc/x.conf", content_base64: Buffer.from("x").toString("base64") }],
    ["docker_container_action", { container: "web", action: "restart" }],
  ] as const) {
    const r = await sshCall(tool, args as any, { trust: "full" });
    assert.equal(r.out.isError, false, tool);
    assert.equal(r.approvalAsked, false, tool);
    assert.ok(!r.seen.some((q) => q.sql.includes("with candidate as")), `${tool}: no approval consumed`);
    assert.equal(r.queued!.approved, true, tool);
    assert.deepEqual(r.audits.map((a) => a.outcome), ["trusted_full", "success"], tool);
  }
});

test("standard and strict: approval as before; full trust never lifts readonly", async () => {
  for (const trust of ["standard", "strict"]) {
    const r = await sshCall("process_exec", { command: "uptime" }, { trust });
    assert.equal((r.out.data as any).error, "approval_required", trust);
    assert.equal(r.queued, null);
  }
  for (const [tool, args] of [
    ["process_exec", { command: "uptime" }],
    ["fs_delete", { path: "/tmp/x" }],
    ["server_cleanup_run", { ids: ["journal"] }],
  ] as const) {
    const r = await sshCall(tool, args as any, { trust: "full", run_as: "root", sudo: "sudoers" }, "readonly");
    assert.equal((r.out.data as any).error, "readonly_preset", tool);
    assert.equal(r.queued, null);
    assert.equal(r.approvalAsked, false);
  }
});

test("standard: an allowlisted SSH command skips approval; strict ignores the allowlist", async () => {
  const ok = await sshCall("process_exec", { command: "df -h /" }, { trust: "standard", allowlist: ["df -h"] });
  assert.equal(ok.out.isError, false);
  assert.equal(ok.queued!.approved, true);
  assert.equal(ok.audits[0]!.outcome, "allowlisted");
  assert.equal(ok.audits[0]!.detail.pattern, "df -h");
  const lookup = ok.seen.find((q) => q.sql.includes("from connector_target_command_allowlist"))!;
  assert.deepEqual(lookup.params, ["org-1", "center-1", "host-1"]);
  // Shell metacharacters never ride on a pattern.
  const chained = await sshCall("process_exec", { command: "df -h; rm -rf /tmp/x" }, { trust: "standard", allowlist: ["df -h"] });
  assert.equal((chained.out.data as any).error, "approval_required");
  const strict = await sshCall("process_exec", { command: "df -h" }, { trust: "strict", allowlist: ["df -h"] });
  assert.equal((strict.out.data as any).error, "approval_required");
  // Only commands: a file change is never allowlisted.
  const write = await sshCall("fs_mkdir", { path: "/tmp/x" }, { trust: "standard", allowlist: ["df -h"] });
  assert.equal((write.out.data as any).error, "approval_required");
});

test("the safety net refuses catastrophic SSH commands on every trust level and with an approval", async () => {
  for (const command of ["rm -rf /", "sudo mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/vda", ":(){ :|:& };:", "reboot"]) {
    for (const [trust, approved] of [["full", false], ["standard", true]] as const) {
      const r = await sshCall("process_exec", { command }, { trust, run_as: "root", sudo: "sudoers" }, "approval", approved);
      assert.equal((r.out.data as any).error, "safety_net_blocked", `${command} ${trust}`);
      assert.equal(r.queued, null);
      assert.equal(r.approvalAsked, false);
      assert.equal(r.audits[0]!.detail.reason, "safety_net");
    }
  }
  // Power commands only when allowed; everything once the net is off.
  assert.equal((await sshCall("process_exec", { command: "reboot" }, { trust: "full", safety_net_allow_power: true })).out.isError, false);
  assert.equal((await sshCall("process_exec", { command: "rm -rf /" }, { trust: "full", safety_net: false })).out.isError, false);
  // Ordinary work passes.
  assert.equal((await sshCall("process_exec", { command: "rm -rf /var/www/old" }, { trust: "full" })).out.isError, false);
});

test("run as root on SSH: only with the computer's sudo setting; bound into the approval and sent with the call", async () => {
  // The computer does not allow sudo for this host: refused, never silently as the user.
  const refused = await sshCall("process_exec", { command: "id" }, { trust: "full", run_as: "root", sudo: "never" });
  assert.equal((refused.out.data as any).error, "run_as_root_unavailable");
  assert.equal(refused.queued, null);
  assert.equal(refused.audits[0]!.detail.reason, "run_as_root_unavailable");
  // Allowed: full trust sends run_as root.
  const full = await sshCall("process_exec", { command: "id" }, { trust: "full", run_as: "root", sudo: "sudoers" });
  assert.equal(full.out.isError, false);
  assert.equal(full.queued!.args.run_as, "root");
  assert.equal(full.audits[0]!.detail.runAs, "root");
  // Standard: the approval request carries runAs root (the person sees and approves it).
  const asked = await sshCall("fs_write", { path: "/etc/x", content_base64: "eA==" }, { run_as: "root", sudo: "sudoers" });
  assert.equal((asked.out.data as any).error, "approval_required");
  const request = asked.seen.find((q) => q.sql.startsWith("insert into approval_requests"))!;
  assert.equal(JSON.parse(String(request.params[6])).runAs, "root");
  // Approved: consumed with runAs root, queued with run_as root.
  const approved = await sshCall("process_exec", { command: "id" }, { run_as: "root", sudo: "sudoers" }, "approval", true);
  const consume = approved.seen.find((q) => q.sql.includes("with candidate as"))!;
  assert.equal(JSON.parse(String(consume.params[4])).runAs, "root");
  assert.equal(approved.queued!.args.run_as, "root");
  // Tools that do not escalate stay the SSH user (no run_as on the call).
  const mkdir = await sshCall("fs_mkdir", { path: "/tmp/x" }, { trust: "full", run_as: "root", sudo: "sudoers" });
  assert.equal(mkdir.queued!.args.run_as, undefined);
  const read = await sshCall("fs_read", { path: "/etc/hostname" }, { run_as: "root", sudo: "never" });
  assert.equal(read.out.isError, false, "reads are never refused for run_as");
  assert.equal(read.queued!.args.run_as, undefined);
});

test("targets_list shows trust, run_as and safety_net of SSH targets", () => {
  const base = { target_id: "ssh-x", center_id: "c", host_id: "h", name: "web", preset: "approval", center_name: "PC", online: true };
  const v = targetView({ ...base, sudo: "sudoers", trust: "full", trust_full_until: null, run_as: "root", safety_net: false }) as any;
  assert.deepEqual([v.trust, v.run_as, v.root_capable, v.safety_net, v.trust_full_until], ["full", "root", true, false, null]);
  const old = targetView({ ...base, sudo: "never" }) as any;
  assert.deepEqual([old.trust, old.run_as, old.root_capable, old.safety_net], ["standard", "user", false, true]);
  // A root setting the computer no longer allows is shown as user.
  assert.equal((targetView({ ...base, sudo: "never", run_as: "root" }) as any).run_as, "user");
});
