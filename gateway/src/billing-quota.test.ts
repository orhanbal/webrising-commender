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

test("scheduled task limit: per plan, never above the hard cap", async () => {
  const { scheduledTaskLimit, MAX_SCHEDULED_TASKS, FREE_SCHEDULED_TASKS_DEFAULT } = await import("./billing.js");
  assert.equal(scheduledTaskLimit({ mode: "self_hosted", entitled: true, plan: null }), MAX_SCHEDULED_TASKS);
  assert.equal(scheduledTaskLimit({ mode: "saas", entitled: true, plan: { key: "free", metadata: {} } }), FREE_SCHEDULED_TASKS_DEFAULT);
  assert.equal(scheduledTaskLimit({ mode: "saas", entitled: true, plan: { key: "free", metadata: { maxScheduledTasks: 3 } } }), 3);
  assert.equal(scheduledTaskLimit({ mode: "saas", entitled: true, plan: { key: "pro", metadata: { maxScheduledTasks: 5000 } } }), MAX_SCHEDULED_TASKS);
  assert.equal(scheduledTaskLimit({ mode: "saas", entitled: true, plan: { key: "pro", metadata: {} } }), MAX_SCHEDULED_TASKS);
  assert.equal(scheduledTaskLimit({ mode: "saas", entitled: false, plan: null }), 0);
});
