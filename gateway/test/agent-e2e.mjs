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

  const policyInfo = await tool(210, "policy_info", { device_id: deviceId });
  assert.equal(policyInfo.agentMode, "restricted");
  assert.ok(policyInfo.allowedRoots.includes(tempRoot));

  // Real Agent ↔ Gateway ↔ MCP Excel reading, using a deterministic XLSX fixture.
  // No Python/Office executable or hosted document service is required at runtime.
  const workbookPath = path.join(tempRoot, "sample.xlsx");
  const workbookFixture = fs.readFileSync(path.join(here, "fixtures", "sample-workbook.xlsx.base64"), "utf8").trim();
  fs.writeFileSync(workbookPath, Buffer.from(workbookFixture, "base64"));
  const workbookInfo = await tool(230, "xlsx_inspect", {
    device_id: deviceId, path: workbookPath,
  });
  assert.deepEqual(workbookInfo.sheets, ["Sample"]);
  assert.equal(workbookInfo.readOnly, true);
  assert.equal(workbookInfo.macrosExecuted, false);
  const workbookPage = await tool(231, "xlsx_read_range", {
    device_id: deviceId, path: workbookPath, sheet: "Sample",
    start_row: 1, start_column: 1, row_count: 2, column_count: 2,
  });
  assert.equal(workbookPage.cells.length, 4);
  assert.deepEqual(workbookPage.cells[0], {
    row: 1, column: 1, data: { type: "string", value: "Label" },
  });
  assert.ok(workbookPage.cells.some((cell) =>
    cell.row === 2 && cell.column === 2 && cell.data.value === 42));
  const badWorkbookSheet = await tool(232, "xlsx_read_range", {
    device_id: deviceId, path: workbookPath, sheet: "Missing",
    start_row: 1, start_column: 1, row_count: 1, column_count: 1,
  });
  assert.match(badWorkbookSheet.error, /sheet not found/i);
  const badWorkbookRange = await tool(233, "xlsx_read_range", {
    device_id: deviceId, path: workbookPath, sheet: "Sample",
    start_row: 1, start_column: 1, row_count: 51, column_count: 1,
  });
  assert.equal(typeof badWorkbookRange.error, "string");
  const outsideWorkbookDir = fs.mkdtempSync(path.join(os.tmpdir(), "commander-outside-xlsx-"));
  try {
    const outsideWorkbookPath = path.join(outsideWorkbookDir, "outside.xlsx");
    fs.copyFileSync(workbookPath, outsideWorkbookPath);
    const outsideWorkbook = await tool(234, "xlsx_inspect", {
      device_id: deviceId, path: outsideWorkbookPath,
    });
    assert.match(outsideWorkbook.error, /outside configured allowed roots/i);
  } finally {
    fs.rmSync(outsideWorkbookDir, { recursive: true, force: true });
  }
  const invalidWorkbookPath = path.join(tempRoot, "broken.xlsx");
  fs.writeFileSync(invalidWorkbookPath, "not a ZIP file", "utf8");
  const invalidWorkbook = await tool(236, "xlsx_inspect", {
    device_id: deviceId, path: invalidWorkbookPath,
  });
  assert.equal(typeof invalidWorkbook.error, "string");
  const macroNamedWorkbook = path.join(tempRoot, "sample.xlsm");
  fs.copyFileSync(workbookPath, macroNamedWorkbook);
  const macroInfo = await tool(235, "xlsx_inspect", {
    device_id: deviceId, path: macroNamedWorkbook,
  });
  assert.deepEqual(macroInfo.sheets, ["Sample"]);
  assert.equal(macroInfo.macrosExecuted, false);

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

  const linesPath = path.join(tempRoot, "paged-lines.txt");
  fs.writeFileSync(linesPath, "first\nsecond\nthird\nfourth\n", "utf8");
  const page = await tool(201, "fs_read_lines", {
    device_id: deviceId, path: linesPath, offset_lines: 1, limit_lines: 2,
  });
  assert.deepEqual(page.lines, ["second", "third"]);
  assert.equal(page.totalLines, 4);
  assert.equal(page.startLine, 2);
  assert.equal(page.truncated, true);

  const tail = await tool(202, "fs_read_lines", {
    device_id: deviceId, path: linesPath, offset_lines: -2, limit_lines: 2,
  });
  assert.deepEqual(tail.lines, ["third", "fourth"]);
  assert.equal(tail.endLine, 4);
  assert.equal(tail.truncated, false);

  const batch = await tool(203, "fs_read_multiple", {
    device_id: deviceId, paths: [filePath, linesPath, path.join(tempRoot, "nonexistent.txt")],
  });
  assert.equal(batch.count, 3);
  assert.equal(batch.items[0].ok, true);
  assert.equal(batch.items[0].data.content, "hello-from-real-agent");
  assert.equal(batch.items[1].ok, true);
  assert.equal(batch.items[2].ok, false);

  // Exercise the advertised ten-file boundary with a real native agent.
  const batchPaths = Array.from({ length: 10 }, (_, index) => path.join(tempRoot, `batch-${index}.txt`));
  batchPaths.forEach((item, index) => fs.writeFileSync(item, `batch-content-${index}`, "utf8"));
  const fullBatch = await tool(211, "fs_read_multiple", {
    device_id: deviceId, paths: batchPaths,
  });
  assert.equal(fullBatch.count, 10);
  assert.equal(fullBatch.items.length, 10);
  fullBatch.items.forEach((item, index) => {
    assert.equal(item.ok, true);
    assert.equal(item.data.content, `batch-content-${index}`);
  });
  const oversizedBatch = await tool(212, "fs_read_multiple", {
    device_id: deviceId, paths: [...batchPaths, filePath],
  });
  assert.equal(oversizedBatch.error, "invalid_batch_read_arguments");
  const limitedBatch = await tool(213, "fs_read_multiple", {
    device_id: deviceId, paths: [filePath], max_bytes: 3,
  });
  assert.equal(limitedBatch.items[0].ok, false);

  const rejectedOutsideRoot = await tool(204, "fs_read_lines", {
    device_id: deviceId, path: path.join(os.tmpdir(), "outside-allowed-root.txt"),
  });
  assert.equal(typeof rejectedOutsideRoot.error, "string");

  const append = await tool(206, "fs_append", {
    device_id: deviceId,
    path: linesPath,
    content_base64: Buffer.from("fifth\n").toString("base64"),
  });
  assert.equal(append.ok, true);
  const appendedRead = await tool(207, "fs_read_lines", {
    device_id: deviceId, path: linesPath, offset_lines: -1, limit_lines: 1,
  });
  assert.deepEqual(appendedRead.lines, ["fifth"]);

  const tree = await tool(114, "fs_tree", {
    device_id: deviceId,
    path: tempRoot,
    max_depth: 3,
    max_entries: 100,
  });
  assert.ok(tree.items.some((item) => item.name === "hello.txt"));

  const fileSearch = await tool(115, "fs_search", {
    device_id: deviceId,
    path: tempRoot,
    query: "hello",
    max_results: 20,
  });
  assert.ok(fileSearch.items.some((item) => item.path === filePath));

  // Filename matching must honor the case_sensitive flag all the way to the Rust Agent.
  const mixedCaseName = path.join(tempRoot, "CaseMatch.txt");
  const lowerCaseName = path.join(tempRoot, "casematch.txt");
  fs.writeFileSync(mixedCaseName, "case test", "utf8");
  fs.writeFileSync(lowerCaseName, "case test", "utf8");
  const exactNameSearch = await tool(220, "fs_search", {
    device_id: deviceId, path: tempRoot, query: "CaseMatch", case_sensitive: true,
  });
  assert.equal(exactNameSearch.caseSensitive, true);
  assert.ok(exactNameSearch.items.some((item) => item.path === mixedCaseName));
  assert.ok(!exactNameSearch.items.some((item) => item.path === lowerCaseName));
  const foldedNameSearch = await tool(221, "fs_search", {
    device_id: deviceId, path: tempRoot, query: "CaseMatch", case_sensitive: false,
  });
  assert.ok(foldedNameSearch.items.some((item) => item.path === mixedCaseName));
  assert.ok(foldedNameSearch.items.some((item) => item.path === lowerCaseName));

  const caseSession = await tool(222, "start_search", {
    device_id: deviceId, path: tempRoot, query: "CaseMatch",
    search_type: "files", case_sensitive: true,
  });
  const casePage = await waitFor(async () => {
    const result = await tool(223, "get_more_search_results", {
      device_id: deviceId, search_id: caseSession.searchId, offset: 0, length: 20,
    });
    return result.status === "completed" ? result : false;
  });
  assert.ok(casePage.items.some((item) => item.path === mixedCaseName));
  assert.ok(!casePage.items.some((item) => item.path === lowerCaseName));

  const codeSearch = await tool(116, "code_search", {
    device_id: deviceId,
    path: tempRoot,
    query: "hello-from-real-agent",
    max_results: 20,
  });
  assert.ok(codeSearch.items.some((item) => item.path === filePath && item.line === 1));

  // A search session must expose a stable paged snapshot and become empty
  // after explicit cancellation. This does not claim native streaming support.
  const startedSearch = await tool(214, "start_search", {
    device_id: deviceId, path: tempRoot, query: "hello-from-real-agent", search_type: "content",
  });
  assert.equal(typeof startedSearch.searchId, "string");
  const completedSearch = await waitFor(async () => {
    const result = await tool(215, "get_more_search_results", {
      device_id: deviceId, search_id: startedSearch.searchId, offset: 0, length: 1,
    });
    return result.status === "completed" ? result : false;
  });
  assert.equal(completedSearch.items.length, 1);
  assert.equal(completedSearch.items[0].path, filePath);
  assert.equal(completedSearch.offset, 0);
  const searches = await tool(216, "list_searches", { device_id: deviceId });
  assert.ok(searches.items.some((item) => item.searchId === startedSearch.searchId));
  const invalidSearchPage = await tool(217, "get_more_search_results", {
    device_id: deviceId, search_id: startedSearch.searchId, offset: 0, length: 101,
  });
  assert.equal(invalidSearchPage.error, "invalid_search_page");
  const stoppedSearch = await tool(218, "stop_search", {
    device_id: deviceId, search_id: startedSearch.searchId,
  });
  assert.equal(stoppedSearch.status, "stopped");
  const stoppedPage = await tool(219, "get_more_search_results", {
    device_id: deviceId, search_id: startedSearch.searchId, offset: 0, length: 1,
  });
  assert.equal(stoppedPage.status, "stopped");
  assert.deepEqual(stoppedPage.items, []);

  const replaced = await tool(117, "fs_replace", {
    device_id: deviceId,
    path: filePath,
    search: "hello-from-real-agent",
    replace: "hello-from-search-edit",
  });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.replacements, 1);

  assert.equal(typeof replaced.sha256, "string");
  assert.equal(replaced.sha256.length, 64);

  const staleEdit = await tool(209, "fs_replace", {
    device_id: deviceId,
    path: filePath,
    search: "hello-from-search-edit",
    replace: "should-not-be-written",
    expected_sha256: "0".repeat(64),
  });
  assert.equal(typeof staleEdit.error, "string");
  assert.equal(fs.readFileSync(filePath, "utf8"), "hello-from-search-edit");

  const readAfterReplace = await tool(118, "fs_read", {
    device_id: deviceId,
    path: filePath,
  });
  assert.equal(readAfterReplace.content, "hello-from-search-edit");

  const movedPath = path.join(tempRoot, "moved.txt");
  const moved = await tool(119, "fs_move", {
    device_id: deviceId,
    source: filePath,
    destination: movedPath,
  });
  assert.equal(moved.ok, true);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(movedPath), true);

  const readAfterMove = await tool(120, "fs_read", {
    device_id: deviceId,
    path: movedPath,
  });
  assert.equal(readAfterMove.content, "hello-from-search-edit");

  const execAction = {
    kind: "process_exec",
    command: "printf agent-process-ok",
    cwd: tempRoot,
    timeoutMs: 10000,
  };
  const execToken = await approval(deviceId, execAction);
  const executed = await tool(104, "process_exec", {
    device_id: deviceId,
    command: "printf agent-process-ok",
    cwd: tempRoot,
    timeout_ms: 10000,
    approval_token: execToken,
  });
  assert.equal(executed.success, true);
  assert.match(executed.stdout, /agent-process-ok/);

  const startAction = {
    kind: "terminal_start",
    cwd: tempRoot,
    cols: 100,
    rows: 30,
  };
  const startToken = await approval(deviceId, startAction);
  const started = await tool(105, "terminal_start", {
    device_id: deviceId,
    cwd: tempRoot,
    cols: 100,
    rows: 30,
    approval_token: startToken,
  });
  assert.equal(typeof started.sessionId, "string");

  const terminals = await tool(121, "terminal_list", {
    device_id: deviceId,
  });
  assert.ok(terminals.items.some((item) => item.sessionId === started.sessionId && item.running));

  await tool(106, "terminal_input", {
    device_id: deviceId,
    session_id: started.sessionId,
    data_base64: Buffer.from("echo PTY_AGENT_OK\n", "utf8").toString("base64"),
  });

  await waitFor(async () => {
    const snapshot = await tool(205, "terminal_read_page", {
      device_id: deviceId,
      session_id: started.sessionId,
      offset_bytes: -65536,
      max_bytes: 65536,
    });
    assert.equal(typeof snapshot.bufferedBytes, "number");
    return String(snapshot.text).includes("PTY_AGENT_OK");
  }, 10000, 250);

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

  const historyAfterDrain = await tool(206, "terminal_read_page", {
    device_id: deviceId,
    session_id: started.sessionId,
    offset_bytes: -65536,
    max_bytes: 65536,
  });
  assert.match(historyAfterDrain.text, /PTY_AGENT_OK/);
  assert.equal(typeof historyAfterDrain.totalOutputBytes, "number");
  assert.equal(typeof historyAfterDrain.retainedStartBytes, "number");
  assert.equal(historyAfterDrain.truncatedBeforeOffset, false);
  const absolutePage = await tool(207, "terminal_read_page", {
    device_id: deviceId,
    session_id: started.sessionId,
    offset_bytes: historyAfterDrain.offsetBytes,
    max_bytes: 65536,
  });
  assert.ok(absolutePage.text.startsWith(historyAfterDrain.text));
  assert.ok(absolutePage.nextOffsetBytes >= historyAfterDrain.nextOffsetBytes);

  const stopToken = await approval(deviceId, {
    kind: "terminal_stop",
    sessionId: started.sessionId,
  });
  const stopped = await tool(108, "terminal_stop", {
    device_id: deviceId,
    session_id: started.sessionId,
    approval_token: stopToken,
  });
  assert.equal(stopped.ok, true);

  const terminalsAfterStop = await tool(122, "terminal_list", {
    device_id: deviceId,
  });
  assert.ok(!terminalsAfterStop.items.some((item) => item.sessionId === started.sessionId));

  const taskAction = {
    kind: "task_start",
    command: "sleep 1; printf PERSISTENT_TASK_OK",
    cwd: tempRoot,
    timeoutMs: 10000,
  };
  const taskToken = await approval(deviceId, taskAction);
  const persistentTask = await tool(109, "task_start", {
    device_id: deviceId,
    command: "sleep 1; printf PERSISTENT_TASK_OK",
    cwd: tempRoot,
    timeout_ms: 10000,
    approval_token: taskToken,
  });
  assert.equal(typeof persistentTask.taskId, "string");

  await jsonFetch(`/api/devices/${deviceId}/disconnect`, {
    method: "POST",
    headers: authHeaders,
    body: "{}",
  });

  await waitFor(async () => {
    const devices = await jsonFetch("/api/devices", { headers: authHeaders });
    return devices.items.some((item) => item.id === deviceId && item.online);
  }, 10000, 200);

  const taskListAfterReconnect = await tool(123, "task_list", {
    device_id: deviceId,
  });
  assert.ok(taskListAfterReconnect.items.some((item) => item.taskId === persistentTask.taskId));

  await waitFor(async () => {
    const status = await tool(110, "task_status", {
      device_id: deviceId,
      task_id: persistentTask.taskId,
    });
    if (status.status === "failed") throw new Error(status.error || "persistent task failed");
    return status.status === "completed" ? status : false;
  }, 10000, 250);

  const finalTaskStatus = await tool(111, "task_status", {
    device_id: deviceId,
    task_id: persistentTask.taskId,
  });
  assert.match(finalTaskStatus.result.stdout, /PERSISTENT_TASK_OK/);

  const deleteToken = await approval(deviceId, {
    kind: "fs_delete",
    path: movedPath,
    recursive: false,
  });
  const deleted = await tool(112, "fs_delete", {
    device_id: deviceId,
    path: movedPath,
    recursive: false,
    approval_token: deleteToken,
  });
  assert.equal(deleted.ok, true);
  assert.equal(fs.existsSync(movedPath), false);

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

  const infoAfterReconnect = await tool(113, "system_info", { device_id: deviceId });
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
