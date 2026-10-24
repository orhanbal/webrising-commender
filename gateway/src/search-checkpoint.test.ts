import assert from "node:assert/strict";
import test from "node:test";
import { isNativeFilenameCheckpoint } from "./search-checkpoint.js";
import { parseAgentAction } from "./protocol.js";

const valid = {
  version: 1, root: "/safe", query: "needle", caseSensitive: false,
  pending: ["/safe/pending"], items: [{ path: "/safe/needle.txt" }],
  scannedEntries: 32,
};

test("native checkpoint schema enforces size, bounded work and strict primitive types", () => {
  assert.equal(isNativeFilenameCheckpoint(valid), true);
  assert.equal(isNativeFilenameCheckpoint(null), false);
  assert.equal(isNativeFilenameCheckpoint([]), false);
  assert.equal(isNativeFilenameCheckpoint({ ...valid, version: 2 }), false);
  assert.equal(isNativeFilenameCheckpoint({ ...valid, caseSensitive: "false" }), false);
  assert.equal(isNativeFilenameCheckpoint({ ...valid, pending: [] }), false);
  assert.equal(isNativeFilenameCheckpoint({ ...valid, pending: Array(4097).fill("/safe/a") }), false);
  assert.equal(isNativeFilenameCheckpoint({ ...valid, pending: ["/".repeat(4097)] }), false);
  assert.equal(isNativeFilenameCheckpoint({ ...valid, scannedEntries: -1 }), false);
  assert.equal(isNativeFilenameCheckpoint({ ...valid, scannedEntries: NaN }), false);
  assert.equal(isNativeFilenameCheckpoint({ ...valid, items: Array(501).fill(null) }), false);
  assert.equal(isNativeFilenameCheckpoint({
    ...valid, items: [{ path: "/safe/needle.txt", payload: "x".repeat(132_000) }],
  }), false);
});

test("Agent action schema refuses malformed or oversized native resume checkpoints", () => {
  const action = parseAgentAction({
    kind: "fs_search", path: "/safe", query: "needle", resumeCheckpoint: valid,
  });
  assert.equal(action.kind, "fs_search");
  if (action.kind !== "fs_search") throw new Error("unexpected_action");
  assert.deepEqual(action.resumeCheckpoint, valid);
  assert.throws(() => parseAgentAction({
    kind: "fs_search", path: "/safe", query: "needle",
    resumeCheckpoint: { ...valid, pending: ["/".repeat(4097)] },
  }));
  assert.throws(() => parseAgentAction({
    kind: "text_search", path: "/safe", query: "needle", resumeCheckpoint: valid,
  }));
  assert.throws(() => parseAgentAction({
    kind: "fs_search", path: "/safe", query: "needle",
    resumeCheckpoint: { ...valid, items: Array(501).fill(null) },
  }));
});
