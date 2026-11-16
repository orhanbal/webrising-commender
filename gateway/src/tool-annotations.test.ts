import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
process.env.CONTROL_API_KEY ??= "test-control-key-0123456789-0123456789";
process.env.APPROVAL_SIGNING_SECRET ??= "test-approval-secret-0123456789-012345";

const { tools, listedTools, actionFromTool } = await import("./mcp.js");
const { DC_TOOLS, translateAlias } = await import("./dc-compat.js");
const { actionRisk } = await import("./protocol.js");
const { annotationKind, toolAnnotations } = await import("./tool-annotations.js");
const { sample, localTools } = await import("./local-tools.js");

const sampleArgs = (tool: any) => {
  const args: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.inputSchema?.properties ?? {})) args[key] = sample(schema, key);
  return args;
};

test("every listed tool carries MCP annotations with a title", () => {
  const listed = listedTools();
  assert.equal(listed.length, tools.length + DC_TOOLS.length);
  for (const tool of listed) {
    assert.ok(tool.annotations, `${tool.name} has no annotations`);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    assert.equal(typeof tool.annotations.destructiveHint, "boolean");
    assert.equal(typeof tool.annotations.idempotentHint, "boolean");
    assert.equal(typeof tool.annotations.openWorldHint, "boolean");
    assert.ok(tool.title && tool.title === tool.annotations.title, `${tool.name} has no title`);
    assert.ok(!(tool.annotations.readOnlyHint && tool.annotations.destructiveHint), `${tool.name} cannot be read-only and destructive`);
  }
});

test("annotations agree with the enforced risk class", () => {
  for (const tool of tools as any[]) {
    let kind: string;
    try { kind = (actionFromTool(tool.name, sampleArgs(tool)) as any).kind; } catch { continue; }
    let risk: string;
    try { risk = actionRisk(kind as any); } catch { continue; }
    const a = toolAnnotations(tool.name);
    // Every human-approval (high) tool is marked destructive; nothing marked
    // read-only may be more than low risk.
    if (risk === "high") assert.equal(a.destructiveHint, true, `${tool.name} is high risk but not destructive`);
    if (a.readOnlyHint) assert.equal(risk, "low", `${tool.name} is read-only but ${risk} risk`);
    if (risk === "low") assert.notEqual(annotationKind(tool.name), "destructive", `${tool.name} is low risk but destructive`);
  }
});

test("the server-changing tools that need approval are destructive; reads are read-only", () => {
  for (const name of ["process_exec", "process_kill", "fs_delete", "terminal_input", "terminal_start", "server_cleanup_run", "server_process_signal", "server_restart_owner"])
    assert.deepEqual([toolAnnotations(name).readOnlyHint, toolAnnotations(name).destructiveHint], [false, true], name);
  for (const name of ["devices_list", "server_overview", "server_cleanup_scan", "server_processes", "fs_read", "log_query", "health_snapshot"])
    assert.deepEqual([toolAnnotations(name).readOnlyHint, toolAnnotations(name).destructiveHint], [true, false], name);
  assert.equal(toolAnnotations("url_fetch").openWorldHint, true);
  assert.equal(toolAnnotations("fs_read").openWorldHint, false);
});

test("Desktop Commander names are annotated like the tool they run", () => {
  for (const alias of DC_TOOLS as any[]) {
    const target = translateAlias(alias.name, { device_id: "d", ...sampleArgs(alias) });
    if (!target) continue;
    assert.equal(annotationKind(alias.name), annotationKind(target.name), `${alias.name} -> ${target.name}`);
  }
});

test("an unknown tool is refused, so a new tool must be classified", () => {
  assert.throws(() => toolAnnotations("brand_new_tool"), /no annotations/);
});

test("local stdio tools carry the same annotations", () => {
  for (const tool of localTools() as any[]) assert.deepEqual(tool.annotations, toolAnnotations(tool.name), tool.name);
});
