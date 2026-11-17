import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
process.env.CONTROL_API_KEY ??= "test-control-key-0123456789-0123456789";
process.env.APPROVAL_SIGNING_SECRET ??= "test-approval-secret-0123456789-012345";

const { isSshTargetId, normalize, parseResult, parseTargets, sshTargetId, targetView } = await import("./ssh-connector.js");

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
