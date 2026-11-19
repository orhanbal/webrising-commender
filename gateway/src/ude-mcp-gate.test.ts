import test from "node:test";
import assert from "node:assert/strict";

// Separate Node test-file process: opt in before loading the MCP registry.
process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
process.env.CONTROL_API_KEY ??= "test-control-key-0123456789-0123456789";
process.env.APPROVAL_SIGNING_SECRET ??= "test-approval-secret-0123456789-012345";
process.env.WECOMMANDER_UDE_ENABLED = "true";

const { tools, listedTools } = await import("./mcp.js");
const { DC_TOOLS } = await import("./dc-compat.js");

test("UDE MCP is opt-in, gateway-only and read-only", () => {
  const defaultCoreToolNames = new Set(tools.map(t => t.name));
  assert.ok(!defaultCoreToolNames.has("ude_capabilities"), "UDE cannot become a Core or local-Agent tool");

  const all = listedTools();
  const ude = all.find(t => t.name === "ude_capabilities") as (typeof all[number] & { inputSchema: { required: string[]; additionalProperties: boolean } }) | undefined;
  assert.equal(all.length, tools.length + DC_TOOLS.length + 1);
  assert.ok(ude, "literal opt-in must publish the UDE tool");
  assert.deepEqual(ude?.inputSchema.required, ["device_id"]);
  assert.equal(ude?.inputSchema.additionalProperties, false);
  assert.equal(ude?.annotations.readOnlyHint, true);
  assert.equal(ude?.annotations.destructiveHint, false);
  assert.equal(ude?.annotations.openWorldHint, false);
});
