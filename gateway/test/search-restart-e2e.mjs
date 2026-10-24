import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import WebSocket from "ws";

// Runs only against the disposable CI Gateway/PostgreSQL stack.
// Tests a real process crash/restart, not just constructing a new store.
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const key = process.env.CONTROL_API_KEY;
if (!key) throw new Error("CONTROL_API_KEY is required");
const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function api(route, method = "GET", body) {
  const response = await fetch(base + route, {
    method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(6_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${route}`);
  return value;
}
async function tool(id, name, args) {
  const response = await api("/mcp", "POST", {
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name, arguments: args },
  });
  const payload = response?.result?.content?.[0]?.text;
  assert.equal(typeof payload, "string");
  return JSON.parse(payload);
}
async function until(predicate, timeout = 25_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch { /* Gateway may be offline during the restart. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("gateway search restart acceptance timed out");
}

let socket;
try {
  const pairing = await api("/api/pairing", "POST", {});
  const enrolled = await fetch(base + "/api/agent/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairingCode: pairing.pairingCode, name: "Gateway Restart E2E",
      hostname: "ci-restart-agent", platform: "linux",
    }),
  });
  assert.equal(enrolled.status, 201);
  const device = await enrolled.json();
  const deviceId = device.deviceId;
  socket = new WebSocket(base.replace(/^http/, "ws") + "/agent", {
    headers: {
      "x-device-id": deviceId,
      Authorization: `Bearer ${device.deviceToken}`,
    },
  });
  socket.on("error", () => {});
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.on("message", raw => {
    const request = JSON.parse(raw.toString());
    if (request.type !== "request" || request.action?.kind !== "fs_search") return;
    if (request.action.query !== "saved-fixture") return;
    socket.send(JSON.stringify({
      type: "result", requestId: request.requestId, ok: true,
      data: {
        items: [{ path: "/ci/saved-fixture.txt" }],
        truncated: false, timedOut: false,
      },
    }));
  });
  socket.send(JSON.stringify({
    type: "hello", deviceId, hostname: "ci-restart-agent",
    os: "linux", version: "CI", capabilities: ["fs_search"],
  }));
  await until(async () => {
    const status = await api("/api/devices");
    return status.items.some(item => item.id === deviceId && item.online);
  });

  const completed = await tool(901, "start_search", {
    device_id: deviceId, path: "/ci", query: "saved-fixture", search_type: "files",
  });
  assert.equal(typeof completed.searchId, "string");
  await until(async () => {
    const result = await tool(902, "get_more_search_results", {
      device_id: deviceId, search_id: completed.searchId,
    });
    return result.status === "completed" && result.items?.length === 1;
  });

  const orphan = await tool(903, "start_search", {
    device_id: deviceId, path: "/ci", query: "unanswered-fixture", search_type: "files",
  });
  assert.equal(orphan.status, "running");
  assert.equal(typeof orphan.searchId, "string");

  const oldPid = Number(fs.readFileSync("/tmp/commender-gateway.pid", "utf8"));
  assert.ok(Number.isSafeInteger(oldPid) && oldPid > 1);
  process.kill(oldPid, "SIGKILL");
  await until(async () => {
    try {
      await fetch(base + "/health/live", { signal: AbortSignal.timeout(500) });
      return false;
    } catch { return true; }
  });
  socket.terminate();

  const fd = fs.openSync("/tmp/commender-gateway-restart.log", "a");
  const gateway = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(), env: process.env, detached: true,
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  assert.ok(gateway.pid);
  fs.writeFileSync("/tmp/commender-gateway.pid", String(gateway.pid));
  gateway.unref();
  await until(async () => {
    const health = await api("/health");
    return health.database === "ok";
  }, 30_000);

  const recovered = await tool(904, "get_more_search_results", {
    device_id: deviceId, search_id: completed.searchId,
  });
  assert.equal(recovered.status, "completed");
  assert.deepEqual(recovered.items, [{ path: "/ci/saved-fixture.txt" }]);

  // A killed Gateway has no heartbeat; after the bounded lease expires the
  // orphaned native request must not remain indefinitely 'running'.
  await until(async () => {
    const result = await tool(905, "get_more_search_results", {
      device_id: deviceId, search_id: orphan.searchId,
    });
    assert.deepEqual(result.items, []);
    return result.status === "error" && result.error === "search_interrupted";
  }, 25_000);
  const stopped = await tool(906, "stop_search", {
    device_id: deviceId, search_id: orphan.searchId,
  });
  assert.equal(stopped.status, "stopped");
  const afterStop = await tool(907, "get_more_search_results", {
    device_id: deviceId, search_id: orphan.searchId,
  });
  assert.equal(afterStop.status, "stopped");
  assert.deepEqual(afterStop.items, []);
  console.log("search-restart-e2e: PASS (real SIGKILL/restart, recovery, lease expiry, stop)");
} finally {
  socket?.terminate();
}
