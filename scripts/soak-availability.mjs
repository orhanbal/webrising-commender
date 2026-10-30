#!/usr/bin/env node
// Isolated read-only availability probe. A CI mock run does NOT prove 24h uptime.
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const number = (name, fallback, min, max) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(name + " out of range");
  return value;
};
function config() {
  if (process.env.SOAK_CONFIRM_ISOLATED !== "YES") throw Error("SOAK_CONFIRM_ISOLATED=YES required");
  const key = process.env.CONTROL_API_KEY, deviceId = process.env.DEVICE_ID;
  if (!key || !deviceId) throw Error("CONTROL_API_KEY and DEVICE_ID required");
  const url = new URL(process.env.COMMANDER_CONTROL_URL || "http://127.0.0.1:8787");
  if (url.username || url.password || url.search || url.hash) throw Error("control URL must not contain credentials or query");
  if (!["http:", "https:"].includes(url.protocol)) throw Error("unsupported protocol");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!loopback && (url.protocol !== "https:" || process.env.SOAK_ALLOW_REMOTE !== "YES")) {
    throw Error("remote acceptance requires HTTPS and SOAK_ALLOW_REMOTE=YES");
  }
  const maxFailureRate = Number(process.env.SOAK_MAX_FAILURE_RATE ?? 0);
  if (!Number.isFinite(maxFailureRate) || maxFailureRate < 0 || maxFailureRate > 1) throw Error("invalid SOAK_MAX_FAILURE_RATE");
  return {
    url: url.origin, key, deviceId,
    duration: number("SOAK_DURATION_MS", 86400000, 1000, 172800000),
    interval: number("SOAK_INTERVAL_MS", 1000, 100, 60000),
    timeout: number("SOAK_REQUEST_TIMEOUT_MS", 5000, 100, 60000),
    minSamples: number("SOAK_MIN_SAMPLES", 100, 1, 1000000),
    maxP95: number("SOAK_MAX_P95_MS", 2000, 1, 60000),
    maxFailureRate, output: process.env.SOAK_OUTPUT || "soak-availability-result.json"
  };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function probe(c) {
  let response;
  try {
    response = await fetch(c.url + "/api/device/request", {
      method: "POST",
      headers: { Authorization: "Bearer " + c.key, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: c.deviceId, action: { kind: "system_info" } }),
      signal: AbortSignal.timeout(c.timeout)
    });
  } catch (error) {
    return { error: error?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK" };
  }
  if (!response.ok) return { error: "HTTP_" + response.status, fatal: response.status === 401 || response.status === 403 };
  const body = await response.json().catch(() => null);
  if (!body || !body.data || typeof body.data !== "object") return { error: "INVALID_RESPONSE" };
  return { ok: true };
}
async function main() {
  const c = config(), start = Date.now(), latencies = [], errors = {};
  let attempts = 0, successes = 0, fatal = null;
  do {
    const begin = performance.now(), result = await probe(c);
    attempts++;
    if (result.ok) { successes++; latencies.push(Math.round(performance.now() - begin)); }
    else {
      errors[result.error] = (errors[result.error] || 0) + 1;
      if (result.fatal) fatal = result.error;
    }
    if (fatal || Date.now() >= start + c.duration) break;
    await sleep(Math.min(c.interval, Math.max(0, start + c.duration - Date.now())));
  } while (true);
  latencies.sort((a, b) => a - b);
  const elapsedMs = Date.now() - start, failureRate = (attempts - successes) / attempts;
  const p95Ms = latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null;
  const passed = !fatal && elapsedMs >= c.duration && attempts >= c.minSamples &&
    failureRate <= c.maxFailureRate && p95Ms !== null && p95Ms < c.maxP95;
  const report = {
    schemaVersion: 1, startedAt: new Date(start).toISOString(), completedAt: new Date().toISOString(),
    requestedDurationMs: c.duration, elapsedMs, attempts, successes, failures: attempts - successes,
    failureRate, p95Ms, maxMs: latencies.length ? latencies[latencies.length - 1] : null,
    errorCounts: errors, fatal, passed,
    limits: { minSamples: c.minSamples, maxFailureRate: c.maxFailureRate, maxP95Ms: c.maxP95 },
    scope: "read-only authenticated MCP system_info; no physical multi-host or fault injection"
  };
  await mkdir(dirname(c.output), { recursive: true });
  const temporary = c.output + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, c.output);
  console.log(JSON.stringify(report));
  if (!passed) process.exitCode = 1;
}
main().catch(error => { console.error("soak-availability: " + error.message); process.exitCode = 1; });
