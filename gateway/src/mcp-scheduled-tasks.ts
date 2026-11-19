// WECOMMANDER scheduled tasks over MCP (docs/SCHEDULED_TASKS.md). The tools
// run the REST routes of scheduled-tasks-api.ts, so roles, workspace checks,
// validation (cron, command limits, targets) and plan limits are the API's
// own. Every change needs a human approval of that exact change unless the
// target device's trust is full (the owner's "no per-call approval" choice):
// a dry run checks it first, so only a change that would succeed is put to a
// human; the approved retry then makes it. The device's safety net applies to
// the task's command either way. SSH tasks always need an approval.

import { roleAtLeast, type Principal } from "./auth.js";
import type { WorkspaceAction } from "./approval-requests.js";
import { handleScheduledTasks, type DryRun, type ScheduledTasksContext } from "./scheduled-tasks-api.js";
import type { ApiRun, ApiTask } from "./scheduled-tasks.js";
import { redactSecrets } from "./security.js";

const oauth = () => (process.env.MCP_OAUTH_ENABLED === "true" ? { securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }] } : {});

const APPROVAL_HELP = "HIGH risk: the first call returns approval_required with approval_request_id; " +
  "an admin or owner approves this exact change, then retry the same call. On a device whose trust is full it runs without approval.";

const SCHEDULE = {
  type: "object",
  description: "{kind:\"cron\",expr:\"0 3 * * *\"} (5 fields), {kind:\"interval\",minutes:5-10080} or {kind:\"once\",at:ISO 8601 time with offset}.",
  properties: {
    kind: { type: "string", enum: ["cron", "interval", "once"] },
    expr: { type: "string", maxLength: 200 },
    minutes: { type: "integer", minimum: 5, maximum: 10080 },
    at: { type: "string" },
  },
  required: ["kind"],
  additionalProperties: false,
};

const FIELDS = {
  name: { type: "string", minLength: 1, maxLength: 80 },
  description: { type: "string", maxLength: 500 },
  command: { type: "string", minLength: 1, maxLength: 4000, description: "Shell command run on the device by its agent." },
  schedule: SCHEDULE,
  timezone: { type: "string", description: "IANA time zone (default Europe/Istanbul)." },
  enabled: { type: "boolean" },
  timeout_sec: { type: "integer", minimum: 10, maximum: 3600, description: "Run time limit (default 600)." },
  notify: { type: "string", enum: ["failure", "always", "never"], description: "E-mail the owner (default failure)." },
};
const TASK_ID = { type: "string", description: "Task id from scheduled_tasks_list." };

function def(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, ...oauth() };
}

export const SCHEDULED_TASK_TOOLS = [
  def("scheduled_tasks_list", "List this workspace's WECOMMANDER scheduled tasks: id, name, target device, command (secrets masked), schedule, time zone, enabled, next run and the last run's status, exit code and error. Read-only.", {}),
  def("scheduled_task_create", `Create a WECOMMANDER scheduled task that runs a command on an agent device on a cron, interval or one-time schedule. ${APPROVAL_HELP}`,
    { device_id: { type: "string", description: "Agent device the command runs on." }, ...FIELDS },
    ["device_id", "name", "command", "schedule"]),
  def("scheduled_task_update", `Change a scheduled task: only the fields given change; device_id moves it to another agent device. SSH tasks' command and target are changed in the desktop app. ${APPROVAL_HELP}`,
    { task_id: TASK_ID, device_id: { type: "string", description: "Move the task to this agent device." }, ...FIELDS },
    ["task_id"]),
  def("scheduled_task_delete", `Delete a scheduled task and its run history. ${APPROVAL_HELP}`, { task_id: TASK_ID }, ["task_id"]),
  def("scheduled_task_run_now", `Run a scheduled task once now, outside its schedule; returns the queued run. ${APPROVAL_HELP}`, { task_id: TASK_ID }, ["task_id"]),
];
export const SCHEDULED_TASK_TOOL_NAMES: ReadonlySet<string> = new Set(SCHEDULED_TASK_TOOLS.map((t) => t.name));

/** The human-approval flow of mcp.ts (approval-requests.ts), injected for tests. */
export type ScheduledTaskApprovals = {
  consume: (orgId: string, actor: string, deviceId: string | null, action: WorkspaceAction) => Promise<string | null>;
  ensure: (orgId: string, actor: string, deviceId: string | null, action: WorkspaceAction, label: string) =>
    Promise<{ id: string; expires_at: Date; created: boolean }>;
  restore: (orgId: string, requestId: string, action: WorkspaceAction) => Promise<boolean>;
  notify: (orgId: string, deviceId: string | null, action: WorkspaceAction, requestId: string, expiresAt: Date, label: string) =>
    Promise<unknown>;
  /** The target device's policy for this change: "auto" (full trust: no
   *  approval), "approve" (ask a human), or a refusal (safety net). Omitted
   *  means always "approve". */
  policy?: (orgId: string, deviceId: string, command: string) =>
    Promise<"auto" | "approve" | { refused: string; rule: string }>;
};
export type McpAudit = (deviceId: string | null, tool: string, risk: string, outcome: string, detail: string) => Promise<void>;
export type ToolOutcome = { data: unknown; isError: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (data: unknown): ToolOutcome => ({ data, isError: true });

function runView(run: ApiRun | undefined) {
  if (!run) return null;
  return {
    id: run.id, status: run.status, trigger: run.trigger, scheduled_for: run.scheduledFor,
    started_at: run.startedAt ?? null, finished_at: run.finishedAt ?? null,
    exit_code: run.exitCode ?? null, error: run.error ?? null,
  };
}

/** A task as the AI sees it: snake_case, the command with its secrets masked. */
export function taskView(task: ApiTask) {
  return {
    id: task.id,
    name: task.name,
    ...(task.description ? { description: task.description } : {}),
    target: task.target.kind === "device"
      ? { kind: "device", device_id: task.target.deviceId, ...(task.targetLabel ? { device_name: task.targetLabel } : {}) }
      : { kind: "ssh", host_label: task.target.hostLabel },
    command: redactSecrets(task.command),
    schedule: task.schedule,
    timezone: task.timezone,
    enabled: task.enabled,
    timeout_sec: task.timeoutSec,
    notify: task.notify,
    next_run_at: task.nextRunAt,
    last_run: runView(task.lastRun),
  };
}

/** MCP arguments (snake_case) to the API's request body. */
function body(args: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of ["name", "description", "command", "schedule", "timezone", "enabled", "notify"]) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  if (args.timeout_sec !== undefined) out.timeoutSec = args.timeout_sec;
  if (args.device_id !== undefined) out.target = { kind: "device", deviceId: args.device_id };
  return out;
}

type Route = { method: string; path: string; op: "create" | "update" | "delete" | "run_now"; taskId?: string };

function route(name: string, args: Record<string, unknown>): Route | { error: string } {
  if (name === "scheduled_task_create") return { method: "POST", path: "/api/scheduled-tasks", op: "create" };
  const taskId = String(args.task_id ?? "");
  if (!UUID.test(taskId)) return { error: "invalid_task_id" };
  if (name === "scheduled_task_update") return { method: "PATCH", path: `/api/scheduled-tasks/${taskId}`, op: "update", taskId };
  if (name === "scheduled_task_delete") return { method: "DELETE", path: `/api/scheduled-tasks/${taskId}`, op: "delete", taskId };
  return { method: "POST", path: `/api/scheduled-tasks/${taskId}/run`, op: "run_now", taskId };
}

const call = (r: { method: string; path: string }, principal: Principal, ctx: ScheduledTasksContext,
  payload: unknown, dryRun: boolean) =>
  handleScheduledTasks(r.method, new URL(r.path, "http://mcp.invalid"), principal, async () => payload, ctx, { dryRun });

export async function scheduledTaskTool(
  name: string,
  args: Record<string, unknown>,
  principal: Principal,
  ctx: ScheduledTasksContext,
  approvals: ScheduledTaskApprovals,
  audit: McpAudit,
): Promise<ToolOutcome> {
  const orgId = principal.organizationId;

  if (name === "scheduled_tasks_list") {
    const reply = await call({ method: "GET", path: "/api/scheduled-tasks" }, principal, ctx, undefined, false);
    if (!reply || reply.status !== 200) return fail(reply?.body ?? { error: "scheduled_tasks_unavailable" });
    const items = (reply.body as { items: ApiTask[] }).items.map(taskView);
    await audit(null, name, "low", "success", JSON.stringify({ count: items.length }));
    return { data: { items, count: items.length }, isError: false };
  }

  const r = route(name, args);
  if ("error" in r) return fail({ error: r.error, message: "task_id must be a task id from scheduled_tasks_list" });
  if (!roleAtLeast(principal, "admin")) {
    await audit(null, name, "high", "denied", "role_admin_required");
    return fail({ error: "forbidden", required_role: "admin" });
  }
  const payload = r.op === "create" || r.op === "update" ? body(args) : undefined;

  // The API's own checks, without changing anything.
  const dry = await call(r, principal, ctx, payload, true);
  if (!dry || dry.status !== 200) {
    await audit(null, name, "high", "error", JSON.stringify({ status: dry?.status, error: (dry?.body as any)?.error }));
    return fail(dry?.body ?? { error: "scheduled_tasks_unavailable" });
  }
  const checked = dry.body as DryRun;
  // Bound to the exact change and to what the task runs afterwards: a task
  // edited in between needs a new approval.
  const action: WorkspaceAction = {
    kind: `scheduled_task_${r.op}`,
    ...(r.taskId ? { taskId: r.taskId } : {}),
    name: checked.name,
    command: checked.command,
    ...(checked.change !== undefined ? { change: JSON.parse(JSON.stringify(checked.change)) } : {}),
  };
  const label = `Scheduled task: ${checked.name}`.slice(0, 200);

  const policy = checked.deviceId && approvals.policy
    ? await approvals.policy(orgId, checked.deviceId, checked.command)
    : "approve";
  if (typeof policy === "object") {
    await audit(checked.deviceId, name, "high", "denied", JSON.stringify({ reason: "safety_net", rule: policy.rule }));
    return fail({
      error: "safety_net_blocked",
      rule: policy.rule,
      message: `Refused by the target device's safety net: ${policy.refused}. An admin can switch the safety net off for that device in the WECOMMANDER web panel.`,
    });
  }
  if (policy === "auto") {
    await audit(checked.deviceId, name, "high", "trusted_full", JSON.stringify({ kind: action.kind }));
    const reply = await call(r, principal, ctx, payload, false);
    if (!reply || reply.status >= 300) return fail(reply?.body ?? { error: "scheduled_tasks_unavailable" });
    return done(r, reply.body as { item?: ApiTask; run?: ApiRun });
  }

  const approved = await approvals.consume(orgId, principal.actor, checked.deviceId, action);
  if (!approved) {
    const pending = await approvals.ensure(orgId, principal.actor, checked.deviceId, action, label);
    if (pending.created) {
      // Best effort: a mail failure must not change the MCP result.
      approvals.notify(orgId, checked.deviceId, action, pending.id, pending.expires_at, label).catch(() => undefined);
    }
    await audit(checked.deviceId, name, "high", "approval_pending", JSON.stringify({ approvalRequestId: pending.id }));
    return fail({
      error: "approval_required",
      action: action.kind,
      approval_request_id: pending.id,
      approval_expires_at: pending.expires_at,
      message: "An admin or owner must approve this exact change before retrying the same call.",
    });
  }
  await audit(checked.deviceId, name, "high", "approval_consumed", JSON.stringify({ approvalRequestId: approved }));

  const reply = await call(r, principal, ctx, payload, false);
  if (!reply || reply.status >= 300) {
    // Nothing changed: the approval is given back for a retry.
    await approvals.restore(orgId, approved, action);
    return fail({ ...(reply?.body as object ?? { error: "scheduled_tasks_unavailable" }), approval_request_id: approved });
  }
  return done(r, reply.body as { item?: ApiTask; run?: ApiRun });
}

function done(r: Route, result: { item?: ApiTask; run?: ApiRun }): ToolOutcome {
  if (r.op === "delete") return { data: { ok: true, deleted: r.taskId }, isError: false };
  if (r.op === "run_now") return { data: { ok: true, run: runView(result.run) }, isError: false };
  return { data: { ok: true, task: taskView(result.item!) }, isError: false };
}
