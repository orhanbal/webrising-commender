import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const mcpCasTarget = path.join(tempRoot, "mcp-midstage-race.txt");
const mcpCasMarker = path.join(tempRoot, "mcp-midstage.marker");
const mcpCasRelease = path.join(tempRoot, "mcp-midstage.release");
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

  // Reuse the same enrollment and private XDG directory across a hard restart.
  // The restarted Agent must not rely on in-memory undo state.
  const startAgent = () => {
    const child = spawn(agentBinary, ["--config", configPath, "run"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RUST_LOG: "info",
        XDG_DATA_HOME: path.join(tempRoot, "xdg-data"),
        WCF_MCP_CAS_TARGET: mcpCasTarget,
        WCF_MCP_CAS_MARKER: mcpCasMarker,
        WCF_MCP_CAS_RELEASE: mcpCasRelease,
      },
    });
    child.stdout.on("data", (chunk) => { agentLog += chunk.toString(); });
    child.stderr.on("data", (chunk) => { agentLog += chunk.toString(); });
    return child;
  };
  agent = startAgent();

  await waitFor(async () => {
    const devices = await jsonFetch("/api/devices", { headers: authHeaders });
    return devices.items.some((item) => item.id === deviceId && item.online);
  });

  const info = await tool(101, "system_info", { device_id: deviceId });
  assert.equal(typeof info.cpuCount, "number");

  const policyInfo = await tool(210, "policy_info", { device_id: deviceId });
  assert.equal(policyInfo.agentMode, "restricted");
  assert.ok(policyInfo.allowedRoots.includes(tempRoot));

  // Header-only image metadata travels through MCP/Gateway/native Agent and
  // must reject malformed data, extension spoofing and out-of-root access.
  const pngPath = path.join(tempRoot, "pixel.png");
  fs.writeFileSync(pngPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2m0AAAAASUVORK5CYII=", "base64"));
  const imageInfo = await tool(260, "image_inspect", { device_id: deviceId, path: pngPath });
  assert.equal(imageInfo.format, "PNG", JSON.stringify(imageInfo));
  assert.equal(imageInfo.width, 1);
  assert.equal(imageInfo.height, 1);
  assert.equal(imageInfo.readOnly, true);
  assert.equal(imageInfo.pixelsDecoded, false);
  const gifPath = path.join(tempRoot, "pixel.gif");
  fs.writeFileSync(gifPath, Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64"));
  const gifInfo = await tool(261, "image_inspect", { device_id: deviceId, path: gifPath });
  assert.equal(gifInfo.format, "GIF", JSON.stringify(gifInfo));
  assert.equal(gifInfo.width, 1);
  const brokenImage = path.join(tempRoot, "broken.png");
  fs.writeFileSync(brokenImage, Buffer.from("not a png"));
  assert.equal(typeof (await tool(262, "image_inspect", { device_id: deviceId, path: brokenImage })).error, "string");
  const fakeJpeg = path.join(tempRoot, "spoof.jpg");
  fs.copyFileSync(pngPath, fakeJpeg);
  assert.match((await tool(263, "image_inspect", { device_id: deviceId, path: fakeJpeg })).error, /extension does not match/i);
  const outsideImageDir = fs.mkdtempSync(path.join(os.tmpdir(), "commander-outside-image-"));
  try {
    const outsideImage = path.join(outsideImageDir, "outside.png");
    fs.copyFileSync(pngPath, outsideImage);
    assert.match((await tool(264, "image_inspect", { device_id: deviceId, path: outsideImage })).error, /outside configured allowed roots/i);
  } finally {
    fs.rmSync(outsideImageDir, { recursive: true, force: true });
  }

  // Read-only DOCX tools must preserve Unicode, decode XML entities, and enforce
  // root, archive, and pagination boundaries through the real native Agent.
  const documentPath = path.join(tempRoot, "sample.docx");
  const documentFixture = fs.readFileSync(path.join(here, "fixtures", "sample-document.docx.base64"), "utf8").trim();
  fs.writeFileSync(documentPath, Buffer.from(documentFixture, "base64"));
  const docInfo = await tool(250, "docx_inspect", { device_id: deviceId, path: documentPath });
  assert.equal(docInfo.paragraphCount, 6, JSON.stringify(docInfo));
  assert.equal(docInfo.tableCount, 1);
  assert.equal(docInfo.readOnly, true);
  assert.equal(docInfo.externalResourcesLoaded, false);
  const docPage = await tool(251, "docx_read_paragraphs", {
    device_id: deviceId, path: documentPath, offset: 0, limit: 2,
  });
  assert.deepEqual(docPage.items.map((item) => item.text), ["Merhaba & dünya", "Sol"]);
  assert.equal(docPage.nextOffset, 2);
  assert.equal(docPage.hasMore, true);
  assert.equal(docPage.items[1].inTable, true);
  const docTail = await tool(252, "docx_read_paragraphs", {
    device_id: deviceId, path: documentPath, offset: 5, limit: 2,
  });
  assert.deepEqual(docTail.items.map((item) => item.text), ["Son"]);
  assert.equal(docTail.hasMore, false);
  const docTable = await tool(253, "docx_read_table", {
    device_id: deviceId, path: documentPath, table_index: 0, offset_rows: 0, limit_rows: 1,
  });
  assert.deepEqual(docTable.items[0].cells.map((cell) => cell.text), ["Sol", "Sağ"]);
  assert.equal(docTable.nextRow, 1);
  assert.equal(docTable.hasMore, true);
  const docTableTail = await tool(254, "docx_read_table", {
    device_id: deviceId, path: documentPath, table_index: 0, offset_rows: 1, limit_rows: 10,
  });
  assert.deepEqual(docTableTail.items[0].cells.map((cell) => cell.text), ["Alt", "İki"]);
  const docInvalidPage = await tool(255, "docx_read_paragraphs", {
    device_id: deviceId, path: documentPath, limit: 101,
  });
  assert.equal(typeof docInvalidPage.error, "string");
  const docMissingTable = await tool(256, "docx_read_table", {
    device_id: deviceId, path: documentPath, table_index: 5,
  });
  assert.match(docMissingTable.error, /table not found/i);
  const docBrokenPath = path.join(tempRoot, "broken.docx");
  fs.writeFileSync(docBrokenPath, "not a ZIP archive");
  const docBroken = await tool(257, "docx_inspect", {
    device_id: deviceId, path: docBrokenPath,
  });
  assert.equal(typeof docBroken.error, "string");
  const docOutsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "commander-outside-docx-"));
  try {
    const docOutsidePath = path.join(docOutsideDir, "outside.docx");
    fs.copyFileSync(documentPath, docOutsidePath);
    const docOutside = await tool(258, "docx_inspect", {
      device_id: deviceId, path: docOutsidePath,
    });
    assert.match(docOutside.error, /outside configured allowed roots/i);
  } finally {
    fs.rmSync(docOutsideDir, { recursive: true, force: true });
  }

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
  const workbookMatches = await tool(243, "xlsx_find", {
    device_id: deviceId, path: workbookPath, query: "Alpha",
    case_sensitive: true, max_results: 20,
  });
  assert.equal(workbookMatches.items.length, 1);
  assert.equal(workbookMatches.items[0].row, 2);
  assert.equal(workbookMatches.items[0].column, 1);
  const workbookFoldedMatches = await tool(244, "xlsx_find", {
    device_id: deviceId, path: workbookPath, query: "alpha",
    case_sensitive: false,
  });
  assert.equal(workbookFoldedMatches.items.length, 1);
  const workbookExactMiss = await tool(245, "xlsx_find", {
    device_id: deviceId, path: workbookPath, query: "alpha",
    case_sensitive: true,
  });
  assert.equal(workbookExactMiss.items.length, 0);
  const invalidSearchLimit = await tool(246, "xlsx_find", {
    device_id: deviceId, path: workbookPath, query: "Alpha",
    max_results: 101,
  });
  assert.equal(typeof invalidSearchLimit.error, "string");
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

  // XLSX edits must create a distinct output file, never modify the source.
  const originalWorkbookHash = createHash("sha256").update(fs.readFileSync(workbookPath)).digest("hex");
  const editedWorkbookPath = path.join(tempRoot, "edited.xlsx");
  const editedWorkbook = await tool(237, "xlsx_write_cells", {
    device_id: deviceId, path: workbookPath, output_path: editedWorkbookPath,
    sheet: "Sample", expected_sha256: originalWorkbookHash,
    updates: [
      { cell: "B2", value: 77 },
      { cell: "A2", value: "Beta" },
      { cell: "B3", value: true },
    ],
  });
  assert.equal(editedWorkbook.ok, true, JSON.stringify(editedWorkbook));
  assert.equal(editedWorkbook.updatedCells, 3);
  assert.equal(editedWorkbook.previousSha256, originalWorkbookHash);
  assert.equal(createHash("sha256").update(fs.readFileSync(workbookPath)).digest("hex"), originalWorkbookHash);
  const editedCells = await tool(238, "xlsx_read_range", {
    device_id: deviceId, path: editedWorkbookPath, sheet: "Sample",
    start_row: 1, start_column: 1, row_count: 3, column_count: 2,
  });
  assert.ok(editedCells.cells.some((cell) => cell.row === 2 && cell.column === 2 && cell.data.value === 77));
  assert.ok(editedCells.cells.some((cell) => cell.row === 2 && cell.column === 1 && cell.data.value === "Beta"));
  assert.ok(editedCells.cells.some((cell) => cell.row === 3 && cell.column === 2 && cell.data.value === true));
  assert.ok(editedCells.cells.some((cell) => cell.row === 1 && cell.column === 1 && cell.data.value === "Label"));
  const existingOutput = await tool(239, "xlsx_write_cells", {
    device_id: deviceId, path: workbookPath, output_path: editedWorkbookPath,
    sheet: "Sample", updates: [{ cell: "B2", value: 99 }],
  });
  assert.equal(typeof existingOutput.error, "string");
  const staleOutputPath = path.join(tempRoot, "stale-output.xlsx");
  const staleWorkbookEdit = await tool(240, "xlsx_write_cells", {
    device_id: deviceId, path: workbookPath, output_path: staleOutputPath,
    sheet: "Sample", updates: [{ cell: "B2", value: 99 }],
    expected_sha256: "0".repeat(64),
  });
  assert.match(staleWorkbookEdit.error, /file_changed_since_read/);
  assert.equal(fs.existsSync(staleOutputPath), false);
  const macroOutput = await tool(241, "xlsx_write_cells", {
    device_id: deviceId, path: macroNamedWorkbook,
    output_path: path.join(tempRoot, "macro-output.xlsx"),
    sheet: "Sample", updates: [{ cell: "B2", value: 99 }],
  });
  assert.match(macroOutput.error, /read-only/);
  const invalidCellOutput = await tool(242, "xlsx_write_cells", {
    device_id: deviceId, path: workbookPath,
    output_path: path.join(tempRoot, "invalid-cell.xlsx"),
    sheet: "Sample", updates: [{ cell: "XFE1", value: "bad" }],
  });
  assert.equal(typeof invalidCellOutput.error, "string");

  // A matching cell can contain much more text than a safe MCP result page.
  // Search must still find a match beyond the preview boundary without
  // returning the full (potentially huge) cell value.
  const longWorkbookPath = path.join(tempRoot, "long-search.xlsx");
  const longWorkbookWrite = await tool(247, "xlsx_write_cells", {
    device_id: deviceId, path: workbookPath, output_path: longWorkbookPath,
    sheet: "Sample", updates: [{ cell: "A3", value: "a".repeat(6000) + "ENDMARKER" }],
  });
  assert.equal(longWorkbookWrite.ok, true, JSON.stringify(longWorkbookWrite));
  const longWorkbookMatches = await tool(248, "xlsx_find", {
    device_id: deviceId, path: longWorkbookPath, query: "ENDMARKER",
  });
  assert.equal(longWorkbookMatches.items.length, 1);
  assert.equal(longWorkbookMatches.items[0].valueTruncated, true);
  assert.ok(Buffer.byteLength(longWorkbookMatches.items[0].value, "utf8") <= 4096);
  assert.equal(longWorkbookMatches.items[0].value.includes("ENDMARKER"), false);

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

  // 3A: fs_write(create_parents) must create nested paths using pinned
  // no-follow directory handles, and rejected guarded writes must not mkdir.
  const nestedWritePath = path.join(tempRoot, "write-nested", "deeper", "file.txt");
  const nestedWrite = await tool(629, "fs_write", {
    device_id: deviceId, path: nestedWritePath, content_base64: content,
    create_parents: true,
  });
  assert.equal(nestedWrite.ok, true, JSON.stringify(nestedWrite));
  assert.equal(fs.readFileSync(nestedWritePath, "utf8"), "hello-from-real-agent");
  const missingGuardedDir = path.join(tempRoot, "guarded-write-missing");
  const rejectedGuardedWrite = await tool(630, "fs_write", {
    device_id: deviceId, path: path.join(missingGuardedDir, "child", "file.txt"),
    content_base64: content, create_parents: true, with_undo: true,
  });
  assert.equal(typeof rejectedGuardedWrite.error, "string");
  assert.equal(fs.existsSync(missingGuardedDir), false);
  console.log("agent-e2e: fs_write pinned nested mkdir and guarded no-side-effect passed");

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

  // 1D: paged reads reject oversized and invalid UTF-8 files instead of
  // attempting unbounded allocation or returning a partial secret.
  const oversizedPagedPath = path.join(tempRoot, "oversized-paged.txt");
  fs.writeFileSync(oversizedPagedPath, Buffer.alloc(32 * 1024 * 1024 + 1, 0x61));
  const oversizedPaged = await tool(292, "fs_read_lines", {
    device_id: deviceId, path: oversizedPagedPath, offset_lines: -1, limit_lines: 1,
  });
  assert.equal(typeof oversizedPaged.error, "string");
  assert.ok(!JSON.stringify(oversizedPaged).includes("a".repeat(128)));
  fs.rmSync(oversizedPagedPath);
  const invalidUtf8PagedPath = path.join(tempRoot, "invalid-paged.txt");
  fs.writeFileSync(invalidUtf8PagedPath, Buffer.from([0xff, 0xfe]));
  const invalidUtf8Paged = await tool(293, "fs_read_lines", {
    device_id: deviceId, path: invalidUtf8PagedPath,
  });
  assert.equal(typeof invalidUtf8Paged.error, "string");

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

  // 1D: native single-request batch must isolate individual read failures,
  // including an allowlist violation, without leaking host filesystem errors.
  const batchOutside = path.join(os.tmpdir(), "wecommander-outside-batch-" + process.pid + ".txt");
  fs.writeFileSync(batchOutside, "outside-secret-must-not-leak", "utf8");
  try {
    const partialBatch = await tool(214, "fs_read_multiple", {
      device_id: deviceId, paths: [filePath, batchOutside, linesPath],
    });
    assert.equal(partialBatch.count, 3);
    assert.equal(partialBatch.items[0].ok, true);
    assert.equal(partialBatch.items[1].ok, false);
    assert.equal(partialBatch.items[1].error, "read_failed");
    assert.equal(partialBatch.items[1].data, undefined);
    assert.equal(partialBatch.items[2].ok, true);
  } finally {
    fs.rmSync(batchOutside, { force: true });
  }
  const emptyBatch = await tool(215, "fs_read_multiple", {
    device_id: deviceId, paths: [],
  });
  assert.equal(emptyBatch.error, "invalid_batch_read_arguments");
  const excessiveBatchBytes = await tool(216, "fs_read_multiple", {
    device_id: deviceId, paths: [filePath], max_bytes: 65537,
  });
  assert.equal(excessiveBatchBytes.error, "invalid_batch_read_arguments");

  // 1D: a single huge line must fail closed rather than returning a partial
  // line, while a batch keeps binary files isolated as base64 payloads.
  const hugeLinePath = path.join(tempRoot, "oversized-line.txt");
  fs.writeFileSync(hugeLinePath, "secret-page-prefix-" + "z".repeat(256 * 1024 + 1));
  const hugeLinePage = await tool(298, "fs_read_lines", {
    device_id: deviceId, path: hugeLinePath, offset_lines: 0, limit_lines: 1,
  });
  assert.equal(typeof hugeLinePage.error, "string");
  assert.ok(!JSON.stringify(hugeLinePage).includes("secret-page-prefix-"));
  const binaryBatchPath = path.join(tempRoot, "binary-batch.bin");
  fs.writeFileSync(binaryBatchPath, Buffer.from([0xff, 0x00, 0xfe]));
  const mixedBatch = await tool(299, "fs_read_multiple", {
    device_id: deviceId, paths: [filePath, binaryBatchPath, path.join(tempRoot, "missing-batch.bin")],
  });
  assert.equal(mixedBatch.count, 3);
  assert.equal(mixedBatch.items[0].ok, true);
  assert.equal(mixedBatch.items[1].ok, true);
  assert.equal(mixedBatch.items[1].data.encoding, "base64");
  assert.equal(mixedBatch.items[1].data.content, Buffer.from([0xff, 0x00, 0xfe]).toString("base64"));
  assert.equal(mixedBatch.items[2].ok, false);
  assert.equal(mixedBatch.items[2].error, "read_failed");

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
  assert.equal(fileSearch.timedOut, false);
  assert.equal(typeof fileSearch.scannedEntries, "number");

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

  // 1A/1C: real MCP -> Gateway -> Rust content search keeps the native
  // per-file read bound; large UTF-8 inputs must not leak unbounded content.
  const boundedContentPath = path.join(tempRoot, "bounded-content.txt");
  fs.writeFileSync(boundedContentPath, "a".repeat(1024 * 1024 - 32) + "\nbounded-native-needle\n");
  const boundedContent = await tool(290, "text_search", {
    device_id: deviceId, path: boundedContentPath, query: "bounded-native-needle",
  });
  assert.ok(boundedContent.items.some((item) => item.path === boundedContentPath));
  const tooLargeContentPath = path.join(tempRoot, "oversized-content.txt");
  fs.writeFileSync(tooLargeContentPath, "bounded-native-needle\n" + "a".repeat(1024 * 1024));
  const tooLargeContent = await tool(291, "text_search", {
    device_id: deviceId, path: tooLargeContentPath, query: "bounded-native-needle",
  });
  assert.deepEqual(tooLargeContent.items, []);
  assert.equal(tooLargeContent.scannedBytes, 0);

  // 1C: content search must preserve case sensitivity across MCP, Gateway
  // and native Rust, including the asynchronous search-session path.
  fs.writeFileSync(mixedCaseName, "Mixed-Content-Needle\\n", "utf8");
  fs.writeFileSync(lowerCaseName, "mixed-content-needle\\n", "utf8");
  const exactContent = await tool(284, "text_search", {
    device_id: deviceId, path: tempRoot, query: "Mixed-Content-Needle",
    case_sensitive: true,
  });
  assert.ok(exactContent.items.some(item => item.path === mixedCaseName));
  assert.ok(!exactContent.items.some(item => item.path === lowerCaseName));
  const foldedContent = await tool(285, "text_search", {
    device_id: deviceId, path: tempRoot, query: "Mixed-Content-Needle",
    case_sensitive: false,
  });
  assert.ok(foldedContent.items.some(item => item.path === mixedCaseName));
  assert.ok(foldedContent.items.some(item => item.path === lowerCaseName));
  const exactContentSession = await tool(286, "start_search", {
    device_id: deviceId, path: tempRoot, query: "Mixed-Content-Needle",
    search_type: "content", case_sensitive: true,
  });
  const exactContentPage = await waitFor(async () => {
    const page = await tool(287, "get_more_search_results", {
      device_id: deviceId, search_id: exactContentSession.searchId, offset: 0, length: 10,
    });
    return page.status === "completed" ? page : false;
  });
  assert.ok(exactContentPage.items.some(item => item.path === mixedCaseName));
  assert.ok(!exactContentPage.items.some(item => item.path === lowerCaseName));

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

  // 1C: real Rust Agent large-directory acceptance with bounded pages,
  // native result cap, malformed offsets, and no leakage outside allowed roots.
  const bulkDir = path.join(tempRoot, "bulk-search");
  fs.mkdirSync(bulkDir);
  for (let index = 0; index < 530; index += 1) {
    fs.writeFileSync(path.join(bulkDir, `bulk-match-${String(index).padStart(4, "0")}.txt`), "sample");
  }
  const bulkDirect = await tool(270, "fs_search", {
    device_id: deviceId, path: bulkDir, query: "bulk-match", max_results: 500,
  });
  assert.equal(bulkDirect.items.length, 500);
  assert.equal(bulkDirect.truncated, true);
  assert.equal(bulkDirect.timedOut, false);
  assert.ok(bulkDirect.scannedEntries <= 100000);

  const bulkSession = await tool(271, "start_search", {
    device_id: deviceId, path: bulkDir, query: "bulk-match", search_type: "files",
  });
  assert.equal(typeof bulkSession.searchId, "string");
  const bulkPage = await waitFor(async () => {
    const page = await tool(272, "get_more_search_results", {
      device_id: deviceId, search_id: bulkSession.searchId, offset: 490, length: 30,
    });
    return page.status === "completed" ? page : false;
  });
  assert.equal(bulkPage.resultCount, 500);
  assert.ok(bulkPage.progressUpdates > 0,
    "Real Rust Agent must emit interim snapshots over the WebSocket protocol");
  assert.ok(bulkPage.scannedEntries > 0);
  assert.equal(bulkPage.items.length, 10);
  assert.equal(bulkPage.hasMore, false);
  assert.equal(bulkPage.truncated, true);
  assert.deepEqual(bulkPage.items.map(item => item.path).length, 10);

  // Real native pause/resume goes through MCP -> Gateway ownership -> Agent
  // ACK. Many nonmatching entries keep the scanner live long enough to pause
  // without introducing artificial test-only delays into production code.
  const pauseDir = path.join(tempRoot, "pause-acceptance");
  fs.mkdirSync(pauseDir);
  for (let index = 0; index < 12000; index += 1) {
    fs.writeFileSync(path.join(pauseDir, `item-${String(index).padStart(5, "0")}.txt`), "");
  }
  const pauseSession = await tool(290, "start_search", {
    device_id: deviceId, path: pauseDir,
    query: "absent-unique-native-marker", search_type: "files", start_paused: true,
  });
  assert.equal(typeof pauseSession.searchId, "string");
  assert.equal(pauseSession.paused, true);
  // The scanner must remain paused without scanning any of the test entries.
  await new Promise(resolve => setTimeout(resolve, 100));
  const pausedScan = await tool(291, "pause_search", {
    device_id: deviceId, search_id: pauseSession.searchId,
  });
  assert.equal(pausedScan.paused, true);
  assert.equal(pausedScan.status, "running");
  const whilePaused = await tool(292, "get_more_search_results", {
    device_id: deviceId, search_id: pauseSession.searchId,
  });
  assert.equal(whilePaused.paused, true);
  assert.equal(whilePaused.scannedEntries, 0,
    "A start_paused native scanner cannot advance before resume_search");
  const resumedScan = await tool(293, "resume_search", {
    device_id: deviceId, search_id: pauseSession.searchId,
  });
  assert.equal(resumedScan.paused, false);
  const afterResume = await waitFor(async () => {
    const page = await tool(294, "get_more_search_results", {
      device_id: deviceId, search_id: pauseSession.searchId,
    });
    return page.status === "completed" ? page : false;
  }, 20000, 100);
  assert.equal(afterResume.paused, false);
  assert.equal(afterResume.timedOut, false);
  const latePause = await tool(295, "pause_search", {
    device_id: deviceId, search_id: pauseSession.searchId,
  });
  assert.equal(latePause.error, "search_not_running");
  const wrongPause = await tool(296, "pause_search", {
    device_id: deviceId, search_id: "00000000-0000-4000-8000-000000000999",
  });
  assert.equal(wrongPause.error, "search_not_found");

  // 1A: two real Agent scans may overlap. Stopping one session must never
  // cancel, overwrite or leak results from its concurrently running peer.
  // This proves MCP session isolation, not native streaming/pause acceptance.
  const [cancelCandidate, survivor] = await Promise.all([
    tool(278, "start_search", {
      device_id: deviceId, path: bulkDir, query: "bulk-match", search_type: "files",
    }),
    tool(279, "start_search", {
      device_id: deviceId, path: bulkDir, query: "bulk-match", search_type: "files",
    }),
  ]);
  assert.notEqual(cancelCandidate.searchId, survivor.searchId);
  const cancelled = await tool(280, "stop_search", {
    device_id: deviceId, search_id: cancelCandidate.searchId,
  });
  assert.equal(cancelled.status, "stopped");
  const cancelledPage = await tool(281, "get_more_search_results", {
    device_id: deviceId, search_id: cancelCandidate.searchId, offset: 0, length: 1,
  });
  assert.equal(cancelledPage.status, "stopped");
  assert.deepEqual(cancelledPage.items, []);
  const survivorPage = await waitFor(async () => {
    const page = await tool(282, "get_more_search_results", {
      device_id: deviceId, search_id: survivor.searchId, offset: 0, length: 1,
    });
    return page.status === "completed" ? page : false;
  });
  assert.equal(survivorPage.resultCount, 500);
  assert.equal(survivorPage.items.length, 1);
  assert.equal(survivorPage.truncated, true);
  const cancelledAfterPeer = await tool(283, "get_more_search_results", {
    device_id: deviceId, search_id: cancelCandidate.searchId, offset: 0, length: 1,
  });
  assert.equal(cancelledAfterPeer.status, "stopped");
  assert.deepEqual(cancelledAfterPeer.items, []);

  const invalidBulkOffset = await tool(273, "get_more_search_results", {
    device_id: deviceId, search_id: bulkSession.searchId, offset: 501, length: 1,
  });
  assert.equal(invalidBulkOffset.error, "invalid_search_page");
  const invalidBulkLength = await tool(274, "get_more_search_results", {
    device_id: deviceId, search_id: bulkSession.searchId, offset: 0, length: 101,
  });
  assert.equal(invalidBulkLength.error, "invalid_search_page");
  const invalidBulkQuery = await tool(275, "start_search", {
    device_id: deviceId, path: bulkDir, query: "x".repeat(1025),
    search_type: "files",
  });
  assert.equal(invalidBulkQuery.error, "invalid_search_arguments");
  // MCP -> Gateway -> Rust must share the native byte budget for Unicode.
  // 342 CJK characters fit a 1024-unit JS length check but exceed 1024 UTF-8 bytes.
  const invalidUtf8BulkQuery = await tool(297, "start_search", {
    device_id: deviceId, path: bulkDir, query: "界".repeat(342),
    search_type: "files",
  });
  assert.equal(invalidUtf8BulkQuery.error, "invalid_search_arguments");

  // Symlinks inside an allowed root must never expose filenames or contents
  // from another directory through a native recursive search.
  const escapedDir = fs.mkdtempSync(path.join(os.tmpdir(), "commender-search-outside-"));
  const escapedLink = path.join(tempRoot, "external-search-link");
  try {
    fs.writeFileSync(
      path.join(escapedDir, "outside-search-private-keyword.txt"),
      "outside-content-private-keyword", "utf8",
    );
    fs.symlinkSync(escapedDir, escapedLink, "dir");
    const escapedNames = await tool(276, "fs_search", {
      device_id: deviceId, path: tempRoot, query: "outside-search-private-keyword",
    });
    assert.deepEqual(escapedNames.items, []);
    const escapedContent = await tool(277, "text_search", {
      device_id: deviceId, path: tempRoot, query: "outside-content-private-keyword",
    });
    assert.deepEqual(escapedContent.items, []);

    // The same allowlist must hold for direct reads, paged reads and edits.
    // An allowed directory containing a symlink is not permission to access
    // the symlink target outside the root.
    const outsideFile = path.join(escapedDir, "outside-private.txt");
    const outsideLink = path.join(tempRoot, "outside-private-link.txt");
    fs.writeFileSync(outsideFile, "outside-private-do-not-modify", "utf8");
    fs.symlinkSync(outsideFile, outsideLink, "file");
    try {
      const directRead = await tool(294, "fs_read", {
        device_id: deviceId, path: outsideLink,
      });
      assert.equal(typeof directRead.error, "string");
      const pagedRead = await tool(295, "fs_read_lines", {
        device_id: deviceId, path: outsideLink, offset_lines: 0, limit_lines: 10,
      });
      assert.equal(typeof pagedRead.error, "string");
      const directEdit = await tool(296, "fs_replace", {
        device_id: deviceId, path: outsideLink,
        search: "outside-private", replace: "exfiltrated",
      });
      assert.equal(typeof directEdit.error, "string");
      const deniedAppend = await tool(297, "fs_append", {
        device_id: deviceId, path: outsideLink,
        content_base64: Buffer.from("-must-not-append").toString("base64"),
      });
      assert.equal(typeof deniedAppend.error, "string");
      // 3A: unguarded fs_write uses the same pinned-parent atomic replacement
      // as guarded edits; neither a symlink target nor a symlinked ancestor
      // may mutate files outside the device's allowed root.
      const deniedAtomicWrite = await tool(621, "fs_write", {
        device_id: deviceId, path: outsideLink,
        content_base64: Buffer.from("must-not-overwrite").toString("base64"),
      });
      assert.equal(typeof deniedAtomicWrite.error, "string");
      assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside-private-do-not-modify");
      console.log("agent-e2e: fs_append outside-root symlink denied without modifying target");
      const outsideDirLink = path.join(tempRoot, "outside-dir-link");
      fs.symlinkSync(escapedDir, outsideDirLink, "dir");
      try {
        const deniedParentRead = await tool(298, "fs_read", {
          device_id: deviceId, path: path.join(outsideDirLink, "outside-private.txt"),
        });
        assert.equal(typeof deniedParentRead.error, "string");
        const deniedParentAppend = await tool(299, "fs_append", {
          device_id: deviceId, path: path.join(outsideDirLink, "outside-private.txt"),
          content_base64: Buffer.from("-must-not-append").toString("base64"),
        });
        assert.equal(typeof deniedParentAppend.error, "string");
        const deniedParentAtomicWrite = await tool(622, "fs_write", {
          device_id: deviceId, path: path.join(outsideDirLink, "outside-private.txt"),
          content_base64: Buffer.from("must-not-overwrite").toString("base64"),
        });
        assert.equal(typeof deniedParentAtomicWrite.error, "string");
        assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside-private-do-not-modify");
        const deniedNestedParentWrite = await tool(631, "fs_write", {
          device_id: deviceId,
          path: path.join(outsideDirLink, "new-nested", "file.txt"),
          content_base64: Buffer.from("must-not-create").toString("base64"),
          create_parents: true,
        });
        assert.equal(typeof deniedNestedParentWrite.error, "string");
        assert.equal(fs.existsSync(path.join(escapedDir, "new-nested")), false);
        console.log("agent-e2e: fs_write create_parents outside-root symlink denied");
        console.log("agent-e2e: fs_write symlinked target and parent denied");
        console.log("agent-e2e: parent symlink outside root denied for read and append");
        // 3A: fs_move must reject symlinked source/destination parents
        // through the real MCP -> Gateway -> Rust Agent permission path.
        const moveGuardSource = path.join(tempRoot, "move-parent-guard-source.txt");
        const moveGuardTarget = path.join(outsideDirLink, "move-parent-guard-target.txt");
        fs.writeFileSync(moveGuardSource, "move-guard-preserve", "utf8");
        const deniedMoveIntoParent = await tool(619, "fs_move", {
          device_id: deviceId, source: moveGuardSource, destination: moveGuardTarget,
        });
        assert.equal(typeof deniedMoveIntoParent.error, "string");
        assert.equal(fs.readFileSync(moveGuardSource, "utf8"), "move-guard-preserve");
        assert.equal(fs.existsSync(path.join(escapedDir, "move-parent-guard-target.txt")), false);
        const deniedMoveOutOfParent = await tool(620, "fs_move", {
          device_id: deviceId,
          source: path.join(outsideDirLink, "outside-private.txt"),
          destination: path.join(tempRoot, "move-parent-guard-escaped.txt"),
        });
        assert.equal(typeof deniedMoveOutOfParent.error, "string");
        assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside-private-do-not-modify");
        fs.rmSync(moveGuardSource);
        console.log("agent-e2e: fs_move symlinked source/destination parents denied");
        // Nonrecursive deletion must not traverse a symlinked parent even
        // when a destructive-action approval token has been issued.
        const deniedDeletePath = path.join(outsideDirLink, "outside-private.txt");
        const deniedDeleteToken = await approval(deviceId, {
          kind: "fs_delete", path: deniedDeletePath, recursive: false,
        });
        const deniedParentDelete = await tool(623, "fs_delete", {
          device_id: deviceId, path: deniedDeletePath,
          recursive: false, approval_token: deniedDeleteToken,
        });
        assert.equal(typeof deniedParentDelete.error, "string");
        assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside-private-do-not-modify");
        console.log("agent-e2e: fs_delete symlinked parent denied with approval");
        // Recursive delete must also reject a symlinked ancestor after
        // destructive-action approval, and must not follow symlink entries
        // encountered inside an otherwise allowed directory tree.
        const outsideRecursive = path.join(escapedDir, "recursive-target");
        fs.mkdirSync(path.join(outsideRecursive, "nested"), { recursive: true });
        fs.writeFileSync(path.join(outsideRecursive, "nested/keep.txt"), "outside-recursive-private");
        const deniedRecursivePath = path.join(outsideDirLink, "recursive-target");
        const deniedRecursiveToken = await approval(deviceId, {
          kind: "fs_delete", path: deniedRecursivePath, recursive: true,
        });
        const deniedRecursiveDelete = await tool(626, "fs_delete", {
          device_id: deviceId, path: deniedRecursivePath,
          recursive: true, approval_token: deniedRecursiveToken,
        });
        assert.equal(typeof deniedRecursiveDelete.error, "string");
        assert.equal(
          fs.readFileSync(path.join(outsideRecursive, "nested/keep.txt"), "utf8"),
          "outside-recursive-private",
        );

        const allowedRecursive = path.join(tempRoot, "recursive-delete-acceptance");
        fs.mkdirSync(path.join(allowedRecursive, "nested"), { recursive: true });
        fs.writeFileSync(path.join(allowedRecursive, "nested/inside.txt"), "inside");
        fs.symlinkSync(outsideFile, path.join(allowedRecursive, "external-link"), "file");
        const allowedRecursiveToken = await approval(deviceId, {
          kind: "fs_delete", path: allowedRecursive, recursive: true,
        });
        const recursiveDelete = await tool(627, "fs_delete", {
          device_id: deviceId, path: allowedRecursive,
          recursive: true, approval_token: allowedRecursiveToken,
        });
        assert.equal(recursiveDelete.ok, true);
        assert.equal(fs.existsSync(allowedRecursive), false);
        assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside-private-do-not-modify");
        console.log("agent-e2e: recursive fs_delete pinned traversal and symlink boundary passed");
        // Both mkdir modes must reject an outside-root symlinked parent
        // through the actual MCP -> Gateway -> Agent route.
        for (const recursive of [false, true]) {
          const deniedMkdir = await tool(recursive ? 625 : 624, "fs_mkdir", {
            device_id: deviceId,
            path: path.join(outsideDirLink, recursive ? "nested/deep" : "shallow"),
            recursive,
          });
          assert.equal(typeof deniedMkdir.error, "string");
        }
        assert.equal(fs.existsSync(path.join(escapedDir, "shallow")), false);
        assert.equal(fs.existsSync(path.join(escapedDir, "nested")), false);
        console.log("agent-e2e: fs_mkdir nonrecursive and recursive outside-root symlink denied");

      } finally {
        fs.rmSync(outsideDirLink, { force: true });
      }
    } finally {
      fs.rmSync(outsideLink, { force: true });
    }
  } finally {
    fs.rmSync(escapedLink, { force: true });
    fs.rmSync(escapedDir, { recursive: true, force: true });
  }

  // Other acceptance fixtures may contain large documents and directories.
  // Keep this search's 10-second native deadline independent of unrelated
  // fixtures while still exercising the real allowlisted Rust scanner.
  const searchDir = path.join(tempRoot, "content-search-acceptance");
  fs.mkdirSync(searchDir);
  const searchFile = path.join(searchDir, "hello.txt");
  fs.copyFileSync(filePath, searchFile);
  const codeSearch = await tool(116, "code_search", {
    device_id: deviceId,
    path: searchDir,
    query: "hello-from-real-agent",
    max_results: 20,
  });
  assert.ok(codeSearch.items.some((item) => item.path === searchFile && item.line === 1));
  assert.equal(codeSearch.timedOut, false);
  assert.ok(codeSearch.scannedBytes > 0);

  // A search session must expose a stable paged snapshot and become empty
  // after explicit cancellation. This does not claim native streaming support.
  const startedSearch = await tool(214, "start_search", {
    device_id: deviceId, path: searchDir, query: "hello-from-real-agent", search_type: "content",
  });
  assert.equal(typeof startedSearch.searchId, "string");
  const completedSearch = await waitFor(async () => {
    const result = await tool(215, "get_more_search_results", {
      device_id: deviceId, search_id: startedSearch.searchId, offset: 0, length: 1,
    });
    return result.status === "completed" ? result : false;
  });
  assert.equal(completedSearch.items.length, 1);
  assert.equal(completedSearch.timedOut, false);
  assert.equal(completedSearch.items[0].path, searchFile);
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

  // 3A: an independent writer changes the file after the client read its
  // SHA. Real authenticated MCP must reject the stale edit and preserve data.
  const externalCasPath = path.join(tempRoot, "external-cas.txt");
  fs.writeFileSync(externalCasPath, "external-seed");
  const externalCasSha = createHash("sha256").update("external-seed").digest("hex");
  fs.writeFileSync(externalCasPath, "external-writer-won");
  const externalCasResult = await tool(1591, "fs_replace", {
    device_id: deviceId, path: externalCasPath, search: "external-seed",
    replace: "agent-must-not-win", expected_sha256: externalCasSha,
  });
  assert.match(String(externalCasResult.error), /file_changed_since_read/);
  assert.equal(fs.readFileSync(externalCasPath, "utf8"), "external-writer-won");
  console.log("agent-e2e: external stale SHA edit rejected; competing data preserved");

  // Concurrent fs_replace SHA guard: exactly one matching CAS request can
  // succeed through the real MCP/Gateway/Rust Agent path.
  const raceFile = path.join(tempRoot, "concurrent-edit.txt");
  fs.writeFileSync(raceFile, "race-seed", "utf8");
  const raceSha = createHash("sha256").update("race-seed").digest("hex");
  const raceResults = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    tool(540 + index, "fs_replace", {
      device_id: deviceId, path: raceFile, search: "race-seed",
      replace: `winner-${index}`, expected_sha256: raceSha,
    })
  ));
  assert.equal(raceResults.filter((result) => result.ok === true).length, 1);
  assert.equal(raceResults.filter((result) => typeof result.error === "string").length, 7);
  assert.match(fs.readFileSync(raceFile, "utf8"), /^winner-[0-7]$/);
  console.log("agent-e2e: concurrent fs_replace SHA guard accepted exactly one writer");
  const winningEdit = raceResults.find((result) => result.ok === true);
  assert.match(winningEdit.undoId, /^[0-9a-f-]{36}$/);
  const versions = await tool(570, "fs_versions", { device_id: deviceId, path: raceFile });
  assert.ok(versions.versions.some((item) => item.undoId === winningEdit.undoId));
  const currentRaceSha = createHash("sha256").update(fs.readFileSync(raceFile)).digest("hex");
  const staleUndo = await tool(571, "fs_undo", {
    device_id: deviceId, path: raceFile, undo_id: winningEdit.undoId,
    expected_sha256: "0".repeat(64),
  });
  assert.equal(typeof staleUndo.error, "string");
  const restored = await tool(572, "fs_undo", {
    device_id: deviceId, path: raceFile, undo_id: winningEdit.undoId,
    expected_sha256: currentRaceSha,
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.undoConsumed, true, "undo must consume the verified snapshot");
  assert.equal(fs.readFileSync(raceFile, "utf8"), "race-seed");
  const replay = await tool(573, "fs_undo", {
    device_id: deviceId, path: raceFile, undo_id: winningEdit.undoId,
    expected_sha256: currentRaceSha,
  });
  assert.equal(typeof replay.error, "string");
  console.log("agent-e2e: durable guarded fs_replace undo survived stale/replay negative tests");
  // Foreign tenant/actor/device owner evidence must remain invisible.
  const foreignUndoId = "11111111-1111-4111-8111-111111111111";
  const foreignPrefix = createHash("sha256").update(raceFile).digest("hex");
  const foreignSnapshot = path.join(tempRoot, "xdg-data", "webrising-commender", "file-versions",
    `${foreignPrefix}-${foreignUndoId}.undo`);
  fs.writeFileSync(foreignSnapshot, JSON.stringify({
    version: 2, ownerScope: "0".repeat(64), path: raceFile,
    previousSha256: "0".repeat(64), nextSha256: "0".repeat(64),
    contentBase64: Buffer.from("foreign").toString("base64"),
  }));
  const foreignListing = await tool(1578, "fs_versions", { device_id: deviceId, path: raceFile });
  assert.equal(foreignListing.versions.some((item) => item.undoId === foreignUndoId), false);
  const foreignUndo = await tool(1579, "fs_undo", {
    device_id: deviceId, path: raceFile, undo_id: foreignUndoId,
    expected_sha256: createHash("sha256").update("race-seed").digest("hex"),
  });
  assert.equal(typeof foreignUndo.error, "string");
  assert.equal(fs.readFileSync(raceFile, "utf8"), "race-seed");
  fs.rmSync(foreignSnapshot);
  console.log("agent-e2e: foreign undo owner hidden and restore denied");

  // 3B real multi-principal acceptance: two independently authenticated API
  // tokens in the same tenant may edit the same allowlisted file, but must
  // never list or restore each other's durable undo snapshots. A third token
  // from another tenant cannot even address the enrolled device. The MCP
  // caller cannot forge the scope via tool arguments.
  const actorA = await jsonFetch("/api/tokens", {
    method: "POST", headers: authHeaders,
    body: JSON.stringify({ name: "E2E Undo Actor A", role: "operator" }),
  });
  const actorB = await jsonFetch("/api/tokens", {
    method: "POST", headers: authHeaders,
    body: JSON.stringify({ name: "E2E Undo Actor B", role: "operator" }),
  });
  const otherTenant = await jsonFetch("/api/organizations", {
    method: "POST", headers: authHeaders,
    body: JSON.stringify({ name: "E2E Undo Isolation Tenant" }),
  });
  const tenantActor = await jsonFetch("/api/tokens", {
    method: "POST", headers: authHeaders,
    body: JSON.stringify({
      name: "E2E Other Tenant Actor", role: "operator",
      organizationId: otherTenant.item.id,
    }),
  });
  const headersFor = (token) => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });
  const toolAs = async (headers, id, name, args) => {
    const response = await jsonFetch("/mcp", {
      method: "POST", headers,
      body: JSON.stringify({
        jsonrpc: "2.0", id, method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return toolData(response);
  };
  const headersA = headersFor(actorA.token);
  const headersB = headersFor(actorB.token);
  const headersTenant = headersFor(tenantActor.token);
  for (const [writerHeaders, readerHeaders, id, replacement] of [
    [headersA, headersB, 1610, "actor-a-edited"],
    [headersB, headersA, 1620, "actor-b-edited"],
  ]) {
    const edit = await toolAs(writerHeaders, id, "fs_replace", {
      device_id: deviceId, path: raceFile, search: "race-seed", replace: replacement,
    });
    assert.equal(edit.ok, true, JSON.stringify(edit));
    assert.match(edit.undoId, /^[0-9a-f-]{36}$/);
    const ownVersions = await toolAs(writerHeaders, id + 1, "fs_versions", {
      device_id: deviceId, path: raceFile,
    });
    assert.ok(ownVersions.versions.some((item) => item.undoId === edit.undoId));
    const foreignVersions = await toolAs(readerHeaders, id + 2, "fs_versions", {
      device_id: deviceId, path: raceFile,
    });
    assert.equal(foreignVersions.versions.some((item) => item.undoId === edit.undoId), false);
    const foreignRestore = await toolAs(readerHeaders, id + 3, "fs_undo", {
      device_id: deviceId, path: raceFile, undo_id: edit.undoId,
      expected_sha256: edit.sha256,
      organization_id: otherTenant.item.id, actor: "control-api",
      owner_scope: "0".repeat(64),
    });
    assert.equal(typeof foreignRestore.error, "string", JSON.stringify(foreignRestore));
    assert.equal(fs.readFileSync(raceFile, "utf8"), replacement);
    const restoredByOwner = await toolAs(writerHeaders, id + 4, "fs_undo", {
      device_id: deviceId, path: raceFile, undo_id: edit.undoId,
      expected_sha256: edit.sha256,
    });
    assert.equal(restoredByOwner.ok, true, JSON.stringify(restoredByOwner));
    assert.equal(fs.readFileSync(raceFile, "utf8"), "race-seed");
  }
  const tenantDevices = await toolAs(headersTenant, 1630, "devices_list", {});
  assert.equal(tenantDevices.some((item) => item.id === deviceId), false);
  for (const [id, name, args] of [
    [1631, "fs_versions", { device_id: deviceId, path: raceFile }],
    [1632, "fs_replace", {
      device_id: deviceId, path: raceFile,
      search: "race-seed", replace: "cross-tenant-write",
    }],
  ]) {
    const denied = await toolAs(headersTenant, id, name, args);
    assert.equal(denied.error, "device_not_found", JSON.stringify(denied));
  }
  assert.equal(fs.readFileSync(raceFile, "utf8"), "race-seed");
  console.log("agent-e2e: two real actors isolated undo; foreign tenant device denied");

  // v1 records predate ownerScope. Never silently grant either new actor
  // access to an unscoped legacy snapshot; migration remains an explicit,
  // separate administrative decision rather than a permissive fallback.
  const legacyUndoId = "22222222-2222-4222-8222-222222222222";
  const legacySnapshot = path.join(tempRoot, "xdg-data", "webrising-commender", "file-versions",
    `${foreignPrefix}-${legacyUndoId}.undo`);
  fs.writeFileSync(legacySnapshot, JSON.stringify({
    version: 1, path: raceFile,
    previousSha256: createHash("sha256").update("legacy-seed").digest("hex"),
    nextSha256: createHash("sha256").update("race-seed").digest("hex"),
    contentBase64: Buffer.from("legacy-seed").toString("base64"),
  }));
  try {
    for (const [id, headers] of [[1640, headersA], [1650, headersB]]) {
      const listing = await toolAs(headers, id, "fs_versions", {
        device_id: deviceId, path: raceFile,
      });
      assert.equal(listing.versions.some((item) => item.undoId === legacyUndoId), false);
      const denied = await toolAs(headers, id + 1, "fs_undo", {
        device_id: deviceId, path: raceFile, undo_id: legacyUndoId,
        expected_sha256: createHash("sha256").update("race-seed").digest("hex"),
      });
      assert.equal(typeof denied.error, "string", JSON.stringify(denied));
      assert.equal(fs.readFileSync(raceFile, "utf8"), "race-seed");
    }
  } finally {
    fs.rmSync(legacySnapshot, { force: true });
  }
  console.log("agent-e2e: legacy v1 unscoped undo inaccessible to authenticated actors");
  // 3B retention: age a real Agent-created snapshot on disk and verify that
  // the next MCP listing prunes it, without modifying the edited source file.
  const expiring = await tool(574, "fs_replace", {
    device_id: deviceId, path: raceFile, search: "race-seed", replace: "expiry-edited",
  });
  assert.equal(expiring.ok, true);
  const racePrefix = createHash("sha256").update(raceFile).digest("hex");
  const snapshotPath = path.join(
    tempRoot, "xdg-data", "webrising-commender", "file-versions",
    `${racePrefix}-${expiring.undoId}.undo`,
  );
  assert.equal(fs.existsSync(snapshotPath), true);
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(snapshotPath, eightDaysAgo, eightDaysAgo);
  const prunedVersions = await tool(575, "fs_versions", {
    device_id: deviceId, path: raceFile,
  });
  assert.equal(prunedVersions.versions.some((item) => item.undoId === expiring.undoId), false);
  assert.equal(fs.existsSync(snapshotPath), false);
  const expiredUndo = await tool(576, "fs_undo", {
    device_id: deviceId, path: raceFile, undo_id: expiring.undoId,
    expected_sha256: expiring.sha256,
  });
  assert.equal(typeof expiredUndo.error, "string");
  assert.equal(fs.readFileSync(raceFile, "utf8"), "expiry-edited");
  console.log("agent-e2e: expired undo pruned and stale restore denied via real MCP");

  // 3B crash recovery: a SIGKILL during snapshot staging can leave a UUID
  // .tmp file behind. A real MCP listing must reclaim stale staging files
  // without touching fresh staging data or unknown private-directory files.
  const versionDirectory = path.dirname(snapshotPath);
  const orphanStage = path.join(versionDirectory, ".00000000-0000-4000-8000-000000000001.tmp");
  const activeStage = path.join(versionDirectory, ".00000000-0000-4000-8000-000000000002.tmp");
  const unrelatedStage = path.join(versionDirectory, ".not-a-uuid.tmp");
  for (const filename of [orphanStage, activeStage, unrelatedStage]) {
    fs.writeFileSync(filename, "retained");
  }
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(orphanStage, twoDaysAgo, twoDaysAgo);
  fs.utimesSync(unrelatedStage, twoDaysAgo, twoDaysAgo);

  // 3B REAL process-crash acceptance: persist a new undo snapshot, SIGKILL
  // the native Agent, reconnect with the same enrolled device and restore
  // through MCP. Also exercise orphan-stage pruning only after that restart.
  const restartEdit = await tool(1577, "fs_replace", {
    device_id: deviceId, path: raceFile,
    search: "expiry-edited", replace: "restart-edited",
  });
  assert.equal(restartEdit.ok, true);
  assert.match(restartEdit.undoId, /^[0-9a-f-]{36}$/);
  const persistedSnapshot = path.join(versionDirectory, `${racePrefix}-${restartEdit.undoId}.undo`);
  assert.equal(fs.existsSync(persistedSnapshot), true);

  // 3B: a parseable but tampered undo record must not appear as restorable.
  // Verify both listing and restore fail closed, with no source mutation or
  // snapshot consumption. Repair the fixture and verify normal recovery.
  const intactUndoSnapshot = fs.readFileSync(persistedSnapshot);
  const tamperedUndoRecord = JSON.parse(intactUndoSnapshot.toString("utf8"));
  tamperedUndoRecord.previousSha256 = "0".repeat(64);
  fs.writeFileSync(persistedSnapshot, JSON.stringify(tamperedUndoRecord));
  const tamperedListing = await tool(1700, "fs_versions", {
    device_id: deviceId, path: raceFile,
  });
  assert.match(String(tamperedListing.error), /undo_snapshot_checksum_mismatch/);
  const tamperedRestore = await tool(1701, "fs_undo", {
    device_id: deviceId, path: raceFile, undo_id: restartEdit.undoId,
    expected_sha256: restartEdit.sha256,
  });
  assert.match(String(tamperedRestore.error), /undo_snapshot_checksum_mismatch/);
  assert.equal(fs.readFileSync(raceFile, "utf8"), "restart-edited");
  assert.equal(fs.existsSync(persistedSnapshot), true);
  fs.writeFileSync(persistedSnapshot, intactUndoSnapshot);
  const repairedListing = await tool(1702, "fs_versions", {
    device_id: deviceId, path: raceFile,
  });
  assert.ok(repairedListing.versions.some((item) => item.undoId === restartEdit.undoId));

  // 3B: an outside hardlink alias of a private undo inode is not private
  // evidence. Both MCP entrypoints must refuse it before pruning/restoring.
  const outsideUndoAlias = path.join(tempRoot, "external-undo-hardlink");
  fs.linkSync(persistedSnapshot, outsideUndoAlias);
  const linkedListing = await tool(1703, "fs_versions", {
    device_id: deviceId, path: raceFile,
  });
  assert.match(String(linkedListing.error), /unsafe_undo_storage_hardlink/);
  const linkedRestore = await tool(1704, "fs_undo", {
    device_id: deviceId, path: raceFile, undo_id: restartEdit.undoId,
    expected_sha256: restartEdit.sha256,
  });
  assert.match(String(linkedRestore.error), /unsafe_undo_storage_hardlink/);
  assert.equal(fs.readFileSync(raceFile, "utf8"), "restart-edited");
  assert.deepEqual(fs.readFileSync(outsideUndoAlias), intactUndoSnapshot);
  fs.unlinkSync(outsideUndoAlias);
  const recoveredListing = await tool(1705, "fs_versions", {
    device_id: deviceId, path: raceFile,
  });
  assert.ok(recoveredListing.versions.some((item) => item.undoId === restartEdit.undoId));

  // 3B: a snapshot claiming to belong to a different path must not be
  // advertised or restored, even when its previous-content digest is valid.
  const foreignPathRecord = JSON.parse(intactUndoSnapshot.toString("utf8"));
  foreignPathRecord.path = path.join(tempRoot, "foreign-undo-target");
  fs.writeFileSync(persistedSnapshot, JSON.stringify(foreignPathRecord));
  const foreignPathListing = await tool(1706, "fs_versions", {
    device_id: deviceId, path: raceFile,
  });
  assert.match(String(foreignPathListing.error), /undo_snapshot_path_mismatch/);
  const foreignPathRestore = await tool(1707, "fs_undo", {
    device_id: deviceId, path: raceFile, undo_id: restartEdit.undoId,
    expected_sha256: restartEdit.sha256,
  });
  assert.match(String(foreignPathRestore.error), /undo_snapshot_path_mismatch/);
  assert.equal(fs.readFileSync(raceFile, "utf8"), "restart-edited");
  fs.writeFileSync(persistedSnapshot, intactUndoSnapshot);

  // 3B: a symlink planted at the private snapshot path must never be
  // followed, consumed or pruned through either real MCP entrypoint.
  const externalUndoTarget = path.join(tempRoot, "external-undo-symlink-target");
  const parkedSnapshot = path.join(tempRoot, "parked-undo-snapshot");
  fs.writeFileSync(externalUndoTarget, intactUndoSnapshot);
  fs.renameSync(persistedSnapshot, parkedSnapshot);
  fs.symlinkSync(externalUndoTarget, persistedSnapshot);
  const symlinkListing = await tool(1708, "fs_versions", {
    device_id: deviceId, path: raceFile,
  });
  assert.match(String(symlinkListing.error), /unsafe_undo_storage_entry/);
  const symlinkRestore = await tool(1709, "fs_undo", {
    device_id: deviceId, path: raceFile, undo_id: restartEdit.undoId,
    expected_sha256: restartEdit.sha256,
  });
  assert.match(String(symlinkRestore.error), /unsafe_undo_storage_entry/);
  assert.equal(fs.readFileSync(raceFile, "utf8"), "restart-edited");
  assert.deepEqual(fs.readFileSync(externalUndoTarget), intactUndoSnapshot);
  fs.unlinkSync(persistedSnapshot);
  fs.renameSync(parkedSnapshot, persistedSnapshot);
  fs.unlinkSync(externalUndoTarget);
  const recoveredAfterSymlink = await tool(1710, "fs_versions", {
    device_id: deviceId, path: raceFile,
  });
  assert.ok(recoveredAfterSymlink.versions.some((item) => item.undoId === restartEdit.undoId));
  console.log("agent-e2e: tampered, hardlinked, path-forged and symlinked undo snapshots rejected; recovery passed");

  const killedAgent = agent;
  assert.equal(killedAgent.kill("SIGKILL"), true, "native Agent must be running before crash test");
  await new Promise((resolve, reject) => {
    if (killedAgent.exitCode !== null || killedAgent.signalCode !== null) return resolve();
    killedAgent.once("exit", resolve);
    killedAgent.once("error", reject);
  });
  await waitFor(async () => {
    const devices = await jsonFetch("/api/devices", { headers: authHeaders });
    return devices.items.some((item) => item.id === deviceId && !item.online);
  }, 15000, 100);
  agent = startAgent();
  await waitFor(async () => {
    const devices = await jsonFetch("/api/devices", { headers: authHeaders });
    return devices.items.some((item) => item.id === deviceId && item.online);
  }, 20000, 100);

  const afterCrashVersions = await tool(1578, "fs_versions", {
    device_id: deviceId, path: raceFile,
  });
  assert.ok(afterCrashVersions.versions.some((item) => item.undoId === restartEdit.undoId));
  const deniedCrashUndo = await tool(1579, "fs_undo", {
    device_id: deviceId, path: raceFile, undo_id: restartEdit.undoId,
    expected_sha256: "0".repeat(64),
  });
  assert.equal(typeof deniedCrashUndo.error, "string");
  assert.equal(fs.readFileSync(raceFile, "utf8"), "restart-edited");
  const restoredAfterCrash = await tool(1580, "fs_undo", {
    device_id: deviceId, path: raceFile, undo_id: restartEdit.undoId,
    expected_sha256: restartEdit.sha256,
  });
  assert.equal(restoredAfterCrash.ok, true);
  assert.equal(fs.readFileSync(raceFile, "utf8"), "expiry-edited");
  const replayAfterCrash = await tool(1581, "fs_undo", {
    device_id: deviceId, path: raceFile, undo_id: restartEdit.undoId,
    expected_sha256: restartEdit.sha256,
  });
  assert.equal(typeof replayAfterCrash.error, "string");
  assert.equal(fs.existsSync(persistedSnapshot), false);
  console.log("agent-e2e: SIGKILL restart preserved undo; stale SHA and replay denied");

  const crashRecovery = await tool(577, "fs_versions", {
    device_id: deviceId, path: raceFile,
  });
  assert.ok(Array.isArray(crashRecovery.versions), JSON.stringify(crashRecovery));
  assert.equal(fs.existsSync(orphanStage), false);
  assert.equal(fs.existsSync(activeStage), true);
  assert.equal(fs.existsSync(unrelatedStage), true);
  fs.unlinkSync(activeStage);
  fs.unlinkSync(unrelatedStage);
  console.log("agent-e2e: orphan undo staging cleanup preserved fresh and unknown files");

  // Real MCP -> Gateway -> native Agent opt-in binary write undo.
  const versionedPath = path.join(tempRoot, "versioned-write.bin");
  const seedBytes = Buffer.from([0, 255, 42, 13]);
  fs.writeFileSync(versionedPath, seedBytes);
  const seedSha = createHash("sha256").update(seedBytes).digest("hex");
  const updatedBytes = Buffer.from([5, 4, 3]);
  const guardedWrite = await tool(580, "fs_write", {
    device_id: deviceId, path: versionedPath,
    content_base64: updatedBytes.toString("base64"),
    expected_sha256: seedSha, with_undo: true,
  });
  assert.equal(guardedWrite.ok, true, JSON.stringify(guardedWrite));
  assert.match(guardedWrite.undoId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fs.readFileSync(versionedPath), updatedBytes);
  const staleWrite = await tool(581, "fs_write", {
    device_id: deviceId, path: versionedPath,
    content_base64: Buffer.from("stale").toString("base64"),
    expected_sha256: seedSha, with_undo: true,
  });
  assert.equal(typeof staleWrite.error, "string");
  assert.deepEqual(fs.readFileSync(versionedPath), updatedBytes);
  const restoredWrite = await tool(582, "fs_undo", {
    device_id: deviceId, path: versionedPath,
    undo_id: guardedWrite.undoId, expected_sha256: guardedWrite.sha256,
  });
  assert.equal(restoredWrite.ok, true);
  assert.deepEqual(fs.readFileSync(versionedPath), seedBytes);
  const missingUndoWrite = await tool(583, "fs_write", {
    device_id: deviceId, path: path.join(tempRoot, "missing-undo.txt"),
    content_base64: Buffer.from("new").toString("base64"), with_undo: true,
  });
  assert.equal(typeof missingUndoWrite.error, "string");
  assert.equal(fs.existsSync(path.join(tempRoot, "missing-undo.txt")), false);
  console.log("agent-e2e: guarded fs_write binary undo, stale SHA and missing target passed");

  // 3A/3B: exercise the real MCP -> Gateway -> Agent authorization path.
  // A hardlinked target has an alias outside this pathname; guarded writes
  // must fail closed without changing either alias or leaving undo evidence.
  if (process.platform !== "win32") {
    const hardlinkedPath = path.join(tempRoot, "guarded-hardlink.txt");
    const hardlinkAlias = path.join(tempRoot, "guarded-hardlink-alias.txt");
    fs.writeFileSync(hardlinkedPath, "shared-seed");
    fs.linkSync(hardlinkedPath, hardlinkAlias);
    const hardlinkSha = createHash("sha256").update("shared-seed").digest("hex");
    const rejectedHardlink = await tool(1582, "fs_write", {
      device_id: deviceId, path: hardlinkedPath,
      content_base64: Buffer.from("not-published").toString("base64"),
      expected_sha256: hardlinkSha, with_undo: true,
    });
    assert.match(String(rejectedHardlink.error), /file_changed_since_read/);
    assert.equal(fs.readFileSync(hardlinkedPath, "utf8"), "shared-seed");
    assert.equal(fs.readFileSync(hardlinkAlias, "utf8"), "shared-seed");
    const rejectedVersions = await tool(1583, "fs_versions", {
      device_id: deviceId, path: hardlinkedPath,
    });
    assert.equal(rejectedVersions.versions.length, 0);
    fs.unlinkSync(hardlinkAlias);
    const acceptedAfterUnlink = await tool(1584, "fs_write", {
      device_id: deviceId, path: hardlinkedPath,
      content_base64: Buffer.from("published").toString("base64"),
      expected_sha256: hardlinkSha, with_undo: true,
    });
    assert.equal(acceptedAfterUnlink.ok, true, JSON.stringify(acceptedAfterUnlink));
    assert.equal(fs.readFileSync(hardlinkedPath, "utf8"), "published");
    console.log("agent-e2e: guarded hardlink rejection, no undo leak, and recovery passed");
  }

  // 3A real MCP vertical: the unguarded atomic writer must digest existing
  // files beyond the 4 MiB single-read budget instead of skipping conflict
  // detection. Existing files above the 32 MiB paged-read cap can be edited;
  // the separate 128 MiB conflict-scan ceiling remains fail-closed.
  const largeUnguardedPath = path.join(tempRoot, "large-unguarded-mcp.bin");
  fs.writeFileSync(largeUnguardedPath, Buffer.alloc(4 * 1024 * 1024 + 17, 0x61));
  const largeUnguardedWrite = await tool(1750, "fs_write", {
    device_id: deviceId, path: largeUnguardedPath,
    content_base64: Buffer.from("large-file-updated").toString("base64"),
  });
  assert.equal(largeUnguardedWrite.ok, true, JSON.stringify(largeUnguardedWrite));
  assert.equal(fs.readFileSync(largeUnguardedPath, "utf8"), "large-file-updated");

  const beyondPagedPath = path.join(tempRoot, "beyond-paged-unguarded-mcp.bin");
  fs.writeFileSync(beyondPagedPath, Buffer.from("paged-seed"));
  fs.truncateSync(beyondPagedPath, 32 * 1024 * 1024 + 1);
  const beyondPagedWrite = await tool(1754, "fs_write", {
    device_id: deviceId, path: beyondPagedPath,
    content_base64: Buffer.from("published-beyond-paged-limit").toString("base64"),
  });
  assert.equal(beyondPagedWrite.ok, true, JSON.stringify(beyondPagedWrite));
  assert.equal(fs.readFileSync(beyondPagedPath, "utf8"), "published-beyond-paged-limit");

  const overBudgetPath = path.join(tempRoot, "oversized-unguarded-mcp.bin");
  const overBudgetSize = 128 * 1024 * 1024 + 1;
  fs.writeFileSync(overBudgetPath, Buffer.alloc(1, 0x6b));
  fs.truncateSync(overBudgetPath, overBudgetSize);
  const overBudgetWrite = await tool(1751, "fs_write", {
    device_id: deviceId, path: overBudgetPath,
    content_base64: Buffer.from("must-not-overwrite").toString("base64"),
  });
  assert.match(String(overBudgetWrite.error), /file_changed_since_read/, JSON.stringify(overBudgetWrite));
  assert.equal(fs.statSync(overBudgetPath).size, overBudgetSize);
  const overBudgetFd = fs.openSync(overBudgetPath, "r");
  try {
    const firstByte = Buffer.alloc(1);
    assert.equal(fs.readSync(overBudgetFd, firstByte, 0, 1, 0), 1);
    assert.equal(firstByte[0], 0x6b);
  } finally {
    fs.closeSync(overBudgetFd);
  }
  console.log("agent-e2e: unguarded >32MiB MCP write accepted; >128MiB fail-closed without data loss");

  // 3A: unlike an expected-SHA write, this path has no client CAS token.
  // The Agent still must reject hardlink aliases through MCP and preserve
  // the other pathname. Removing the alias must restore normal operation.
  const unguardedHardlinkPath = path.join(tempRoot, "unguarded-mcp-hardlink.txt");
  const unguardedHardlinkAlias = path.join(tempRoot, "unguarded-mcp-hardlink-alias.txt");
  fs.writeFileSync(unguardedHardlinkPath, "unguarded-shared-seed");
  fs.linkSync(unguardedHardlinkPath, unguardedHardlinkAlias);
  const rejectedUnguardedHardlink = await tool(1752, "fs_write", {
    device_id: deviceId, path: unguardedHardlinkPath,
    content_base64: Buffer.from("must-not-publish").toString("base64"),
  });
  assert.match(String(rejectedUnguardedHardlink.error), /file_changed_since_read/, JSON.stringify(rejectedUnguardedHardlink));
  assert.equal(fs.readFileSync(unguardedHardlinkPath, "utf8"), "unguarded-shared-seed");
  assert.equal(fs.readFileSync(unguardedHardlinkAlias, "utf8"), "unguarded-shared-seed");
  fs.unlinkSync(unguardedHardlinkAlias);
  const acceptedUnguardedHardlink = await tool(1753, "fs_write", {
    device_id: deviceId, path: unguardedHardlinkPath,
    content_base64: Buffer.from("published-after-unlink").toString("base64"),
  });
  assert.equal(acceptedUnguardedHardlink.ok, true, JSON.stringify(acceptedUnguardedHardlink));
  assert.equal(fs.readFileSync(unguardedHardlinkPath, "utf8"), "published-after-unlink");
  console.log("agent-e2e: unguarded MCP hardlink alias rejected; safe retry accepted");

  // 3A: deterministic *real* MCP -> Gateway -> Rust Agent interprocess
  // race. The CI-only Agent barrier stops after staging, before the final
  // digest. The test process then edits the same inode without a SHA token.
  // Neither the external bytes nor the original should be overwritten.
  fs.writeFileSync(mcpCasTarget, "original-mcp");
  const pendingMcpCas = tool(1755, "fs_write", {
    device_id: deviceId, path: mcpCasTarget,
    content_base64: Buffer.from("must-not-publish").toString("base64"),
  });
  try {
    await waitFor(() => fs.existsSync(mcpCasMarker), 20000, 20);
    fs.writeFileSync(mcpCasTarget, "external-mcp");
  } finally {
    fs.writeFileSync(mcpCasRelease, "continue");
  }
  const rejectedMcpCas = await pendingMcpCas;
  assert.match(String(rejectedMcpCas.error), /file_changed_since_read/, JSON.stringify(rejectedMcpCas));
  assert.equal(fs.readFileSync(mcpCasTarget, "utf8"), "external-mcp");
  assert.equal(
    fs.readdirSync(tempRoot).filter((name) => name.startsWith(".wecommander-") && name.endsWith(".tmp")).length,
    0,
    "rejected MCP race must not leak staging files",
  );
  const retriedMcpCas = await tool(1756, "fs_write", {
    device_id: deviceId, path: mcpCasTarget,
    content_base64: Buffer.from("safe-retry").toString("base64"),
  });
  assert.equal(retriedMcpCas.ok, true, JSON.stringify(retriedMcpCas));
  assert.equal(fs.readFileSync(mcpCasTarget, "utf8"), "safe-retry");
  console.log("agent-e2e: cross-process midstage MCP edit rejected, external bytes preserved, retry passed");

  const guardedAppend = await tool(584, "fs_append", {
    device_id: deviceId, path: versionedPath,
    content_base64: Buffer.from([7, 8]).toString("base64"),
    expected_sha256: seedSha, with_undo: true,
  });
  assert.equal(guardedAppend.ok, true, JSON.stringify(guardedAppend));
  assert.match(guardedAppend.undoId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fs.readFileSync(versionedPath), Buffer.from([0, 255, 42, 13, 7, 8]));
  const staleAppend = await tool(585, "fs_append", {
    device_id: deviceId, path: versionedPath,
    content_base64: Buffer.from([9]).toString("base64"),
    expected_sha256: seedSha, with_undo: true,
  });
  assert.equal(typeof staleAppend.error, "string");
  const restoredAppend = await tool(586, "fs_undo", {
    device_id: deviceId, path: versionedPath,
    undo_id: guardedAppend.undoId, expected_sha256: guardedAppend.sha256,
  });
  assert.equal(restoredAppend.ok, true);
  assert.deepEqual(fs.readFileSync(versionedPath), seedBytes);
  console.log("agent-e2e: guarded fs_append atomic undo and stale SHA negative tests passed");

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

  // 3A: fs_move must never overwrite a destination created concurrently.
  // This exercises the real MCP -> Gateway -> native Agent path, not a stub.
  const collisionDestination = path.join(tempRoot, "move-collision.txt");
  const collisionSources = Array.from({ length: 8 }, (_, index) =>
    path.join(tempRoot, `move-candidate-${index}.txt`)
  );
  collisionSources.forEach((source, index) =>
    fs.writeFileSync(source, `move-candidate-${index}`, "utf8")
  );
  const collisionMoves = await Promise.all(collisionSources.map((source, index) =>
    tool(610 + index, "fs_move", {
      device_id: deviceId, source, destination: collisionDestination,
    })
  ));
  assert.equal(collisionMoves.filter((result) => result.ok === true).length, 1);
  assert.equal(collisionMoves.filter((result) => typeof result.error === "string").length, 7);
  assert.match(fs.readFileSync(collisionDestination, "utf8"), /^move-candidate-[0-7]$/);
  assert.equal(collisionSources.filter((source) => fs.existsSync(source)).length, 7);
  const stillPresentSource = collisionSources.find((source) => fs.existsSync(source));
  const noOverwrite = await tool(618, "fs_move", {
    device_id: deviceId, source: stillPresentSource, destination: collisionDestination,
  });
  assert.equal(typeof noOverwrite.error, "string");
  assert.match(fs.readFileSync(collisionDestination, "utf8"), /^move-candidate-[0-7]$/);
  console.log("agent-e2e: concurrent fs_move destination collision never overwrote winner");

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

  // 2B: two authenticated principals must not observe or control each other's
  // live terminal, even when both have access to the same enrolled device.
  for (const [headers, requestId] of [[headersA, 340], [headersB, 350]]) {
    const foreignList = await toolAs(headers, requestId, "terminal_list", { device_id: deviceId });
    assert.equal(foreignList.items.some((item) => item.sessionId === started.sessionId), false);
    const foreignPage = await toolAs(headers, requestId + 1, "terminal_read_page", {
      device_id: deviceId, session_id: started.sessionId,
    });
    assert.match(String(foreignPage.error), /terminal session not found/i);
    const foreignInput = await toolAs(headers, requestId + 2, "terminal_input", {
      device_id: deviceId, session_id: started.sessionId,
      data_base64: Buffer.from("echo UNAUTHORIZED\\n").toString("base64"),
    });
    assert.match(String(foreignInput.error), /terminal session not found/i);
  }
  console.log("agent-e2e: two real actors denied foreign live terminal list/read/input");

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

  // 2A: paginate real PTY output by absolute byte cursor across multiple
  // non-consuming pages. A terminal_read drain must not destroy the history.
  // The short command generates 20,000 bytes without sending a huge input.
  const beforePagedOutput = historyAfterDrain.totalOutputBytes;
  await tool(301, "terminal_input", {
    device_id: deviceId,
    session_id: started.sessionId,
    data_base64: Buffer.from(
      "printf '\\nPTY_PAGED_BEGIN\\n'; printf '%020000d' 0; printf '\\nPTY_PAGED_END\\n'\n",
      "utf8",
    ).toString("base64"),
  });
  const readyPage = await waitFor(async () => {
    const snapshot = await tool(302, "terminal_read_page", {
      device_id: deviceId,
      session_id: started.sessionId,
      offset_bytes: -65536,
      max_bytes: 65536,
    });
    return snapshot.totalOutputBytes >= beforePagedOutput + 20000 &&
      /PTY_PAGED_BEGIN\r?\n0{20000}\r?\nPTY_PAGED_END/.test(snapshot.text)
      ? snapshot : false;
  }, 15000, 250);
  const snapshotEnd = readyPage.totalOutputBytes;
  let cursor = readyPage.retainedStartBytes;
  const chunks = [];
  while (cursor < snapshotEnd) {
    const part = await tool(303, "terminal_read_page", {
      device_id: deviceId,
      session_id: started.sessionId,
      offset_bytes: cursor,
      max_bytes: 4096,
    });
    assert.equal(part.offsetBytes, cursor, "PTY history must not skip bytes");
    assert.ok(part.nextOffsetBytes > cursor, "PTY page must advance the cursor");
    assert.equal(part.truncatedBeforeOffset, false);
    chunks.push(Buffer.from(part.dataBase64, "base64"));
    cursor = part.nextOffsetBytes;
  }
  const reassembled = Buffer.concat(chunks).toString("utf8");
  assert.match(reassembled, /PTY_PAGED_BEGIN\r?\n0{20000}\r?\nPTY_PAGED_END/);
  console.log("agent-e2e: real PTY paged output reassembled without byte gaps");

  // 2A: exercise a real interactive REPL, not a simulated ">>> " fixture.
  // Prompt metadata is advisory; command completion and authorization must
  // never be inferred solely from output controlled by the subprocess.
  await tool(304, "terminal_input", {
    device_id: deviceId,
    session_id: started.sessionId,
    data_base64: Buffer.from("python3 -q\n", "utf8").toString("base64"),
  });
  const replPrompt = await waitFor(async () => {
    const page = await tool(305, "terminal_read_page", {
      device_id: deviceId,
      session_id: started.sessionId,
      offset_bytes: -8192,
      max_bytes: 8192,
    });
    return page.promptKind === "python" && page.promptDetected === true &&
      String(page.text).includes(">>> ") ? page : false;
  }, 15000, 250);
  assert.equal(replPrompt.promptKind, "python");
  await tool(306, "terminal_input", {
    device_id: deviceId,
    session_id: started.sessionId,
    data_base64: Buffer.from("print('REPL_AGENT_OK')\n", "utf8").toString("base64"),
  });
  await waitFor(async () => {
    const page = await tool(307, "terminal_read_page", {
      device_id: deviceId,
      session_id: started.sessionId,
      offset_bytes: -8192,
      max_bytes: 8192,
    });
    return page.promptKind === "python" &&
      String(page.text).includes("REPL_AGENT_OK") ? page : false;
  }, 15000, 250);
  await tool(308, "terminal_input", {
    device_id: deviceId,
    session_id: started.sessionId,
    data_base64: Buffer.from("exit()\n", "utf8").toString("base64"),
  });
  console.log("agent-e2e: real Python REPL prompt metadata observed through MCP");

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


  // 2B: preserve bounded PTY output through a real Rust Agent SIGKILL.
  const archiveToken = await approval(deviceId, startAction);
  const archiveSession = await tool(330, "terminal_start", {
    device_id: deviceId, cwd: tempRoot, cols: 100, rows: 30, approval_token: archiveToken,
  });
  await tool(331, "terminal_input", {
    device_id: deviceId, session_id: archiveSession.sessionId,
    data_base64: Buffer.from("echo DURABLE_HISTORY_AGENT_OK\n").toString("base64"),
  });
  await waitFor(async () => {
    const page = await tool(332, "terminal_read_page", {
      device_id: deviceId, session_id: archiveSession.sessionId, offset_bytes: -8192, max_bytes: 8192,
    });
    return page.historyDurable && String(page.text).includes("DURABLE_HISTORY_AGENT_OK") ? page : false;
  });
  // 2B negative restart acceptance: the native HistoryStore may reclaim
  // expired UUID staging files, never unrelated old dotfiles in its directory.
  const historyDeviceDirectory = path.join(tempRoot, "xdg-data", "webrising-commender",
    "terminal-history", deviceId);
  const scopedHistoryDirs = fs.readdirSync(historyDeviceDirectory).filter((name) =>
    /^[a-f0-9]{64}$/.test(name) && fs.statSync(path.join(historyDeviceDirectory, name)).isDirectory());
  assert.equal(scopedHistoryDirs.length, 1, "one authenticated admin terminal history namespace expected");
  const historyDirectory = path.join(historyDeviceDirectory, scopedHistoryDirs[0]);
  assert.equal(fs.existsSync(historyDirectory), true);
  const oldHistoryStage = path.join(historyDirectory, ".00000000-0000-4000-8000-000000000003.tmp");
  const foreignHistoryStage = path.join(historyDirectory, ".foreign-maintenance.tmp");
  fs.writeFileSync(oldHistoryStage, "orphan");
  fs.writeFileSync(foreignHistoryStage, "do-not-delete");
  const oldHistoryTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(oldHistoryStage, oldHistoryTime, oldHistoryTime);
  fs.utimesSync(foreignHistoryStage, oldHistoryTime, oldHistoryTime);
  const oldAgent = agent;
  const exit = new Promise((resolve) => oldAgent.once("exit", resolve));
  oldAgent.kill("SIGKILL");
  await exit;
  agent = spawn(agentBinary, ["--config", configPath, "run"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: "info", XDG_DATA_HOME: path.join(tempRoot, "xdg-data") },
  });
  agent.stdout.on("data", (chunk) => { agentLog += chunk.toString(); });
  agent.stderr.on("data", (chunk) => { agentLog += chunk.toString(); });
  await waitFor(async () => {
    const devices = await jsonFetch("/api/devices", { headers: authHeaders });
    return devices.items.some((item) => item.id === deviceId && item.online);
  });
  const archived = await waitFor(async () => {
    const page = await tool(333, "terminal_read_page", {
      device_id: deviceId, session_id: archiveSession.sessionId, offset_bytes: -8192, max_bytes: 8192,
    });
    return page.archived && String(page.text).includes("DURABLE_HISTORY_AGENT_OK") ? page : false;
  });
  assert.equal(archived.running, false);
  assert.equal(archived.historyDurable, true);
  assert.equal(fs.existsSync(oldHistoryStage), false);
  assert.equal(fs.readFileSync(foreignHistoryStage, "utf8"), "do-not-delete");
  fs.rmSync(foreignHistoryStage);
  console.log("agent-e2e: terminal history restart pruned only UUID staging; foreign data preserved");
  assert.equal(typeof (await tool(334, "terminal_input", {
    device_id: deviceId, session_id: archiveSession.sessionId,
    data_base64: Buffer.from("echo cannot-reattach\n").toString("base64"),
  })).error, "string");
  console.log("agent-e2e: bounded PTY history survived real Agent SIGKILL/restart");

  // 2B: verify the durable format end-to-end after a real Agent restart.
  // Same-length corruption must be rejected, not silently returned as output.
  const archiveFiles = fs.readdirSync(historyDirectory).filter((name) =>
    name.startsWith(`${archiveSession.sessionId}-`) && name.endsWith(".hist"));
  assert.equal(archiveFiles.length, 1);
  const foreignArchived = await toolAs(headersA, 354, "terminal_read_page", {
    device_id: deviceId, session_id: archiveSession.sessionId,
  });
  assert.match(String(foreignArchived.error), /terminal session not found/i);
  console.log("agent-e2e: foreign actor denied durable PTY history after SIGKILL/restart");
  const archivePath = path.join(historyDirectory, archiveFiles[0]);
  const archiveRaw = fs.readFileSync(archivePath);
  assert.equal(archiveRaw.subarray(0, 8).toString("ascii"), "WCTH0002");
  assert.ok(archiveRaw.length > 52);
  archiveRaw[20] ^= 1;
  fs.writeFileSync(archivePath, archiveRaw);
  const tamperedPage = await tool(335, "terminal_read_page", {
    device_id: deviceId, session_id: archiveSession.sessionId,
    offset_bytes: -8192, max_bytes: 8192,
  });
  assert.match(String(tamperedPage.error), /corrupt terminal history checksum/);
  console.log("agent-e2e: v2 terminal history same-size corruption rejected after SIGKILL/restart");

  // 2B: a running Agent must enforce the global archive quota on each
  // durable PTY save, not only after a restart. Populate bounded fixture
  // filenames and trigger the actual save through authenticated MCP.
  const quotaFixtures = [];
  for (let index = 1; index <= 70; index += 1) {
    const fixtureId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const fixturePath = path.join(historyDirectory, `${fixtureId}-1.hist`);
    fs.writeFileSync(fixturePath, Buffer.from("fixture-not-for-reading"));
    const fixtureTime = new Date(Date.now() - 2 * 60 * 1000);
    fs.utimesSync(fixturePath, fixtureTime, fixtureTime);
    quotaFixtures.push(fixturePath);
  }
  const quotaStartToken = await approval(deviceId, startAction);
  const quotaSession = await tool(336, "terminal_start", {
    device_id: deviceId, cwd: tempRoot, cols: 100, rows: 30,
    approval_token: quotaStartToken,
  });
  assert.equal(typeof quotaSession.sessionId, "string");
  await tool(337, "terminal_input", {
    device_id: deviceId, session_id: quotaSession.sessionId,
    data_base64: Buffer.from("echo LIVE_HISTORY_QUOTA_OK\n").toString("base64"),
  });
  await waitFor(async () => {
    const page = await tool(338, "terminal_read_page", {
      device_id: deviceId, session_id: quotaSession.sessionId,
      offset_bytes: -8192, max_bytes: 8192,
    });
    return page.historyDurable && String(page.text).includes("LIVE_HISTORY_QUOTA_OK");
  });
  const retainedArchives = fs.readdirSync(historyDirectory)
    .filter((name) => name.endsWith(".hist"));
  assert.ok(retainedArchives.length <= 64,
    `live Agent retained ${retainedArchives.length} archives above quota`);
  assert.ok(retainedArchives.some((name) => name.startsWith(`${quotaSession.sessionId}-`)),
    "current live session archive was evicted");
  assert.ok(quotaFixtures.some((fixture) => !fs.existsSync(fixture)),
    "old fixture archives were not pruned");
  const quotaStopToken = await approval(deviceId, {
    kind: "terminal_stop", sessionId: quotaSession.sessionId,
  });
  const quotaStopped = await tool(339, "terminal_stop", {
    device_id: deviceId, session_id: quotaSession.sessionId,
    approval_token: quotaStopToken,
  });
  assert.equal(quotaStopped.ok, true, JSON.stringify(quotaStopped));
  console.log("agent-e2e: live MCP PTY save enforced 64-archive quota without restart");

  // 2B: exercise the five-second HistoryStore filesystem lock timeout through
  // the real authenticated MCP -> Gateway -> Rust Agent path. The lock holder
  // is an independent Linux process (util-linux is test-only, not a runtime
  // dependency). A timeout must not modify the archived terminal data.
  if (process.platform === "linux") {
    const historyLockPath = path.join(historyDirectory, ".history.lock");
    assert.equal(fs.existsSync(historyLockPath), true);
    const filesBeforeLock = fs.readdirSync(historyDirectory).sort();
    let lockReady = false;
    let lockHolderError = "";
    const lockHolder = spawn("flock", [
      "-x", "-F", historyLockPath, "sh", "-c",
      "printf 'HISTORY_LOCK_HELD\\n'; exec sleep 15",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    lockHolder.stdout.on("data", (chunk) => {
      if (String(chunk).includes("HISTORY_LOCK_HELD")) lockReady = true;
    });
    lockHolder.stderr.on("data", (chunk) => { lockHolderError += String(chunk); });
    try {
      await waitFor(() => {
        if (lockHolder.exitCode !== null || lockHolder.signalCode !== null) {
          throw new Error(`lock holder exited before acquiring lock: ${lockHolderError}`);
        }
        return lockReady;
      }, 5000, 50);
      const beganWaiting = Date.now();
      const blockedArchive = await tool(355, "terminal_read_page", {
        device_id: deviceId, session_id: quotaSession.sessionId,
        offset_bytes: -8192, max_bytes: 8192,
      });
      assert.match(String(blockedArchive.error), /terminal history filesystem lock timeout/i);
      assert.ok(Date.now() - beganWaiting >= 4000, "MCP lock timeout was not bounded by the real wait");
      assert.deepEqual(fs.readdirSync(historyDirectory).sort(), filesBeforeLock,
        "timed-out archive read unexpectedly changed the history directory");
    } finally {
      lockHolder.kill("SIGTERM");
      if (lockHolder.exitCode === null && lockHolder.signalCode === null) {
        await new Promise((resolve) => lockHolder.once("exit", resolve));
      }
    }
    const archiveAfterLock = await tool(356, "terminal_read_page", {
      device_id: deviceId, session_id: quotaSession.sessionId,
      offset_bytes: -8192, max_bytes: 8192,
    });
    assert.equal(archiveAfterLock.archived, true, JSON.stringify(archiveAfterLock));
    assert.match(archiveAfterLock.text, /LIVE_HISTORY_QUOTA_OK/);
    console.log("agent-e2e: independent OS lock denied archived PTY MCP read after bounded timeout; unlock recovered");
  }

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

  // 2C: real Agent/Gateway/MCP timeout and cancellation must terminate
  // descendants, not just the foreground shell. The markers would be
  // created by leaked grandchildren two seconds after the request ends.
  if (process.platform !== "win32") {
    const timeoutMarker = path.join(tempRoot, "timeout-descendant-leaked");
    const timeoutCommand =
      "(sleep 2; printf leaked > '" + timeoutMarker + "') & wait";
    const timeoutToken = await approval(deviceId, {
      kind: "process_exec", command: timeoutCommand, cwd: tempRoot, timeoutMs: 250,
    });
    const timedOut = await tool(341, "process_exec", {
      device_id: deviceId, command: timeoutCommand, cwd: tempRoot,
      timeout_ms: 250, approval_token: timeoutToken,
    });
    assert.match(timedOut.error, /timed out/i);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(fs.existsSync(timeoutMarker), false, "timed-out descendant survived");

    const cancelReady = path.join(tempRoot, "cancel-task-ready");
    const cancelMarker = path.join(tempRoot, "cancel-descendant-leaked");
    const cancelCommand =
      "printf ready > '" + cancelReady +
      "'; (sleep 2; printf leaked > '" + cancelMarker + "') & wait";
    const cancelStartToken = await approval(deviceId, {
      kind: "task_start", command: cancelCommand, cwd: tempRoot, timeoutMs: 10000,
    });
    const cancelTask = await tool(342, "task_start", {
      device_id: deviceId, command: cancelCommand, cwd: tempRoot,
      timeout_ms: 10000, approval_token: cancelStartToken,
    });
    assert.equal(typeof cancelTask.taskId, "string");
    await waitFor(() => fs.existsSync(cancelReady), 5000, 20);
    const cancelToken = await approval(deviceId, {
      kind: "task_cancel", taskId: cancelTask.taskId,
    });
    const canceledTask = await tool(343, "task_cancel", {
      device_id: deviceId, task_id: cancelTask.taskId,
      approval_token: cancelToken,
    });
    assert.equal(canceledTask.canceled, true);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(fs.existsSync(cancelMarker), false, "canceled descendant survived");
    // 2D: cancellation immediately after task_start must always find the
    // published abort handle, even if the shell has not begun execution.
    const immediateMarker = path.join(tempRoot, "immediate-cancel-leaked");
    const immediateCommand =
      "sleep 1; printf leaked > '" + immediateMarker + "'";
    const immediateStartToken = await approval(deviceId, {
      kind: "task_start", command: immediateCommand, cwd: tempRoot, timeoutMs: 10000,
    });
    const immediateTask = await tool(346, "task_start", {
      device_id: deviceId, command: immediateCommand, cwd: tempRoot,
      timeout_ms: 10000, approval_token: immediateStartToken,
    });
    assert.equal(typeof immediateTask.taskId, "string", JSON.stringify(immediateTask));
    const immediateCancelToken = await approval(deviceId, {
      kind: "task_cancel", taskId: immediateTask.taskId,
    });
    const immediateCancel = await tool(347, "task_cancel", {
      device_id: deviceId, task_id: immediateTask.taskId,
      approval_token: immediateCancelToken,
    });
    assert.equal(immediateCancel.canceled, true, JSON.stringify(immediateCancel));
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(fs.existsSync(immediateMarker), false, "immediately canceled task executed");
    console.log("agent-e2e: immediate task cancellation did not leak command execution");
    // process_kill must reject the Agent itself and terminate a separate
    // approved target's visible child tree before its parent exits.
    const protectedToken = await approval(deviceId, {
      kind: "process_kill", pid: agent.pid,
    });
    const protectedResult = await tool(344, "process_kill", {
      device_id: deviceId, pid: agent.pid, approval_token: protectedToken,
    });
    assert.match(protectedResult.error, /protected process/i);

    const killReady = path.join(tempRoot, "kill-tree-ready");
    const killMarker = path.join(tempRoot, "kill-tree-descendant-leaked");
    const killCommand =
      "printf ready > '" + killReady +
      "'; (sleep 2; printf leaked > '" + killMarker + "') & wait";
    const killParent = spawn("/bin/sh", ["-c", killCommand], { stdio: "ignore" });
    try {
      await waitFor(() => fs.existsSync(killReady), 5000, 20);
      const killToken = await approval(deviceId, {
        kind: "process_kill", pid: killParent.pid,
      });
      const killed = await tool(345, "process_kill", {
        device_id: deviceId, pid: killParent.pid, approval_token: killToken,
      });
      assert.equal(killed.ok, true, JSON.stringify(killed));
      assert.ok(killed.signaledDescendants >= 1, JSON.stringify(killed));
      await new Promise((resolve) => setTimeout(resolve, 2200));
      assert.equal(fs.existsSync(killMarker), false, "process_kill left a descendant alive");
    } finally {
      if (killParent.exitCode === null) killParent.kill("SIGKILL");
    }
    console.log("agent-e2e: process_kill protected Agent and reaped visible descendants");
    console.log("agent-e2e: process timeout and task cancel reaped Unix descendants");
  }

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
