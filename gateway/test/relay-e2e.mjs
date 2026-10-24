import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const apiKey = process.env.CONTROL_API_KEY;
if (!apiKey) throw new Error("CONTROL_API_KEY is required");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const agentBinary =
  process.env.AGENT_BINARY ||
  path.join(
    repoRoot,
    "target",
    "debug",
    process.platform === "win32"
      ? "webrising-commender.exe"
      : "webrising-commender",
  );

const authHeaders = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

async function jsonFetch(route, options = {}) {
  const response = await fetch(base + route, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${options.method || "GET"} ${route} -> ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function rpc(id, method, params = undefined) {
  return jsonFetch("/mcp", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
}

function toolText(response) {
  const text = response?.result?.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

async function waitFor(predicate, timeoutMs = 20_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `condition timeout; last=${
      last instanceof Error ? last.message : JSON.stringify(last)
    }`,
  );
}

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "commender-relay-e2e-"),
);
const configPath = path.join(tempRoot, "agent.json");
let agent = null;
let agentLog = "";

try {
  const relayRegistry = await waitFor(async () => {
    const relays = await jsonFetch("/api/admin/relays", {
      headers: authHeaders,
    });
    const healthy = relays.items.filter((item) => item.healthy && !item.drain);
    return healthy.length >= 2 ? relays : null;
  });
  assert.equal(relayRegistry.enabled, true);

  const preferredRegion = await jsonFetch("/api/organization/relay-region", {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ region: "eu-central" }),
  });
  assert.equal(preferredRegion.item.relay_region, "eu-central");

  const pairing = await jsonFetch("/api/pairing", {
    method: "POST",
    headers: authHeaders,
    body: "{}",
  });

  const enroll = spawnSync(
    agentBinary,
    [
      "--config",
      configPath,
      "enroll",
      "--control-url",
      base,
      "--pairing-code",
      pairing.pairingCode,
      "--allowed-root",
      tempRoot,
    ],
    { encoding: "utf8" },
  );
  if (enroll.status !== 0) {
    throw new Error(
      `agent enrollment failed: ${enroll.stderr || enroll.stdout}`,
    );
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(typeof config.deviceId, "string");
  assert.match(config.gatewayWsUrl, /^ws:\/\/127\.0\.0\.1:878[89]\/agent$/);
  const deviceId = config.deviceId;

  agent = spawn(agentBinary, ["--config", configPath, "run"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: "info" },
  });
  agent.stdout.on("data", (chunk) => {
    agentLog += chunk.toString();
  });
  agent.stderr.on("data", (chunk) => {
    agentLog += chunk.toString();
  });

  const firstConnected = await waitFor(async () => {
    const devices = await jsonFetch("/api/devices", {
      headers: authHeaders,
    });
    const item = devices.items.find((candidate) => candidate.id === deviceId);
    return item?.online &&
      item.connected_relay_id &&
      item.assigned_relay_id === item.connected_relay_id
      ? item
      : null;
  });

  const firstRelay = firstConnected.connected_relay_id;
  assert.equal(firstRelay, "relay-b");

  const infoBefore = toolText(
    await rpc(501, "tools/call", {
      name: "system_info",
      arguments: { device_id: deviceId },
    }),
  );
  assert.equal(typeof infoBefore.cpuCount, "number");

  // Remote relay must forward *intermediate* native progress, not merely
  // the final snapshot. A 192-file fixture crosses the Agent's 32-entry
  // progress threshold and exercises MCP -> Gateway -> signed relay -> Rust.
  for (let i = 0; i < 192; i += 1) {
    fs.writeFileSync(path.join(tempRoot,
      `relay-progress-fixture-${String(i).padStart(3, "0")}.txt`), "fixture");
  }
  const progressSearch = toolText(await rpc(506, "tools/call", {
    name: "start_search",
    arguments: {
      device_id: deviceId, path: tempRoot,
      query: "relay-progress-fixture", search_type: "files",
    },
  }));
  const streamedSearch = await waitFor(async () => {
    const page = toolText(await rpc(507, "tools/call", {
      name: "get_more_search_results",
      arguments: {
        device_id: deviceId, search_id: progressSearch.searchId,
        offset: 0, length: 10,
      },
    }));
    return page.status === "completed" ? page : null;
  }, 20_000);
  assert.ok(streamedSearch.progressUpdates >= 1,
    "remote relay must deliver at least one native progress frame");
  assert.ok(streamedSearch.scannedEntries >= 32);
  assert.ok(streamedSearch.items.length > 0);

  // Exercise real remote-relay MCP search/start/stop/page, including no-result
  // resurrection if the native worker races with the cancellation request.
  const startedSearch = toolText(await rpc(503, "tools/call", {
    name: "start_search",
    arguments: { device_id: deviceId, path: tempRoot, query: "relay", search_type: "files" },
  }));
  assert.equal(typeof startedSearch.searchId, "string");
  const stoppedSearch = toolText(await rpc(504, "tools/call", {
    name: "stop_search",
    arguments: { device_id: deviceId, search_id: startedSearch.searchId },
  }));
  assert.equal(stoppedSearch.status, "stopped");
  const pagedStopped = toolText(await rpc(505, "tools/call", {
    name: "get_more_search_results",
    arguments: { device_id: deviceId, search_id: startedSearch.searchId, offset: 0, length: 10 },
  }));
  assert.equal(pagedStopped.status, "stopped");
  assert.deepEqual(pagedStopped.items, []);


  const relayPort =
    firstRelay === "relay-a"
      ? 8788
      : 8789;
  const unsignedInternal = await fetch(
    `http://127.0.0.1:${relayPort}/internal/relay/request`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId,
        action: { kind: "system_info" },
      }),
    },
  );
  assert.equal(unsignedInternal.status, 401);

  // Signed relay cancellation requires the same trust boundary as execution.
  const unsignedCancel = await fetch(
    `http://127.0.0.1:${relayPort}/internal/relay/cancel`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, requestId: crypto.randomUUID() }),
    },
  );
  assert.equal(unsignedCancel.status, 401);

  const unsignedPause = await fetch(
    `http://127.0.0.1:${relayPort}/internal/relay/search-control`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId, searchSessionId: startedSearch.searchId, paused: true,
      }),
    },
  );
  assert.equal(unsignedPause.status, 401);


  const drained = await jsonFetch(
    `/api/admin/relays/${encodeURIComponent(firstRelay)}`,
    {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ drain: true }),
    },
  );
  assert.equal(drained.item.drain, true);

  const disconnected = await jsonFetch(
    `/api/devices/${deviceId}/disconnect`,
    {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    },
  );
  assert.equal(disconnected.disconnected, true);

  const secondConnected = await waitFor(async () => {
    const devices = await jsonFetch("/api/devices", {
      headers: authHeaders,
    });
    const item = devices.items.find((candidate) => candidate.id === deviceId);
    return item?.online &&
      item.connected_relay_id &&
      item.connected_relay_id !== firstRelay &&
      item.assigned_relay_id === item.connected_relay_id
      ? item
      : null;
  }, 30_000);

  assert.equal(secondConnected.connected_relay_id, "relay-a");
  assert.notEqual(secondConnected.connected_relay_id, firstRelay);

  const infoAfter = toolText(
    await rpc(502, "tools/call", {
      name: "system_info",
      arguments: { device_id: deviceId },
    }),
  );
  assert.equal(typeof infoAfter.cpuCount, "number");

  const relaysAfter = await jsonFetch("/api/admin/relays", {
    headers: authHeaders,
  });
  const oldRelay = relaysAfter.items.find((item) => item.id === firstRelay);
  const newRelay = relaysAfter.items.find(
    (item) => item.id === secondConnected.connected_relay_id,
  );
  assert.equal(oldRelay.drain, true);
  assert.ok(newRelay.connected_count >= 1);

  console.log(
    `relay-e2e: ok (${firstRelay} -> ${secondConnected.connected_relay_id})`,
  );
} catch (error) {
  console.error(agentLog);
  throw error;
} finally {
  if (agent && !agent.killed) {
    agent.kill("SIGTERM");
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
