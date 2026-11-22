import assert from "node:assert/strict";
import test from "node:test";

process.env.CONTROL_API_KEY ||= "x".repeat(32);
process.env.APPROVAL_SIGNING_SECRET ||= "y".repeat(32);
process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";

const { centerMayAccess } = await import("./center-link.js");

const DEVICE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const TARGET = "ssh-0123456789abcdef01234567";

test("the desktop app may change trust, run as and the safety net", () => {
  for (const what of ["trust", "run-as", "safety-net"]) {
    assert.equal(centerMayAccess("PUT", `/api/devices/${DEVICE}/${what}`), true, what);
    assert.equal(centerMayAccess("PUT", `/api/ssh-targets/${TARGET}/${what}`), true, what);
  }
  assert.equal(centerMayAccess("GET", "/api/ssh-targets"), true);
});

test("the desktop app never reaches the command allowlists or other device routes", () => {
  assert.equal(centerMayAccess("POST", `/api/devices/${DEVICE}/command-allowlist`), false);
  assert.equal(centerMayAccess("POST", `/api/ssh-targets/${TARGET}/command-allowlist`), false);
  assert.equal(centerMayAccess("DELETE", `/api/devices/${DEVICE}`), false);
  assert.equal(centerMayAccess("POST", `/api/devices/${DEVICE}/trust`), false);
  assert.equal(centerMayAccess("PUT", `/api/devices/${DEVICE}/trust/extra`), false);
});
