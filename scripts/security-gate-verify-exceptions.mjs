#!/usr/bin/env node
// Attest every narrowly allowed synthetic-secret or vendor-file exemption.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const annotation = ["gitleaks", ":allow"].join("");
const vendor = new Map([
  ["center-windows/App/Assets/terminal/xterm.js", "7ca75f8e5ec2a0741333130fd63fb9c79d9c2023"],
  ["desktop/ui/vendor/xterm/xterm.js", "7ca75f8e5ec2a0741333130fd63fb9c79d9c2023"],
]);
const configBlob = "c5392d06c1a0e5ed646152b4a0e42a294844d0a1";
const gitObject = (path) => execFileSync("git", ["hash-object", "--", path],
  { encoding: "utf8" }).trim();

assert.equal(gitObject(".gitleaks.toml"), configBlob,
  "Gitleaks config has changed: review and re-attest the exact allowlist");
for (const [path, objectId] of vendor) {
  assert.equal(gitObject(path), objectId,
    path + ": pinned vendor blob changed; remove exception or review new artifact");
}

// Non-production test values, split so the verifier itself never creates a detector hit.
const fixtureValues = [
  ["APPROVAL_SIGNING_SECRET", ["ci", "approval", "secret", "0123456789", "012345"].join("-"), 5],
  ["APPROVAL_SIGNING_SECRET", ["ci", "compose", "approval", "secret", "0123456789012345"].join("-"), 1],
  ["PADDLE_WEBHOOK_SECRET", ["ci", "test", "secret", "paddle", "signatures", "2026"].join("-"), 1],
  ["MAIL_OUTBOX_KEY", Array(4).fill("0123456789abcdef").join(""), 2],
];
const syntheticAws = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
const syntheticJwt = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
].join(".");

const expected = new Map();
function register(path, content, count) {
  const key = path + "\0" + content;
  expected.set(key, (expected.get(key) || 0) + count);
}
for (const [key, value, count] of fixtureValues) {
  register(".github/workflows/ci.yml", key + ": " + value, count);
}
for (const path of ["crates/agent/src/redact.rs", "crates/wc-app-core/src/mcp/redact.rs"]) {
  register(path, 'assert_eq!(masked("' + syntheticAws + '"), "[REDACTED]");', 1);
  register(path, 'let jwt = "' + syntheticJwt + '";', 1);
}
register("docs/QUICKSTART.md", "RELAY_CLUSTER_SECRET=<same cluster secret>", 1);

const result = execFileSync("git", ["grep", "-n", "-F", "--", annotation, "--", "."],
  { encoding: "utf8" });
let scanned = 0;
for (const row of result.trimEnd().split("\n")) {
  const match = /^([^:]+):(\d+):(.*)$/.exec(row);
  assert.ok(match, "Malformed annotation search result");
  const [, path, lineNumberText, raw] = match;
  const lineNumber = Number(lineNumberText);
  const source = readFileSync(path, "utf8").split("\n")[lineNumber - 1];
  assert.equal(source, raw, "Unexpected line searched by Git");
  const idx = raw.indexOf(annotation);
  assert.ok(idx > 0, "Exception marker must be on a fixture line");
  const clean = raw.slice(0, idx).replace(/\s*(?:#|\/\/|<!--)\s*$/, "").trim();
  const key = path + "\0" + clean;
  assert.ok((expected.get(key) || 0) > 0,
    path + ":" + lineNumber + ": new or modified secret-scan exception requires review");
  expected.set(key, expected.get(key) - 1);
  scanned++;
}
for (const [key, missing] of expected) {
  assert.equal(missing, 0, "Missing synthetic fixture exception: " + key.split("\0")[0]);
}
assert.equal(scanned, 14, "Exactly 14 synthetic fixture lines should be exempt");
console.log("Security Gate: 14 synthetic fixture lines and 2 pinned vendor bundles verified");
