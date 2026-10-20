#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const base = String(process.env.COMMANDER_CONTROL_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const apiKey = process.env.CONTROL_API_KEY;
const deviceId = process.env.DEVICE_ID;

function boundedInt(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

const iterations = boundedInt("SOAK_ITERATIONS", 10, 1, 1000);
const timeoutMs = boundedInt("SOAK_TIMEOUT_MS", 120_000, 10_000, 15 * 60_000);
const intervalMs = boundedInt("SOAK_POLL_MS", 1000, 250, 10_000);
const mode = String(process.env.SOAK_RESTART_MODE || "compose").toLowerCase();
const taskCommand = String(process.env.SOAK_TASK_COMMAND || "").trim();

if (!apiKey) throw new Error("CONTROL_API_KEY is required");
if (!deviceId) throw new Error("DEVICE_ID is required");
if (!["compose", "manual"].includes(mode)) throw new Error("SOAK_RESTART_MODE must be compose or manual");

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function waitUntil(label, predicate) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timeout${lastError ? `: ${lastError.message || lastError}` : ""}`);
}

async function device() {
  const devices = await request("/api/devices");
  return devices.items.find((item) => item.id === deviceId) || null;
}

async function waitOnline() {
  await waitUntil("device online", async () => (await device())?.online === true);
}

async function waitOffline() {
  await waitUntil("device offline", async () => {
    try {
      return (await device())?.online === false;
    } catch {
      return true;
    }
  });
}

async function lowRisk(action) {
  const result = await request("/api/device/request", {
    method: "POST",
    body: JSON.stringify({ deviceId, action }),
  });
  return result.data;
}

async function highRisk(action) {
  const approval = await request("/api/approvals", {
    method: "POST",
    body: JSON.stringify({ deviceId, action, ttlSeconds: 120 }),
  });
  const result = await request("/api/device/request", {
    method: "POST",
    body: JSON.stringify({
      deviceId,
      action,
      approvalToken: approval.approvalToken,
    }),
  });
  return result.data;
}

function restartComposeGateway() {
  const result = spawnSync("docker", ["compose", "restart", "gateway"], {
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker compose restart gateway exited ${result.status}`);
}

async function waitGatewayHealth() {
  await waitUntil("gateway health", async () => {
    const response = await fetch(base + "/health").catch(() => null);
    return response?.ok === true;
  });
}

console.log(`Commender soak: device=${deviceId} iterations=${iterations} mode=${mode}`);
await waitGatewayHealth();
await waitOnline();
await lowRisk({ kind: "system_info" });

let taskId = null;
if (taskCommand) {
  const started = await highRisk({
    kind: "task_start",
    command: taskCommand,
    timeoutMs: Math.min(24 * 60 * 60 * 1000, timeoutMs * (iterations + 2)),
  });
  taskId = started.taskId;
  console.log(`Persistent task started: ${taskId}`);
}

for (let i = 1; i <= iterations; i += 1) {
  console.log(`Iteration ${i}/${iterations}`);

  if (mode === "compose") {
    restartComposeGateway();
    await waitGatewayHealth();
  } else {
    console.log("Manual mode: interrupt gateway/network now.");
    await waitOffline();
    console.log("Offline observed; restore connectivity.");
  }

  await waitOnline();
  const info = await lowRisk({ kind: "system_info" });
  if (!info || typeof info !== "object") throw new Error("system_info returned invalid data");

  if (taskId) {
    const status = await lowRisk({ kind: "task_status", taskId });
    if (!status || status.taskId !== taskId) {
      throw new Error(`persistent task ${taskId} was not rediscovered`);
    }
  }

  console.log(`Iteration ${i}: gateway and device recovered`);
}

if (taskId) {
  try {
    await highRisk({ kind: "task_cancel", taskId });
    console.log(`Persistent task cleanup requested: ${taskId}`);
  } catch (error) {
    console.warn(`Task cleanup failed: ${error.message || error}`);
  }
}

console.log("Soak completed successfully.");
