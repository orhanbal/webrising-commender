// The scheduler loop of WECOMMANDER scheduled tasks. Every 30 s each gateway
// instance claims due tasks (FOR UPDATE SKIP LOCKED, see ScheduledTaskStore),
// dispatches device runs to the target's agent as a background task
// (task_start + task_status: the same command execution as process_exec, but
// not bound to one relay request's timeout), queues SSH runs for the owner's
// desktop app, and records every outcome on the run. Nothing here may throw
// into the gateway: every error ends up on the run or in the log.

import crypto from "node:crypto";
import { nextRun } from "./cron.js";
import type { AgentAction, UndoScope } from "./protocol.js";
import {
  combineOutput, processOutput, shouldNotify, type RunRow, type RunStatus, type ScheduledTaskStore, type TaskRow,
} from "./scheduled-tasks.js";

export type DeviceGateway = {
  isOnline(deviceId: string): Promise<boolean>;
  request(
    deviceId: string, action: AgentAction, approvalToken?: string | null, signal?: AbortSignal,
    onProgress?: undefined, searchSessionId?: string, startPaused?: boolean, undoScope?: UndoScope,
  ): Promise<unknown>;
};

type Store = Pick<ScheduledTaskStore,
  "claimDue" | "claimStaleAgentRuns" | "updateRun" | "deleteRun" | "expireCenterRuns" | "previousRun" |
  "insertManualRun" | "audit" | "taskById">;

export type RunnerDeps = {
  store: Store;
  devices: DeviceGateway;
  /** The device approval for one exact action: the owner's task is the approval. */
  issueToken: (deviceId: string, action: AgentAction) => string;
  notify: (task: TaskRow, run: RunRow) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Delays between task_status polls; the last one repeats. */
  pollDelaysMs?: number[];
  instanceId?: string;
};

const LEASE_MS = 120_000;
/** Extra time past the task timeout before the gateway gives up on the agent. */
const RESULT_GRACE_MS = 120_000;

export const scheduledTaskActor = (taskId: string) => `scheduled-task:${taskId}`;

export class ScheduledTaskRunner {
  readonly instanceId: string;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollDelays: number[];
  private ticking = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: RunnerDeps) {
    this.instanceId = deps.instanceId ?? `gw:${crypto.randomUUID()}`;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((message) => process.stderr.write(`scheduled tasks: ${message}\n`));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
    this.pollDelays = deps.pollDelaysMs?.length ? deps.pollDelaysMs : [2_000, 3_000, 5_000, 10_000];
  }

  start(intervalMs = 30_000) {
    this.stopped = false;
    const run = () => void this.tick().catch((error) => this.log(`tick failed: ${message(error)}`));
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
    setTimeout(run, Math.min(5_000, intervalMs)).unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Waits for the device runs started by this instance (tests, shutdown). */
  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /** One scheduler pass. Safe to call concurrently from several gateway instances. */
  async tick() {
    if (this.ticking) return { claimed: 0, recovered: 0, expired: 0 };
    this.ticking = true;
    let claimed = 0;
    let recovered = 0;
    let expired = 0;
    try {
      try {
        expired = await this.expireCenterRuns();
      } catch (error) {
        this.log(`expiring app runs failed: ${message(error)}`);
      }
      try {
        const stale = await this.deps.store.claimStaleAgentRuns(this.now(), this.instanceId);
        for (const run of stale) {
          recovered++;
          this.background(this.recover(run));
        }
      } catch (error) {
        this.log(`recovering runs failed: ${message(error)}`);
      }
      try {
        const due = await this.deps.store.claimDue(this.now(), this.instanceId, (task, scheduledFor) =>
          this.nextAfterClaim(task, scheduledFor));
        for (const { task, run, previous } of due) {
          if (!run) continue;
          claimed++;
          if (run.status === "skipped") {
            this.background(this.finish(task, run));
          } else if (run.runner === "agent") {
            this.background(this.executeDevice(task, run, previous));
          } else {
            this.background(this.audit(task, run, "queued"));
          }
        }
      } catch (error) {
        this.log(`claiming due tasks failed: ${message(error)}`);
      }
    } finally {
      this.ticking = false;
    }
    return { claimed, recovered, expired };
  }

  /** Next run after a claim: never before now (no catch-up storm), intervals stay on their grid. */
  nextAfterClaim(task: TaskRow, scheduledFor: Date) {
    const now = this.now();
    const after = now > scheduledFor ? now : scheduledFor;
    return nextRun(task.schedule, task.timezone, after, scheduledFor);
  }

  /** Run now (trigger=manual). Returns the queued run; device runs continue in the background. */
  async runNow(task: TaskRow) {
    const run = await this.deps.store.insertManualRun(task, this.instanceId);
    if (run.runner === "agent") this.background(this.executeDevice(task, run, null));
    return run;
  }

  private background(work: Promise<void>) {
    const tracked = work.catch((error) => this.log(`run failed unexpectedly: ${message(error)}`))
      .finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  private async expireCenterRuns() {
    const runs = await this.deps.store.expireCenterRuns(this.now());
    for (const run of runs) {
      try {
        const task = await this.deps.store.taskById(run.task_id);
        if (!task) continue;
        if (run.status === "missed" && run.trigger === "schedule") {
          const previous = await this.deps.store.previousRun(run);
          if (previous?.status === "missed" && previous.error === "not_claimed_by_app") {
            // Same outage of the app: keep one missed run, not one per due time.
            await this.deps.store.deleteRun(run.id, true);
            continue;
          }
        }
        await this.finish(task, run);
      } catch (error) {
        this.log(`expiring run ${run.id} failed: ${message(error)}`);
      }
    }
    return runs.length;
  }

  private async recover(run: RunRow) {
    const task = await this.deps.store.taskById(run.task_id);
    if (!task || task.target_kind !== "device" || !task.device_id) {
      await this.closeRun(task, run, { status: "failed", error: "task_removed" });
      return;
    }
    if (run.status === "queued") {
      // Never dispatched (the instance stopped first). Too late is missed.
      if (this.now().getTime() - new Date(run.scheduled_for).getTime() > 15 * 60_000) {
        await this.closeRun(task, run, { status: "missed", error: "gateway_restarted" });
        return;
      }
      await this.executeDevice(task, run, null);
      return;
    }
    if (!run.agent_task_id) {
      await this.closeRun(task, run, { status: "failed", error: "interrupted_before_start_was_confirmed" });
      return;
    }
    await this.poll(task, run);
  }

  async executeDevice(task: TaskRow, run: RunRow, previous: RunRow | null) {
    const deviceId = task.device_id;
    try {
      if (task.target_kind !== "device" || !deviceId) throw new Error("not_a_device_task");
      if (!(await this.deps.devices.isOnline(deviceId))) {
        if (run.trigger === "schedule" && previous?.status === "missed" && previous.error === "device_offline") {
          // Still the same outage: one missed run per outage, not one per due time.
          await this.deps.store.deleteRun(run.id);
          return;
        }
        await this.closeRun(task, run, {
          status: run.trigger === "manual" ? "failed" : "missed", error: "device_offline",
        });
        return;
      }
      const action: AgentAction = { kind: "task_start", command: run.command, timeoutMs: task.timeout_sec * 1000 };
      const token = this.deps.issueToken(deviceId, action);
      const started = await this.deps.devices.request(deviceId, action, token, undefined, undefined, undefined,
        undefined, this.scope(task)) as { taskId?: unknown } | null;
      const agentTaskId = typeof started?.taskId === "string" ? started.taskId : null;
      if (!agentTaskId) throw new Error("agent_did_not_start_the_task");
      const now = this.now();
      const running = await this.deps.store.updateRun(run.id, {
        status: "running", startedAt: now, agentTaskId, leaseUntil: new Date(now.getTime() + LEASE_MS),
      }, this.instanceId);
      if (!running) return; // taken over or closed elsewhere
      await this.audit(task, running, "started");
      await this.poll(task, running);
    } catch (error) {
      await this.closeRun(task, run, { status: "failed", error: agentError(error) });
    }
  }

  private async poll(task: TaskRow, run: RunRow) {
    const deviceId = task.device_id!;
    const startedAt = new Date(run.started_at ?? run.scheduled_for).getTime();
    const deadline = startedAt + task.timeout_sec * 1000 + RESULT_GRACE_MS;
    for (let attempt = 0; ; attempt++) {
      await this.sleep(this.pollDelays[Math.min(attempt, this.pollDelays.length - 1)]!);
      if (this.stopped) return; // the lease runs out and another instance resumes
      const now = this.now();
      let status: AgentTaskStatus | null = null;
      try {
        status = await this.deps.devices.request(deviceId, { kind: "task_status", taskId: run.agent_task_id! },
          undefined, undefined, undefined, undefined, undefined, this.scope(task)) as AgentTaskStatus;
      } catch (error) {
        const text = message(error);
        if (/task not found/i.test(text)) {
          await this.closeRun(task, run, { status: "failed", error: "the device restarted during the run; its result is lost" });
          return;
        }
        // Offline or a relay hiccup: the agent keeps running the task; ask again.
      }
      if (status && status.status !== "running") {
        await this.complete(task, run, status);
        return;
      }
      if (now.getTime() > deadline) {
        await this.cancelOnDevice(task, run);
        await this.closeRun(task, run, { status: "failed", error: "timeout: no result from the device" });
        return;
      }
      const renewed = await this.deps.store.updateRun(run.id, { leaseUntil: new Date(now.getTime() + LEASE_MS) },
        this.instanceId);
      if (!renewed) return; // another instance owns it now, or it was closed
    }
  }

  private async complete(task: TaskRow, run: RunRow, status: AgentTaskStatus) {
    const result = status.result ?? null;
    const exitCode = typeof result?.exitCode === "number" ? result.exitCode : null;
    const output = processOutput(combineOutput(result));
    if (status.status === "completed") {
      const ok = exitCode === 0 || (exitCode === null && result?.success === true);
      await this.closeRun(task, run, {
        status: ok ? "succeeded" : "failed", exitCode, output,
        error: ok ? null : exitCode === null ? "terminated by a signal" : null,
      });
    } else if (status.status === "canceled") {
      await this.closeRun(task, run, { status: "cancelled", exitCode, output: output || null, error: "cancelled on the device" });
    } else {
      await this.closeRun(task, run, { status: "failed", exitCode, output: output || null,
        error: typeof status.error === "string" && status.error ? status.error : "the command failed on the device" });
    }
  }

  private async cancelOnDevice(task: TaskRow, run: RunRow) {
    try {
      const action: AgentAction = { kind: "task_cancel", taskId: run.agent_task_id! };
      await this.deps.devices.request(task.device_id!, action, this.deps.issueToken(task.device_id!, action),
        undefined, undefined, undefined, undefined, this.scope(task));
    } catch {
      // Best effort: the agent enforces the task timeout itself.
    }
  }

  private async closeRun(task: TaskRow | null, run: RunRow, patch: {
    status: RunStatus; error?: string | null; exitCode?: number | null; output?: string | null;
  }) {
    try {
      const closed = await this.deps.store.updateRun(run.id, {
        status: patch.status, finishedAt: this.now(), error: patch.error ?? null,
        ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
        ...(patch.output !== undefined ? { output: patch.output } : {}),
        leaseUntil: null,
      });
      if (closed && task) await this.finish(task, closed);
    } catch (error) {
      this.log(`closing run ${run.id} failed: ${message(error)}`);
    }
  }

  /** Audit log entry and owner notification for a finished run. Never throws. */
  async finish(task: TaskRow, run: RunRow) {
    await this.audit(task, run, run.status);
    if (shouldNotify(task.notify, run.status)) {
      try {
        await this.deps.notify(task, run);
      } catch (error) {
        this.log(`notification for run ${run.id} failed: ${message(error)}`);
      }
    }
  }

  private async audit(task: TaskRow, run: RunRow, outcome: string) {
    try {
      await this.deps.store.audit(task.organization_id, scheduledTaskActor(task.id),
        task.target_kind === "device" ? task.device_id : null, "scheduled_task.run", "high", outcome, {
          taskId: task.id, runId: run.id, trigger: run.trigger, runner: run.runner,
          origin: scheduledTaskActor(task.id), approvedBy: task.created_by,
          ...(run.exit_code !== null && run.exit_code !== undefined ? { exitCode: run.exit_code } : {}),
          ...(run.error ? { error: run.error.slice(0, 300) } : {}),
          ...(task.target_kind === "ssh" ? { host: task.host_label } : {}),
        });
    } catch (error) {
      this.log(`audit for run ${run.id} failed: ${message(error)}`);
    }
  }

  private scope(task: TaskRow): UndoScope {
    return { organizationId: task.organization_id, actor: scheduledTaskActor(task.id) };
  }
}

type AgentTaskStatus = {
  status?: string;
  result?: { exitCode?: unknown; success?: unknown; stdout?: unknown; stderr?: unknown } | null;
  error?: unknown;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** The agent's refusal or the relay error, readable on the run. */
function agentError(error: unknown) {
  const text = message(error);
  if (text === "device-offline") return "device_offline";
  if (text === "device-request-timeout") return "the device did not answer in time";
  return text.slice(0, 2000) || "request_failed";
}
