// REST routes of WECOMMANDER scheduled tasks (docs/SCHEDULED_TASKS.md).
// Workspace scoped; owner/admin change and run, every role reads. SSH targets
// are created and changed from the desktop app (it holds the SSH host and its
// credentials); the web panel shows them and may toggle, run or delete them.

import { roleAtLeast, type Principal } from "./auth.js";
import { previewRuns, ScheduleError, validateSchedule } from "./cron.js";
import type { ScheduledTaskRunner } from "./scheduled-task-runner.js";
import {
  centerResultSchema, createTaskSchema, initialNextRun, patchTaskSchema, previewSchema, processOutput, toApiRun,
  toApiTask, validationError, type ScheduledTaskStore, type TaskRow,
} from "./scheduled-tasks.js";
import { redactSecrets } from "./security.js";

export type ScheduledTasksContext = {
  store: ScheduledTaskStore;
  runner: ScheduledTaskRunner;
  /** The plan's limit on tasks; 0 with `entitled: false` means a plan is needed. */
  taskLimit: (organizationId: string) => Promise<{ limit: number; entitled: boolean }>;
  /** Audit entry as the caller (records the Management Center when it is one). */
  audit: (principal: Principal, deviceId: string | null, tool: string, risk: string, outcome: string, detail: string) => Promise<void>;
  /** Fixed-window limiter: true when allowed. */
  allow: (key: string, limit: number, windowMs: number) => boolean;
  now?: () => Date;
};

type Reply = { status: number; body: unknown };
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const taskPath = new RegExp(`^/api/scheduled-tasks/(${UUID})$`, "i");
const runPath = new RegExp(`^/api/scheduled-tasks/(${UUID})/run$`, "i");
const runsPath = new RegExp(`^/api/scheduled-tasks/(${UUID})/runs$`, "i");
const resultPath = new RegExp(`^/api/center/scheduled-runs/(${UUID})/result$`, "i");

/** Routes a Management Center token may reach (see center-link.ts). */
export function centerMayUseScheduledTasks(method: string, pathname: string) {
  if (pathname === "/api/scheduled-tasks") return method === "GET" || method === "POST";
  if (pathname === "/api/scheduled-tasks/preview") return method === "POST";
  if (taskPath.test(pathname)) return method === "PATCH" || method === "DELETE";
  if (runPath.test(pathname)) return method === "POST";
  if (runsPath.test(pathname)) return method === "GET";
  if (pathname === "/api/center/scheduled-runs/claim") return method === "GET";
  if (resultPath.test(pathname)) return method === "POST";
  return false;
}

const forbidden = (role: string): Reply => ({ status: 403, body: { error: "forbidden", requiredRole: role } });
const bad = (error: unknown): Reply => ({ status: 400, body: validationError(error) });
const notFound: Reply = { status: 404, body: { error: "not_found", message: "scheduled task not found" } };

function auditCommand(command: string) {
  return redactSecrets(command).slice(0, 1000);
}

/** null when the route is not a scheduled-task route. */
export async function handleScheduledTasks(
  method: string,
  url: URL,
  principal: Principal,
  readBody: () => Promise<unknown>,
  ctx: ScheduledTasksContext,
): Promise<Reply | null> {
  const path = url.pathname;
  if (!path.startsWith("/api/scheduled-tasks") && !path.startsWith("/api/center/scheduled-runs")) return null;
  const now = ctx.now ?? (() => new Date());
  const org = principal.organizationId;

  if (method === "GET" && path === "/api/scheduled-tasks") {
    if (!roleAtLeast(principal, "viewer")) return forbidden("viewer");
    const items = await ctx.store.list(org);
    return { status: 200, body: { items: items.map(({ task, lastRun }) => toApiTask(task, lastRun)) } };
  }

  if (method === "POST" && path === "/api/scheduled-tasks/preview") {
    if (!roleAtLeast(principal, "viewer")) return forbidden("viewer");
    if (!ctx.allow(`preview:${principal.actor}`, 120, 60_000)) return { status: 429, body: { error: "rate_limited" } };
    let input;
    try {
      input = previewSchema.parse(await readBody());
      validateSchedule(input.schedule, input.timezone);
    } catch (error) {
      return bad(error);
    }
    const next = previewRuns(input.schedule, input.timezone, now(), 5).map((d) => d.toISOString());
    return { status: 200, body: { next } };
  }

  if (method === "POST" && path === "/api/scheduled-tasks") {
    if (!roleAtLeast(principal, "admin")) return forbidden("admin");
    let input;
    try {
      input = createTaskSchema.parse(await readBody());
      validateSchedule(input.schedule, input.timezone);
      if (input.schedule.kind === "once" && new Date(input.schedule.at) <= now()) {
        throw new ScheduleError("the run time is in the past");
      }
    } catch (error) {
      return bad(error);
    }
    const targetError = await checkTarget(ctx, principal, input.target);
    if (targetError) return targetError;
    const [{ limit, entitled }, used] = await Promise.all([ctx.taskLimit(org), ctx.store.count(org)]);
    if (used >= limit) {
      return limit === 0 && !entitled
        ? { status: 402, body: { error: "billing_required", resource: "scheduled_task", used, limit } }
        : { status: 409, body: { error: "scheduled_task_limit", message: `this plan allows ${limit} scheduled tasks`, used, limit } };
    }
    const task = await ctx.store.create(org, input, principal.actor, initialNextRun(input.schedule, input.timezone, now()));
    await ctx.audit(principal, task.device_id, "scheduled_task.create", "high", "success", JSON.stringify({
      taskId: task.id, name: task.name, target: input.target, command: auditCommand(task.command),
      schedule: task.schedule, timezone: task.timezone, enabled: task.enabled,
    }));
    return { status: 201, body: { item: toApiTask(task) } };
  }

  const taskMatch = taskPath.exec(path);
  if (taskMatch && method === "PATCH") {
    if (!roleAtLeast(principal, "admin")) return forbidden("admin");
    const current = await ctx.store.get(org, taskMatch[1]!);
    if (!current) return notFound;
    let patch;
    try {
      patch = patchTaskSchema.parse(await readBody());
    } catch (error) {
      return bad(error);
    }
    const sshInvolved = current.target_kind === "ssh" || patch.target?.kind === "ssh";
    const commandChanged = patch.command !== undefined && patch.command !== current.command;
    if (sshInvolved && (patch.target !== undefined || commandChanged) && principal.authKind !== "center") {
      return { status: 403, body: { error: "ssh_task_app_only", message: "SSH targets and their commands are changed in the desktop app" } };
    }
    if (patch.target) {
      const targetError = await checkTarget(ctx, principal, patch.target);
      if (targetError) return targetError;
    }
    const next: TaskRow = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.command !== undefined ? { command: patch.command } : {}),
      ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.timeoutSec !== undefined ? { timeout_sec: patch.timeoutSec } : {}),
      ...(patch.notify !== undefined ? { notify: patch.notify } : {}),
      ...(patch.target ? patch.target.kind === "device"
        ? { target_kind: "device" as const, device_id: patch.target.deviceId, center_id: null, host_id: null, host_label: null }
        : { target_kind: "ssh" as const, device_id: null, center_id: patch.target.centerId, host_id: patch.target.hostId,
          host_label: patch.target.hostLabel }
        : {}),
    };
    const rescheduled = patch.schedule !== undefined || patch.timezone !== undefined ||
      (next.enabled && (!current.enabled || current.next_run_at === null));
    try {
      if (rescheduled) {
        validateSchedule(next.schedule, next.timezone);
        if (next.enabled && next.schedule.kind === "once" && new Date(next.schedule.at) <= now()) {
          throw new ScheduleError("the run time is in the past");
        }
      }
    } catch (error) {
      return bad(error);
    }
    if (!next.enabled) next.next_run_at = null;
    else if (rescheduled) next.next_run_at = initialNextRun(next.schedule, next.timezone, now());
    const saved = await ctx.store.update(next);
    const changed = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
    await ctx.audit(principal, saved.device_id, "scheduled_task.update", "high", "success", JSON.stringify({
      taskId: saved.id, name: saved.name, changed,
      ...(commandChanged ? { command: auditCommand(saved.command), previousCommand: auditCommand(current.command) } : {}),
      ...(patch.target ? { target: patch.target } : {}),
      ...(patch.enabled !== undefined ? { enabled: saved.enabled } : {}),
    }));
    return { status: 200, body: { item: toApiTask(saved, await ctx.store.lastRun(saved.id)) } };
  }

  if (taskMatch && method === "DELETE") {
    if (!roleAtLeast(principal, "admin")) return forbidden("admin");
    const current = await ctx.store.get(org, taskMatch[1]!);
    if (!current || !(await ctx.store.remove(org, current.id))) return notFound;
    await ctx.audit(principal, current.device_id, "scheduled_task.delete", "high", "success", JSON.stringify({
      taskId: current.id, name: current.name, command: auditCommand(current.command),
    }));
    return { status: 200, body: { ok: true } };
  }

  const runMatch = runPath.exec(path);
  if (runMatch && method === "POST") {
    if (!roleAtLeast(principal, "admin")) return forbidden("admin");
    const task = await ctx.store.get(org, runMatch[1]!);
    if (!task) return notFound;
    if (!ctx.allow(`run:${task.id}`, 10, 60_000)) return { status: 429, body: { error: "rate_limited" } };
    const run = await ctx.runner.runNow(task);
    await ctx.audit(principal, task.device_id, "scheduled_task.run_now", "high", "success", JSON.stringify({
      taskId: task.id, runId: run.id, name: task.name, command: auditCommand(task.command),
    }));
    return { status: 200, body: { run: toApiRun(run) } };
  }

  const runsMatch = runsPath.exec(path);
  if (runsMatch && method === "GET") {
    if (!roleAtLeast(principal, "viewer")) return forbidden("viewer");
    const task = await ctx.store.get(org, runsMatch[1]!);
    if (!task) return notFound;
    const raw = Number(url.searchParams.get("limit") || 50);
    const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.floor(raw))) : 50;
    const runs = await ctx.store.runs(org, task.id, limit);
    return { status: 200, body: { items: runs.map((r) => toApiRun(r)) } };
  }

  if (method === "GET" && path === "/api/center/scheduled-runs/claim") {
    if (principal.authKind !== "center" || !principal.centerId) return { status: 403, body: { error: "center_token_required" } };
    if (!roleAtLeast(principal, "admin")) return forbidden("admin");
    const runs = await ctx.store.claimForCenter(org, principal.centerId);
    const items = [];
    for (const run of runs) {
      const task = await ctx.store.taskById(run.task_id);
      if (!task) continue;
      // The command that was due (a later edit applies to later runs).
      items.push({ run: toApiRun(run), task: { ...toApiTask(task), command: run.command } });
    }
    return { status: 200, body: { items } };
  }

  const resultMatch = resultPath.exec(path);
  if (resultMatch && method === "POST") {
    if (principal.authKind !== "center" || !principal.centerId) return { status: 403, body: { error: "center_token_required" } };
    if (!roleAtLeast(principal, "admin")) return forbidden("admin");
    let input;
    try {
      input = centerResultSchema.parse(await readBody());
    } catch (error) {
      return bad(error);
    }
    const run = await ctx.store.finishCenterRun(org, principal.centerId, resultMatch[1]!, {
      status: input.status,
      exitCode: input.exitCode ?? null,
      output: input.output !== undefined ? processOutput(input.output) : null,
      error: input.error ? redactSecrets(input.error) : null,
    });
    if (!run) return { status: 404, body: { error: "run_not_found", message: "no running run with this id for this app" } };
    const task = await ctx.store.taskById(run.task_id);
    if (task) await ctx.runner.finish(task, run);
    return { status: 200, body: { ok: true } };
  }

  return { status: 404, body: { error: "not_found" } };
}

async function checkTarget(ctx: ScheduledTasksContext, principal: Principal,
  target: { kind: "device"; deviceId: string } | { kind: "ssh"; centerId: string }): Promise<Reply | null> {
  if (target.kind === "device") {
    if (!(await ctx.store.deviceInWorkspace(principal.organizationId, target.deviceId))) {
      return { status: 400, body: { error: "unknown_device", message: "the device is not in this workspace" } };
    }
    return null;
  }
  if (principal.authKind !== "center") {
    return { status: 403, body: { error: "ssh_task_app_only", message: "SSH targets are added from the desktop app" } };
  }
  if (!(await ctx.store.centerInWorkspace(principal.organizationId, target.centerId))) {
    return { status: 400, body: { error: "unknown_center", message: "the app is not connected to this workspace" } };
  }
  return null;
}
