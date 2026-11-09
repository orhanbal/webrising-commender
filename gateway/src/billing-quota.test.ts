import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
const { monthlyToolCallLimit, FREE_TOOL_CALLS_DEFAULT } = await import("./billing.js");

test("monthly tool-call quota: free is limited, paid and operator workspaces are not", () => {
  assert.equal(monthlyToolCallLimit({ mode: "self_hosted", entitled: true, plan: { key: "free" } }), null);
  assert.equal(monthlyToolCallLimit({ mode: "saas", entitled: true, plan: { key: "internal" } }), null);
  assert.equal(monthlyToolCallLimit({ mode: "saas", entitled: true, plan: { key: "free", metadata: {} } }), FREE_TOOL_CALLS_DEFAULT);
  assert.equal(monthlyToolCallLimit({ mode: "saas", entitled: true, plan: { key: "free", metadata: { monthlyToolCalls: 1200 } } }), 1200);
  assert.equal(monthlyToolCallLimit({ mode: "saas", entitled: true, plan: { key: "pro", metadata: {} } }), null);
  assert.equal(monthlyToolCallLimit({ mode: "saas", entitled: false, plan: null }), 0);
});
