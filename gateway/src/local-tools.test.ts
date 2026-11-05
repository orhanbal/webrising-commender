import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// mcp.ts loads modules that read configuration at import; nothing connects here.
process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
process.env.CONTROL_API_KEY ??= "unit-test-control-key-0123456789-0123456789";
process.env.APPROVAL_SIGNING_SECRET ??= "unit-test-approval-secret-0123456789-01234";
const { actionFromTool } = await import("./mcp.js");
const { genericAction, localTools, sample } = await import("./local-tools.js");

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../crates/agent/src/local_tools.json");

test("crates/agent/src/local_tools.json matches the gateway tool definitions", () => {
  const expected = JSON.stringify(localTools(), null, 1) + "\n";
  assert.equal(fs.readFileSync(file, "utf8"), expected, "regenerate with: cd gateway && npm run -s export-local-tools");
});

test("the agent's generic argument conversion equals the gateway's mapping for every local tool", () => {
  const tools = localTools();
  assert.ok(tools.length > 30, "most device tools are served locally");
  for (const tool of tools) {
    const args: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(tool.inputSchema.properties ?? {})) args[key] = sample(schema, key);
    assert.deepEqual(genericAction(tool.name, args), actionFromTool(tool.name, args), tool.name);
  }
});

test("gateway-only tools are not offered locally", () => {
  const names = new Set(localTools().map((t) => t.name));
  for (const name of ["devices_list", "url_fetch", "edit_block", "start_search", "get_recent_tool_calls"]) assert.ok(!names.has(name), name);
  for (const name of ["fs_read", "fs_write", "process_exec", "pdf_read", "task_start", "terminal_start"]) assert.ok(names.has(name), name);
});
