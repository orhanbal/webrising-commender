import assert from "node:assert/strict";
import test from "node:test";

process.env.CONTROL_API_KEY ||= "x".repeat(32);
process.env.APPROVAL_SIGNING_SECRET ||= "y".repeat(32);

const {
  deviceApprovalKeyForAgent,
  issueApproval,
  verifyApproval,
  redact,
  sha256,
} = await import("./security.js");

test("approval is bound to device and exact operation", () => {
  const action = { kind: "process_exec", command: "echo approved", timeoutMs: 30_000 };
  const { token } = issueApproval("device-a", action, 60);

  assert.equal(verifyApproval(token, "device-a", action), true);
  assert.equal(verifyApproval(token, "device-b", action), false);
  assert.equal(
    verifyApproval(token, "device-a", { ...action, command: "echo changed" }),
    false,
  );
  assert.equal(
    verifyApproval(token, "device-a", { kind: "fs_delete", path: "/tmp/example" }),
    false,
  );
});

test("redactor hides common secrets", () => {
  const value = redact("Authorization: Bearer abcdef token=123 password=hunter2");
  assert.doesNotMatch(value, /abcdef|123|hunter2/);
});

test("sha256 is deterministic", () => {
  assert.equal(sha256("abc"), sha256("abc"));
  assert.notEqual(sha256("abc"), sha256("abcd"));
});

test("device approval keys are isolated per device", () => {
  assert.notEqual(deviceApprovalKeyForAgent("device-a"), deviceApprovalKeyForAgent("device-b"));
  assert.ok(deviceApprovalKeyForAgent("device-a").length >= 40);
});
