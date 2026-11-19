import test from "node:test";
import assert from "node:assert/strict";
import { buildUdeCapabilities, udeEnabled } from "./ude-capabilities.js";

const system = { os: "Windows", osVersion: "11 (26300)", cpuCount: 12, totalMemory: 24_000_000_000 };
const health = {
  observedAt: "2026-11-19T10:00:00Z",
  memory: { totalBytes: 24_000_000_000, availableBytes: 4_000_000_000 },
  disks: [{ mount: "C:\\", totalBytes: 500_000_000_000, availableBytes: 50_000_000_000 }],
  limitations: ["CPU measured over a short interval"],
};
const policy = { commandExecution: "enabled", fileWrites: "enabled", allowedRoots: ["C:\\Users\\secret\\WECOMMANDER"] };

test("UDE is opt-in only with literal true", () => {
  for (const value of [undefined, "", "false", "1", "TRUE", "yes"]) assert.equal(udeEnabled(value), false);
  assert.equal(udeEnabled("true"), true);
});

test("read-only preflight projects system, memory, disk and explicit unknown runtime", () => {
  const result = buildUdeCapabilities(system, health, policy);
  assert.equal(result.host.platform, "windows");
  assert.equal(result.host.cpuCount, 12);
  assert.equal(result.host.availableMemoryBytes, 4_000_000_000);
  assert.equal(result.host.disks[0]?.availableBytes, 50_000_000_000);
  assert.equal(result.assessment.status, "requires_additional_verification");
  assert.equal(result.assessment.canProvision, false);
  assert.ok(result.assessment.checksNotPerformed.includes("container_runtime_and_permissions"));
  assert.equal(result.readOnly, true);
  assert.equal(result.observedAt, health.observedAt);
});

test("restricted Agent capabilities explicitly block provisioning", () => {
  const result = buildUdeCapabilities(system, health, { commandExecution: "disabled", fileWrites: "enabled" });
  assert.equal(result.assessment.status, "blocked_by_device_policy");
  assert.equal(result.devicePolicy.commandExecution, "disabled");
  assert.equal(result.assessment.canProvision, false);
});

test("missing or invalid observations do not become a positive readiness claim", () => {
  const result = buildUdeCapabilities({ os: "unknown", cpuCount: -8 }, { disks: [{ totalBytes: 10, availableBytes: 11 }] }, {});
  assert.equal(result.host.platform, "unknown");
  assert.equal(result.host.cpuCount, null);
  assert.deepEqual(result.host.disks, []);
  assert.equal(result.devicePolicy.fileWrites, "unknown");
  assert.equal(result.assessment.canProvision, false);
});

test("private Agent allowlisted roots and unexpected input fields are not echoed", () => {
  const result = JSON.stringify(buildUdeCapabilities({ ...system, apiToken: "PRIVATE_TOKEN" }, health, policy));
  assert.ok(!result.includes("PRIVATE_TOKEN"));
  assert.ok(!result.includes("secret"));
  assert.ok(!result.includes("allowedRoots"));
});

test("supports Linux and macOS inventory without claiming their runtimes are installed", () => {
  assert.equal(buildUdeCapabilities({ os: "Linux" }, {}, {}).host.platform, "linux");
  assert.equal(buildUdeCapabilities({ os: "macOS" }, {}, {}).host.platform, "macos");
  assert.equal(buildUdeCapabilities({ os: "Darwin" }, {}, {}).host.platform, "macos");
  assert.equal(buildUdeCapabilities({ os: "Linux" }, {}, {}).assessment.canProvision, false);
});
