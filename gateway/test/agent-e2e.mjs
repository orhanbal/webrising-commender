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
const repoRoot = path.resolve(here, "../..");
const agentBinary =
  process.env.AGENT_BINARY ||
  path.join(repoRoot, "target", "debug", process.platform === "win32" ? "webrising-commender.exe" : "webrising-commender");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "commender-agent-e2e-"));
const configPath = path.join(tempRoot, "agent.json");
let agent;
let agentLog = "";

const authHeaders = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

async function jsonFetch(route, options = {}) {
  const response = await fetch(base + route, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${route} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function rpc(id, method, params = undefined) {
  return jsonFetch("/mcp", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  });
}

function toolData(response) {
  const text = response?.result?.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

async function tool(id, name, args) {
  return toolData(await rpc(id, "tools/call", { name, arguments: args }));
}

async function approval(deviceId, action) {
  const result = await jsonFetch("/api/approvals", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ deviceId, action, ttlSeconds: 120 }),
  });
  return result.approvalToken;
}

async function waitFor(predicate, timeoutMs = 15000, intervalMs = 200) {
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
  throw new Error(`condition timeout; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

try {
  const pairing = await jsonFetch("/api/pairing", {
    method: "POST",
    headers: authHeaders,
    body: "{}",
  });

  const enroll = spawnSync(
    agentBinary,
    [
      "--config", configPath,
      "enroll",
      "--control-url", base,
      "--pairing-code", pairing.pairingCode,
      "--allowed-root", tempRoot,
    ],
    { encoding: "utf8" },
  );
  if (enroll.status !== 0) {
    throw new Error(`agent enrollment failed: ${enroll.stderr || enroll.stdout}`);
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(typeof config.deviceId, "string");
  const deviceId = config.deviceId;

  agent = spawn(agentBinary, ["--config", configPath, "run"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: "info" },
  });
  agent.stdout.on("data", (chunk) => { agentLog += chunk.toString(); });
  agent.stderr.on("data", (chunk) => { agentLog += chunk.toString(); });

  await waitFor(async () => {
    const devices = await jsonFetch("/api/devices", { headers: authHeaders });
    return devices.items.some((item) => item.id === deviceId && item.online);
  });

  const info = await tool(101, "system_info", { device_id: deviceId });
  assert.equal(typeof info.cpuCount, "number");

  const filePath = path.join(tempRoot, "hello.txt");
  const content = Buffer.from("hello-from-real-agent", "utf8").toString("base64");

  const write = await tool(102, "fs_write", {
    device_id: deviceId,
    path: filePath,
    content_base64: content,
    create_parents: true,
  });
  assert.equal(write.ok, true);

  const read = await tool(103, "fs_read", {
    device_id: deviceId,
    path: filePath,
  });
  assert.equal(read.encoding, "utf8");
  assert.equal(read.content, "hello-from-real-agent");

  const execToken = await approval(deviceId, "process_exec");
  const executed = await tool(104, "process_exec", {
    device_id: deviceId,
    command: "printf agent-process-ok",
    cwd: tempRoot,
    timeout_ms: 10000,
    approval_token: execToken,
  });
  assert.equal(executed.success, true);
  assert.match(executed.stdout, /agent-process-ok/);

  const startToken = await approval(deviceId, "terminal_start");
  const started = await tool(105, "terminal_start", {
    device_id: deviceId,
    cwd: tempRoot,
    cols: 100,
    rows: 30,
    approval_token: startToken,
  });
  assert.equal(typeof started.sessionId, "string");

  await tool(106, "terminal_input", {
    device_id: deviceId,
    session_id: started.sessionId,
    data_base64: Buffer.from("echo PTY_AGENT_OK\n", "utf8").toString("base64"),
  });

  let terminalText = "";
  await waitFor(async () => {
    const chunk = await tool(107, "terminal_read", {
      device_id: deviceId,
      session_id: started.sessionId,
      max_bytes: 65536,
    });
    terminalText += chunk.text || "";
    return terminalText.includes("PTY_AGENT_OK");
  }, 10000, 250);

  const stopToken = await approval(deviceId, "terminal_stop");
  const stopped = await tool(108, "terminal_stop", {
    device_id: deviceId,
    session_id: started.sessionId,
    approval_token: stopToken,
  });
  assert.equal(stopped.ok, true);

  const deleteToken = await approval(deviceId, "fs_delete");
  const deleted = await tool(109, "fs_delete", {
    device_id: deviceId,
    path: filePath,
    recursive: false,
    approval_token: deleteToken,
  });
  assert.equal(deleted.ok, true);
  assert.equal(fs.existsSync(filePath), false);

  await jsonFetch(`/api/devices/${deviceId}/disconnect`, {
    method: "POST",
    headers: authHeaders,
    body: "{}",
  });

  await waitFor(async () => {
    const devices = await jsonFetch("/api/devices", { headers: authHeaders });
    return devices.items.some((item) => item.id === deviceId && !item.online);
  }, 5000, 50).catch(() => true);

  await waitFor(async () => {
    const devices = await jsonFetch("/api/devices", { headers: authHeaders });
    return devices.items.some((item) => item.id === deviceId && item.online);
  }, 10000, 200);

  const infoAfterReconnect = await tool(110, "system_info", { device_id: deviceId });
  assert.equal(typeof infoAfterReconnect.totalMemory, "number");

  console.log("agent-e2e: ok");
} catch (error) {
  console.error(error);
  if (agentLog) console.error("\n--- agent log ---\n" + agentLog);
  process.exitCode = 1;
} finally {
  if (agent && !agent.killed) {
    agent.kill("SIGTERM");
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
