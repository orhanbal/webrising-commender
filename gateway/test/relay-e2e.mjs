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

async function rpc(id, method, params = undefined, signal = undefined) {
  return jsonFetch("/mcp", {
    method: "POST",
    headers: authHeaders,
    signal,
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
let restartedRelayB = null;
let probeStop = false;
let probeTask = null;
const probeStats = { attempts: 0, successes: 0, failures: 0 };

// 9B: bounded authenticated MCP traffic during two unplanned relay deaths.
// Individual calls time out so shutdown cannot hang on a lost relay.
async function continuousMcpProbe(deviceId) {
  while (!probeStop) {
    probeStats.attempts += 1;
    try {
      const response = await rpc(
        8000 + probeStats.attempts,
        "tools/call",
        { name: "system_info", arguments: { device_id: deviceId } },
        AbortSignal.timeout(8_000),
      );
      assert.equal(typeof toolText(response).cpuCount, "number");
      probeStats.successes += 1;
    } catch {
      // Transient failover errors are allowed; recovered success is required.
      probeStats.failures += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

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

  // An authenticated device cannot exclude a relay using a fabricated URL.
  const spoofedRoute = await jsonFetch("/api/agent/route", {
    method: "POST",
    headers: {
      "x-device-id": deviceId,
      Authorization: `Bearer ${config.deviceToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ failedGatewayWsUrl: "ws://127.0.0.1:65535/agent" }),
  });
  assert.equal(spoofedRoute.relayId, firstRelay);

  // When the other relay is drained, a legitimate failed-route hint must
  // fall back to the only healthy assigned relay rather than strand the Agent.
  const temporarilyDrained = await jsonFetch("/api/admin/relays/relay-a", {
    method: "PATCH", headers: authHeaders,
    body: JSON.stringify({ drain: true }),
  });
  assert.equal(temporarilyDrained.item.drain, true);
  const singleRelayRoute = await jsonFetch("/api/agent/route", {
    method: "POST",
    headers: {
      "x-device-id": deviceId,
      Authorization: `Bearer ${config.deviceToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ failedGatewayWsUrl: config.gatewayWsUrl }),
  });
  assert.equal(singleRelayRoute.relayId, firstRelay);
  const reenabledStandby = await jsonFetch("/api/admin/relays/relay-a", {
    method: "PATCH", headers: authHeaders,
    body: JSON.stringify({ drain: false }),
  });
  assert.equal(reenabledStandby.item.drain, false);

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
      start_paused: true,
    },
  }));
  assert.equal(progressSearch.paused, true);
  // The async Gateway->relay request must reach the remote AgentHub before
  // a control ACK can be requested. start_paused prevents a completion race.
  await new Promise(resolve => setTimeout(resolve, 250));
  const resumedProgress = toolText(await rpc(508, "tools/call", {
    name: "resume_search",
    arguments: { device_id: deviceId, search_id: progressSearch.searchId },
  }));
  assert.equal(resumedProgress.paused, false);
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

  // 9B: a drained relay must be able to rejoin the healthy pool. Move the
  // same real Agent back to its original relay and prove that authenticated
  // MCP requests still reach the native process after two routing changes.
  // This is bounded failback acceptance, not an unplanned relay crash test.
  const reenabled = await jsonFetch(
    `/api/admin/relays/${encodeURIComponent(firstRelay)}`,
    {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ drain: false }),
    },
  );
  assert.equal(reenabled.item.drain, false);
  const drainedSecond = await jsonFetch(
    `/api/admin/relays/${encodeURIComponent(secondConnected.connected_relay_id)}`,
    {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ drain: true }),
    },
  );
  assert.equal(drainedSecond.item.drain, true);

  const disconnectedAgain = await jsonFetch(
    `/api/devices/${deviceId}/disconnect`,
    { method: "POST", headers: authHeaders, body: "{}" },
  );
  assert.equal(disconnectedAgain.disconnected, true);
  const recovered = await waitFor(async () => {
    const devices = await jsonFetch("/api/devices", { headers: authHeaders });
    const item = devices.items.find((candidate) => candidate.id === deviceId);
    return item?.online &&
      item.connected_relay_id === firstRelay &&
      item.assigned_relay_id === firstRelay
      ? item
      : null;
  }, 30_000);
  assert.equal(recovered.connected_relay_id, firstRelay);

  const afterFailback = toolText(await rpc(509, "tools/call", {
    name: "system_info",
    arguments: { device_id: deviceId },
  }));
  assert.equal(typeof afterFailback.cpuCount, "number");

  // A fresh native file search proves more than a healthy relay registry:
  // the MCP request is routed through the recovered relay to the real Agent.
  const failbackSearch = toolText(await rpc(510, "tools/call", {
    name: "start_search",
    arguments: {
      device_id: deviceId, path: tempRoot,
      query: "relay-progress-fixture", search_type: "files",
    },
  }));
  assert.equal(typeof failbackSearch.searchId, "string");
  const failbackResults = await waitFor(async () => {
    const page = toolText(await rpc(511, "tools/call", {
      name: "get_more_search_results",
      arguments: {
        device_id: deviceId, search_id: failbackSearch.searchId,
        offset: 0, length: 10,
      },
    }));
    return page.status === "completed" ? page : null;
  }, 20_000);
  assert.ok(failbackResults.items.length > 0);
  assert.ok(failbackResults.scannedEntries >= 32);
  const finalRelays = await jsonFetch("/api/admin/relays", {
    headers: authHeaders,
  });
  assert.equal(finalRelays.items.find((item) => item.id === firstRelay)?.drain, false);
  assert.equal(
    finalRelays.items.find((item) => item.id === secondConnected.connected_relay_id)?.drain,
    true,
  );
  console.log(
    `relay-e2e: failback ok (${firstRelay} -> ${secondConnected.connected_relay_id} -> ${firstRelay})`,
  );

  // 9B: unplanned hard relay death is not an administrative drain.
  // The CI runner owns this relay-b process; verify its exact environment
  // before killing it to avoid touching an unrelated or recycled PID.
  const standby = await jsonFetch(
    `/api/admin/relays/${encodeURIComponent("relay-a")}`,
    {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ drain: false }),
    },
  );
  assert.equal(standby.item.drain, false);
  const relayBPid = Number(
    fs.readFileSync("/tmp/commender-relay-b.pid", "utf8").trim(),
  );
  assert.ok(Number.isSafeInteger(relayBPid) && relayBPid > 1);
  const relayBEnv = fs.readFileSync(
    `/proc/${relayBPid}/environ`, "utf8",
  ).split("\0");
  assert.ok(relayBEnv.includes("CLUSTER_NODE_ID=relay-b"));
  assert.ok(relayBEnv.includes(
    "RELAY_PUBLIC_WS_URL=ws://127.0.0.1:8789/agent",
  ));
  const relayBCmd = fs.readFileSync(
    `/proc/${relayBPid}/cmdline`, "utf8",
  ).replaceAll("\0", " ");
  assert.match(relayBCmd, /node.*dist\/index\.js/);
  probeTask = continuousMcpProbe(deviceId);
  await waitFor(() => probeStats.successes >= 2, 15_000, 100);
  const firstCrashAttempts = probeStats.attempts;
  const firstCrashAt = Date.now();
  process.kill(relayBPid, "SIGKILL");

  // Heartbeat freshness is 45s, followed by the Agent's bounded route
  // refresh/backoff. No admin disconnect or drain of the dead relay.
  const crashRecovered = await waitFor(async () => {
    const devices = await jsonFetch("/api/devices", {
      headers: authHeaders,
    });
    const item = devices.items.find((candidate) => candidate.id === deviceId);
    return item?.online &&
      item.connected_relay_id === "relay-a" &&
      item.assigned_relay_id === "relay-a"
      ? item
      : null;
  }, 150_000, 500);
  assert.equal(crashRecovered.connected_relay_id, "relay-a");
  const firstFailoverMs = Date.now() - firstCrashAt;
  assert.ok(firstFailoverMs < 45_000,
    `Agent route-hint failover exceeded 45s: ${firstFailoverMs}ms`);
  const firstRecoveredSuccesses = probeStats.successes;
  await waitFor(() => probeStats.successes > firstRecoveredSuccesses, 15_000, 200);
  assert.ok(probeStats.attempts > firstCrashAttempts);
  const deadRelays = await jsonFetch("/api/admin/relays", {
    headers: authHeaders,
  });
  assert.equal(deadRelays.items.find((item) => item.id === "relay-b")?.healthy, false);

  const afterCrash = toolText(await rpc(512, "tools/call", {
    name: "system_info",
    arguments: { device_id: deviceId },
  }));
  assert.equal(typeof afterCrash.cpuCount, "number");
  const crashSearch = toolText(await rpc(513, "tools/call", {
    name: "start_search",
    arguments: {
      device_id: deviceId,
      path: tempRoot,
      query: "relay-progress-fixture",
      search_type: "files",
    },
  }));
  assert.equal(typeof crashSearch.searchId, "string");
  const crashResults = await waitFor(async () => {
    const page = toolText(await rpc(514, "tools/call", {
      name: "get_more_search_results",
      arguments: {
        device_id: deviceId,
        search_id: crashSearch.searchId,
        offset: 0,
        length: 10,
      },
    }));
    return page.status === "completed" ? page : null;
  }, 20_000);
  assert.ok(crashResults.items.length > 0);
  assert.ok(crashResults.scannedEntries >= 32);

  // The surviving relay must retain the signed-internal trust boundary.
  const survivingUnsigned = await fetch(
    "http://127.0.0.1:8788/internal/relay/request",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId,
        action: { kind: "system_info" },
      }),
    },
  );
  assert.equal(survivingUnsigned.status, 401);
  console.log("relay-e2e: unexpected relay-b SIGKILL recovered via relay-a with authenticated native MCP");


  // 9B: exercise the opposite *unplanned* relay death after recovering the
  // original node. This uses only CI-owned localhost processes, not servers.
  // A successful registry heartbeat alone is insufficient: the Agent must
  // reconnect and its existing native search session must remain readable.
  const relayBRestartLog = "/tmp/commender-relay-b-restart.log";
  const relayBLogFd = fs.openSync(relayBRestartLog, "a", 0o600);
  try {
    restartedRelayB = spawn(process.execPath, ["dist/index.js"], {
      cwd: path.join(repoRoot, "gateway"),
      stdio: ["ignore", relayBLogFd, relayBLogFd],
      env: {
        ...process.env,
        PUBLIC_BASE_URL: "http://127.0.0.1:8789",
        PORT: "8789",
        CLUSTER_NODE_ID: "relay-b",
        RELAY_REGION: "eu-central",
        RELAY_PUBLIC_WS_URL: "ws://127.0.0.1:8789/agent",
        RELAY_INTERNAL_BASE_URL: "http://127.0.0.1:8789",
        RELAY_MAX_DEVICES: "10",
      },
    });
  } finally {
    fs.closeSync(relayBLogFd);
  }
  assert.ok(restartedRelayB.pid > 1);
  fs.writeFileSync("/tmp/commender-relay-b.pid", String(restartedRelayB.pid));
  await waitFor(async () => {
    const response = await fetch("http://127.0.0.1:8789/health");
    if (!response.ok) return null;
    const relays = await jsonFetch("/api/admin/relays", { headers: authHeaders });
    const relayB = relays.items.find((item) => item.id === "relay-b");
    return relayB?.healthy && !relayB.drain ? relayB : null;
  }, 40_000, 500);

  // Verify both the node identity and command before sending a hard signal.
  // A stale/recycled PID must never be used to terminate an unrelated task.
  const relayAPid = Number(
    fs.readFileSync("/tmp/commender-relay-a.pid", "utf8").trim(),
  );
  assert.ok(Number.isSafeInteger(relayAPid) && relayAPid > 1);
  const relayAEnv = fs.readFileSync(
    `/proc/${relayAPid}/environ`, "utf8",
  ).split("\0");
  assert.ok(relayAEnv.includes("CLUSTER_NODE_ID=relay-a"));
  assert.ok(relayAEnv.includes(
    "RELAY_PUBLIC_WS_URL=ws://127.0.0.1:8788/agent",
  ));
  const relayACmd = fs.readFileSync(
    `/proc/${relayAPid}/cmdline`, "utf8",
  ).replaceAll("\0", " ");
  assert.match(relayACmd, /node.*dist\/index\.js/);
  const secondCrashAttempts = probeStats.attempts;
  const secondCrashAt = Date.now();
  process.kill(relayAPid, "SIGKILL");

  const secondCrashRecovered = await waitFor(async () => {
    const devices = await jsonFetch("/api/devices", { headers: authHeaders });
    const item = devices.items.find((candidate) => candidate.id === deviceId);
    return item?.online &&
      item.connected_relay_id === "relay-b" &&
      item.assigned_relay_id === "relay-b"
      ? item : null;
  }, 150_000, 500);
  assert.equal(secondCrashRecovered.connected_relay_id, "relay-b");
  const secondFailoverMs = Date.now() - secondCrashAt;
  assert.ok(secondFailoverMs < 45_000,
    `Agent route-hint failover exceeded 45s: ${secondFailoverMs}ms`);
  const secondRecoveredSuccesses = probeStats.successes;
  await waitFor(() => probeStats.successes > secondRecoveredSuccesses, 15_000, 200);
  assert.ok(probeStats.attempts > secondCrashAttempts);
  const afterSecondCrash = toolText(await rpc(515, "tools/call", {
    name: "system_info", arguments: { device_id: deviceId },
  }));
  assert.equal(typeof afterSecondCrash.cpuCount, "number");

  // The search completed before the relay crash. Its Agent-owned session
  // must still be accessible through the newly selected relay.
  const recoveredPage = toolText(await rpc(516, "tools/call", {
    name: "get_more_search_results",
    arguments: {
      device_id: deviceId, search_id: crashSearch.searchId,
      offset: 0, length: 10,
    },
  }));
  assert.equal(recoveredPage.status, "completed");
  assert.ok(recoveredPage.items.length > 0);
  // Registry health uses a 45s heartbeat freshness window. Agent route
  // recovery may finish sooner; do not mistake a stale healthy row for a
  // still-running relay. Wait for the registry to expire the dead node.
  const expiredRelayA = await waitFor(async () => {
    const relays = await jsonFetch("/api/admin/relays", {
      headers: authHeaders,
    });
    return relays.items.find((item) => item.id === "relay-a")?.healthy === false;
  }, 90_000, 500);
  assert.equal(expiredRelayA, true);
  const unsignedSecondRelay = await fetch(
    "http://127.0.0.1:8789/internal/relay/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId, action: { kind: "system_info" },
      }),
    },
  );
  assert.equal(unsignedSecondRelay.status, 401);
  console.log(
    "relay-e2e: second unexpected relay-a SIGKILL recovered via restarted relay-b; native search survived both failovers",
  );
  console.log(
    "relay-e2e: continuous authenticated MCP load recovered twice " +
      JSON.stringify({ ...probeStats, firstFailoverMs, secondFailoverMs }),
  );

} catch (error) {
  console.error(agentLog);
  throw error;
} finally {
  probeStop = true;
  if (probeTask) await probeTask;
  if (agent && !agent.killed) {
    agent.kill("SIGTERM");
  }
  if (restartedRelayB && !restartedRelayB.killed) {
    restartedRelayB.kill("SIGTERM");
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
