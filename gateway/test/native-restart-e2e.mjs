import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** Real Rust Agent + real Gateway crash/restart acceptance.
 * Runs exclusively on disposable GitHub Actions CI and loopback endpoints.
 * No physical server, cloud account or production machine is ever contacted.
 */
if (process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("native-restart-e2e is restricted to GitHub Actions CI");
}
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const target = new URL(base);
if (!["127.0.0.1", "localhost", "::1"].includes(target.hostname) ||
    target.protocol !== "http:") {
  throw new Error("native-restart-e2e requires loopback HTTP Gateway");
}
const contentMode = process.argv[2] === "content";
if (process.argv[2] && !contentMode) throw new Error("unknown native restart test mode");
const query = contentMode ? "native-content-recovery-needle" : "native-recovery-needle";
const key = process.env.CONTROL_API_KEY;
if (!key || !process.env.DATABASE_URL) throw new Error("missing CI database/control credentials");
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const agentBinary = process.env.AGENT_BINARY ||
  path.join(repoRoot, "target", "debug", "webrising-commender");
const gatewayDir = path.join(repoRoot, "gateway");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "commender-native-restart-"));
const config = path.join(root, "agent.json");
const searchRoot = path.join(root, "bulk-search");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const headers = { Authorization: "Bearer " + key, "Content-Type": "application/json" };
let native;
let gateway;
let nativeLog = "";
async function api(route, method = "GET", body) {
  const response = await fetch(base + route, {
    method, headers, signal: AbortSignal.timeout(4000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("CI Gateway HTTP " + response.status + " at " + route);
  return result;
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
async function until(predicate, timeout = 40000, interval = 35) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error("native-restart-e2e timed out" +
    (lastError ? ": " + lastError.message : ""));
}
function launchAgent() {
  const child = spawn(agentBinary, ["--config", config, "run"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: "warn" },
  });
  child.stdout.on("data", chunk => { nativeLog += chunk.toString().slice(-4000); });
  child.stderr.on("data", chunk => { nativeLog += chunk.toString().slice(-4000); });
  child.on("error", error => { nativeLog += String(error); });
  return child;
}
try {
  fs.mkdirSync(searchRoot);
  // Native filename scanner processes at most 100k entries. Multiple complete
  // directories create checkpoints; tens of thousands of nonmatching entries
  // leave enough work to observe and crash the active Rust worker.
  const expectedPaths = [];
  for (let group = 0; group < 110; group++) {
    const dir = path.join(searchRoot, "part-" + String(group).padStart(3, "0"));
    fs.mkdirSync(dir);
    // Content searches open every file and have a strict 10-second native
    // budget. Keep this fixture large enough to checkpoint, but small enough
    // to finish on slow CI runners; filename scans are considerably cheaper.
    const nonMatches = contentMode ? 75 : 420;
    for (let index = 0; index < nonMatches; index++) {
      fs.writeFileSync(path.join(dir, "other-" + String(index).padStart(4, "0") + ".txt"), "");
    }
    if (contentMode) {
      // Every completed directory contributes one real matching line, so the
      // native checkpoint must validate previously matched *file contents*.
      const matchPath = path.join(dir, "content-match.txt");
      fs.writeFileSync(matchPath, query + " in group " + group);
      expectedPaths.push(matchPath);
    }
  }
  if (!contentMode) {
    const matchPath = path.join(searchRoot, "part-000", "native-recovery-needle.txt");
    fs.writeFileSync(matchPath, query);
    expectedPaths.push(matchPath);
  }
  const pairing = await api("/api/pairing", "POST", {});
  const enroll = spawnSync(agentBinary, [
    "--config", config, "enroll", "--control-url", base,
    "--pairing-code", pairing.pairingCode, "--allowed-root", root,
  ], { encoding: "utf8" });
  if (enroll.status !== 0) throw new Error("CI native agent enrollment failed: " + enroll.stderr);
  const enrolled = JSON.parse(fs.readFileSync(config, "utf8"));
  const deviceId = enrolled.deviceId;
  native = launchAgent();
  await until(async () => {
    const devices = await api("/api/devices");
    return devices.items.some(item => item.id === deviceId && item.online);
  }, 15000, 100);

  const started = await tool(8101, "start_search", {
    device_id: deviceId, path: searchRoot,
    query, search_type: contentMode ? "content" : "files",
  });
  assert.equal(started.status, "running");
  // Poll directly for a fully persisted *safe* checkpoint, rather than
  // using MCP snapshots which might race the PostgreSQL write.
  const checkpointed = await until(async () => {
    const response = await pool.query(
      "select status, checkpoint, progress_sequence from search_sessions where id=$1",
      [started.searchId],
    );
    const row = response.rows[0];
    return row?.status === "running" &&
      Array.isArray(row.checkpoint?.pending) &&
      row.checkpoint.pending.length > 0 &&
      (!contentMode || row.checkpoint.items?.length > 0) ? row : false;
  }, 20000, 10);
  assert.ok(checkpointed.progress_sequence >= 1);
  assert.ok(!native.killed && native.exitCode === null);
  const oldPid = Number(fs.readFileSync("/tmp/commender-gateway.pid", "utf8"));
  assert.ok(Number.isSafeInteger(oldPid) && oldPid > 1);
  process.kill(oldPid, "SIGKILL");
  native.kill("SIGKILL");
  await until(async () => {
    try { await fetch(base + "/health/live", { signal: AbortSignal.timeout(250) }); return false; }
    catch { return true; }
  }, 4000, 25);
  const crashed = await pool.query(
    "select status, checkpoint from search_sessions where id=$1", [started.searchId],
  );
  assert.equal(crashed.rows[0].status, "running",
    "Native scan must be unfinished when both processes crash");
  assert.ok(crashed.rows[0].checkpoint, "Safe native checkpoint must survive the crash");

  const logFd = fs.openSync("/tmp/commender-gateway-native-restart.log", "a");
  gateway = spawn(process.execPath, ["dist/index.js"], {
    cwd: gatewayDir, env: process.env, detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);
  assert.ok(gateway.pid);
  fs.writeFileSync("/tmp/commender-gateway.pid", String(gateway.pid));
  gateway.unref();
  await until(async () => (await api("/health")).database === "ok", 30000, 100);
  native = launchAgent();
  await until(async () => {
    const devices = await api("/api/devices");
    return devices.items.some(item => item.id === deviceId && item.online);
  }, 18000, 100);
  const completed = await until(async () => {
    const page = await tool(8102, "get_more_search_results", {
      device_id: deviceId, search_id: started.searchId, offset: 0, length: 10,
    });
    if (page.status === "error" || page.status === "stopped") {
      throw new Error("Native restart recovery failed: " + JSON.stringify(page));
    }
    return page.status === "completed" ? page : false;
  }, 50000, 150);
  assert.equal(completed.searchId, started.searchId);
  assert.equal(completed.timedOut, false,
    "Native restart fixture must finish within its bounded execution budget");
  assert.equal(completed.truncated, false,
    "Native restart fixture must not silently truncate search results");
  const allItems = [];
  let offset = 0;
  for (;;) {
    const page = await tool(8103 + offset, "get_more_search_results", {
      device_id: deviceId, search_id: started.searchId, offset, length: 100,
    });
    assert.equal(page.status, "completed");
    allItems.push(...page.items);
    if (!page.hasMore) break;
    offset += page.items.length;
    assert.ok(offset <= 500 && page.items.length > 0);
  }
  assert.deepEqual(allItems.map(item => item.path).sort(), expectedPaths.sort());
  if (contentMode) {
    assert.equal(allItems.length, 110);
    assert.ok(allItems.every(item => item.line === 1 &&
      typeof item.preview === "string" && item.preview.includes(query)));
    assert.ok(completed.scannedBytes > checkpointed.checkpoint.scannedBytes);
  }
  assert.ok(completed.scannedEntries > 0);
  assert.ok(completed.progressUpdates > checkpointed.progress_sequence,
    "Recovered Rust Agent must publish newer session progress");
  console.log("native-restart-e2e: PASS (" +
    (contentMode ? "match-bearing content" : "filename") +
    ", real Rust Agent + Gateway SIGKILL/restart, same searchId, persisted checkpoint)");
} catch (error) {
  console.error(error);
  console.error(nativeLog.slice(-5000));
  process.exitCode = 1;
} finally {
  if (native && !native.killed && native.exitCode === null) native.kill("SIGTERM");
  fs.rmSync(root, { recursive: true, force: true });
  await pool.end();
}
