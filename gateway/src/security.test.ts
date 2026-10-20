import assert from "node:assert/strict";
import test from "node:test";

process.env.CONTROL_API_KEY ||= "x".repeat(32);
process.env.APPROVAL_SIGNING_SECRET ||= "y".repeat(32);

const { issueApproval, verifyApproval, redact, sha256 } = await import("./security.js");

test("approval is bound to device and action", () => {
  const { token } = issueApproval("device-a", "process_exec", 60);
  assert.equal(verifyApproval(token, "device-a", "process_exec"), true);
  assert.equal(verifyApproval(token, "device-b", "process_exec"), false);
  assert.equal(verifyApproval(token, "device-a", "fs_delete"), false);
});

test("redactor hides common secrets", () => {
  const value = redact("Authorization: Bearer abcdef token=123 password=hunter2");
  assert.doesNotMatch(value, /abcdef|123|hunter2/);
});

test("sha256 is deterministic", () => {
  assert.equal(sha256("abc"), sha256("abc"));
  assert.notEqual(sha256("abc"), sha256("abcd"));
});
