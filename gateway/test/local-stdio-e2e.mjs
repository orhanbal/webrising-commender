// Local mode (v1.1 item 4): drive the real agent binary over MCP stdio, the
// way Claude Desktop does, with no gateway. Checks the handshake, that the
// advertised tools equal the gateway's local set, the allowed-root boundary,
// that writes/commands stay off without the flags, undo after a write, and
// that the audit log records calls without contents.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const binary = process.env.AGENT_BIN || path.resolve(here, "../../target/debug/webrising-commender");
const expectedTools = JSON.parse(fs.readFileSync(path.resolve(here, "../../crates/agent/src/local_tools.json"), "utf8")).map((t) => t.name);

function start(args) {
  const child = spawn(binary, ["mcp-stdio", ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (d) => { stderr += d; });
  const pending = new Map(); let next = 1;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line); // stdout must be JSON-RPC only
    pending.get(message.id)?.(message); pending.delete(message.id);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = next++; const timer = setTimeout(() => reject(new Error(method + " timed out\n" + stderr)), 15000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  const call = async (name, args) => { const r = (await rpc("tools/call", { name, arguments: args })).result; return { error: r.isError, data: r.structuredContent }; };
  return { child, rpc, notify, call, stop: () => child.kill() };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wc-local-e2e-"));
const audit = path.join(root, ".audit", "calls.log");
fs.writeFileSync(path.join(root, "notes.txt"), "secret content line\n");

// 1) Default: read-only, no commands.
const ro = start(["--allowed-root", root, "--audit-log", audit]);
try {
  const init = await ro.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "wecommander-local");
  assert.match(init.result.instructions, /File writes are off/);
  ro.notify("notifications/initialized");
  const listed = (await ro.rpc("tools/list", {})).result.tools.map((t) => t.name);
  assert.deepEqual(listed, expectedTools, "local tools equal the generated gateway set");
  const read = await ro.call("fs_read", { path: path.join(root, "notes.txt") });
  assert.equal(read.error, false); assert.equal(read.data.content, "secret content line\n");
  assert.equal((await ro.call("fs_list", { path: "/" })).error, true, "outside the allowed root");
  assert.match((await ro.call("fs_write", { path: path.join(root, "x.txt"), content_base64: "aGk=" })).data.error, /device_policy_denied/);
  assert.match((await ro.call("process_exec", { command: "id" })).data.error, /device_policy_denied/);
  // Desktop Commander names work locally too (the reported list_directory gap).
  const dcList = await ro.call("list_directory", { path: root });
  assert.equal(dcList.error, false, JSON.stringify(dcList.data)); assert.match(JSON.stringify(dcList.data), /notes\.txt/);
  const dcRead = await ro.call("read_file", { path: path.join(root, "notes.txt"), offset: 0, length: 1 });
  assert.equal(dcRead.error, false, JSON.stringify(dcRead.data)); assert.match(JSON.stringify(dcRead.data), /secret content line/);
  assert.equal((await ro.call("get_file_info", { path: path.join(root, "notes.txt") })).error, false);
  assert.match((await ro.call("write_file", { path: path.join(root, "x.txt"), content: "hi" })).data.error, /device_policy_denied/);
  assert.equal((await ro.call("list_directory", { path: "/" })).error, true, "aliases keep the allowed root");
  assert.equal((await ro.call("url_fetch", { url: "https://example.com" })).error, true, "url_fetch is gateway-only");
  assert.equal((await ro.call("devices_list", {})).error, true, "gateway-only tools are unknown locally");
  assert.equal((await ro.rpc("nope", {})).error.code, -32601);
} finally { ro.stop(); }

// 2) With --allow-writes and --allow-commands: Desktop Commander behaviour inside the root.
const rw = start(["--allowed-root", root, "--allow-writes", "--allow-commands", "--audit-log", audit]);
try {
  await rw.rpc("initialize", { protocolVersion: "2025-03-26" });
  const target = path.join(root, "notes.txt");
  const replaced = await rw.call("fs_replace", { path: target, search: "secret", replace: "public" });
  assert.equal(replaced.error, false, JSON.stringify(replaced.data));
  assert.equal(fs.readFileSync(target, "utf8"), "public content line\n");
  const versions = await rw.call("fs_versions", { path: target });
  assert.ok(versions.data.versions?.length >= 1, "a write keeps an undo snapshot: " + JSON.stringify(versions.data));
  assert.equal(versions.data.versions[0].undoId, replaced.data.undoId);
  const undone = await rw.call("fs_undo", { path: target, undo_id: replaced.data.undoId, expected_sha256: replaced.data.sha256 });
  assert.equal(undone.error, false, JSON.stringify(undone.data));
  assert.equal(fs.readFileSync(target, "utf8"), "secret content line\n", "undo restores the content");
  const edited = await rw.call("edit_block", { file_path: target, old_string: "secret  content", new_string: "edited content" });
  assert.equal(edited.error, false, JSON.stringify(edited.data)); assert.equal(edited.data.match, "whitespace");
  assert.equal(fs.readFileSync(target, "utf8"), "edited content line\n");
  const miss = await rw.call("edit_block", { file_path: target, old_string: "edited contnt line", new_string: "x" });
  assert.equal(miss.error, true); assert.equal(miss.data.error, "no_match"); assert.equal(miss.data.closest_line, 1);
  if (process.platform !== "win32") {
    const exec = await rw.call("process_exec", { command: "echo local-mode-ok", cwd: root });
    assert.equal(exec.error, false, JSON.stringify(exec.data)); assert.match(JSON.stringify(exec.data), /local-mode-ok/);
    // v1.2: secrets in command output are masked on the device by default.
    const leak = await rw.call("process_exec", { command: "echo DB_PASSWORD=hunter2xyz", cwd: root });
    assert.equal(leak.error, false, JSON.stringify(leak.data));
    assert.match(leak.data.stdout, /DB_PASSWORD=\[REDACTED\]/); assert.doesNotMatch(JSON.stringify(leak.data), /hunter2xyz/);
    assert.equal(leak.data.redactions, 1);
    assert.equal((await rw.call("policy_info", {})).data.outputRedaction, "enabled");
  }
  assert.equal((await rw.call("fs_delete", { path: path.join(root, "..", "outside.txt") })).error, true, "root still enforced with all flags");
} finally { rw.stop(); }

// 3) --no-redact: the owner can turn masking off.
if (process.platform !== "win32") {
  const raw = start(["--allowed-root", root, "--allow-commands", "--no-redact"]);
  try {
    await raw.rpc("initialize", { protocolVersion: "2025-06-18" });
    const out = await raw.call("process_exec", { command: "echo DB_PASSWORD=hunter2xyz", cwd: root });
    assert.match(out.data.stdout, /hunter2xyz/); assert.equal(out.data.redactions, undefined);
    assert.equal((await raw.call("policy_info", {})).data.outputRedaction, "disabled");
  } finally { raw.stop(); }
}

const lines = fs.readFileSync(audit, "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.ok(lines.length >= 9, "every call is audited");
assert.ok(lines.some((l) => l.tool === "process_exec" && l.outcome === "denied"));
assert.ok(lines.some((l) => l.tool === "fs_replace" && l.outcome === "success"));
assert.ok(lines.some((l) => l.tool === "edit_block" && l.outcome === "success"));
assert.ok(!fs.readFileSync(audit, "utf8").includes("secret content"), "the audit log never contains file contents");
fs.rmSync(root, { recursive: true, force: true });
console.log("local stdio MCP acceptance passed");
