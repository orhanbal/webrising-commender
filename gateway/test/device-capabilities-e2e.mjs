// Device-local capabilities with a real Rust Agent (parity 3C).
// A device enrolled with --read-only --no-commands must refuse command
// execution and file writes even when a valid human approval is presented;
// reads keep working and policy_info reports the mode. Re-enabling is only
// possible on the device itself (capabilities subcommand + restart).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const apiKey = process.env.CONTROL_API_KEY;
if (!apiKey) throw new Error("CONTROL_API_KEY is required");
const here = path.dirname(fileURLToPath(import.meta.url));
const agentBinary = process.env.AGENT_BINARY
  || path.join(here, "../..", "target", "debug", process.platform === "win32" ? "webrising-commender.exe" : "webrising-commender");
const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wc-capabilities-"));
const allowed = path.join(root, "allowed");
fs.mkdirSync(allowed);
fs.writeFileSync(path.join(allowed, "readme.txt"), "readable\n");
const configPath = path.join(root, "agent.json");
let agent, log = "";

async function api(route, body) {
  const r = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${route} -> ${r.status} ${JSON.stringify(json)}`);
  return json;
}
let id = 0;
async function tool(name, args) {
  const r = await api("/mcp", { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
  return JSON.parse(r.result.content[0].text);
}
const approve = (deviceId, action) => api("/api/approvals", { deviceId, action, ttlSeconds: 120 }).then(r => r.approvalToken);
function start() {
  agent = spawn(agentBinary, ["--config", configPath, "run"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_DATA_HOME: path.join(root, "xdg") } });
  agent.stdout.on("data", d => { log += d; });
  agent.stderr.on("data", d => { log += d; });
}
async function stop() {
  if (!agent || agent.exitCode !== null) return;
  const exited = new Promise(r => agent.once("exit", r));
  agent.kill("SIGTERM");
  await exited;
}
async function online(deviceId) {
  for (let i = 0; i < 150; i++) {
    const list = await tool("devices_list", {});
    if (list.some(d => d.id === deviceId && d.online)) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("agent did not come online: " + log.slice(-2000));
}

try {
  const pairing = await api("/api/pairing", {});
  const enroll = spawnSync(agentBinary, ["--config", configPath, "enroll", "--control-url", base, "--pairing-code", pairing.pairingCode,
    "--allowed-root", allowed, "--read-only", "--no-commands"], { encoding: "utf8" });
  assert.equal(enroll.status, 0, enroll.stderr || enroll.stdout);
  const deviceId = JSON.parse(fs.readFileSync(configPath, "utf8")).deviceId;
  const shown = spawnSync(agentBinary, ["--config", configPath, "capabilities"], { encoding: "utf8" });
  assert.match(shown.stdout, /command execution: disabled/);
  assert.match(shown.stdout, /file writes: disabled/);
  start();
  await online(deviceId);

  const policy = await tool("policy_info", { device_id: deviceId });
  assert.equal(policy.agentMode, "read_only");
  assert.equal(policy.commandExecution, "disabled");
  assert.equal(policy.fileWrites, "disabled");
  const read = await tool("fs_read", { device_id: deviceId, path: path.join(allowed, "readme.txt") });
  assert.equal(read.content, "readable\n");

  const marker = path.join(allowed, "executed");
  const command = `printf x > '${marker}'`;
  const execToken = await approve(deviceId, { kind: "process_exec", command, cwd: allowed });
  const exec = await tool("process_exec", { device_id: deviceId, command, cwd: allowed, approval_token: execToken });
  assert.match(String(exec.error), /command execution is disabled on this device/, JSON.stringify(exec));
  assert.equal(fs.existsSync(marker), false, "command ran despite device policy");

  const taskToken = await approve(deviceId, { kind: "task_start", command, cwd: allowed });
  const task = await tool("task_start", { device_id: deviceId, command, cwd: allowed, approval_token: taskToken });
  assert.match(String(task.error), /command execution is disabled/);

  const target = path.join(allowed, "written.txt");
  const write = await tool("fs_write", { device_id: deviceId, path: target, content_base64: Buffer.from("w").toString("base64") });
  assert.match(String(write.error), /file writes are disabled on this device/, JSON.stringify(write));
  assert.equal(fs.existsSync(target), false);
  const deleteToken = await approve(deviceId, { kind: "fs_delete", path: path.join(allowed, "readme.txt"), recursive: false });
  const del = await tool("fs_delete", { device_id: deviceId, path: path.join(allowed, "readme.txt"), recursive: false, approval_token: deleteToken });
  assert.match(String(del.error), /file writes are disabled/);
  assert.ok(fs.existsSync(path.join(allowed, "readme.txt")));
  console.log("device-capabilities-e2e: read-only/no-commands device refused approved exec, task, write and delete; reads work");

  // Only the device owner can re-enable, locally, followed by a restart.
  await stop();
  const enable = spawnSync(agentBinary, ["--config", configPath, "capabilities", "--commands", "on", "--file-writes", "on"], { encoding: "utf8" });
  assert.equal(enable.status, 0, enable.stderr);
  start();
  await online(deviceId);
  const execToken2 = await approve(deviceId, { kind: "process_exec", command, cwd: allowed });
  const exec2 = await tool("process_exec", { device_id: deviceId, command, cwd: allowed, approval_token: execToken2 });
  assert.equal(exec2.exitCode, 0, JSON.stringify(exec2));
  assert.equal(fs.readFileSync(marker, "utf8"), "x");
  const write2 = await tool("fs_write", { device_id: deviceId, path: target, content_base64: Buffer.from("w").toString("base64") });
  assert.equal(write2.ok, true, JSON.stringify(write2));
  assert.equal((await tool("policy_info", { device_id: deviceId })).agentMode, "restricted");
  console.log("device-capabilities-e2e: locally re-enabled capabilities apply after restart");
  console.log("device-capabilities-e2e: ok");
} catch (error) {
  console.error(log.slice(-3000));
  throw error;
} finally {
  await stop();
  fs.rmSync(root, { recursive: true, force: true });
}
