// WECOMMANDER scheduled tasks: the model, validation, storage and owner
// notifications. Contract: docs/SCHEDULED_TASKS.md. The scheduler loop that
// runs them lives in scheduled-task-runner.ts, the REST routes in
// scheduled-tasks-api.ts.

import { z } from "zod";
import { isValidTimeZone, nextRun, parseCron, ScheduleError, type Schedule } from "./cron.js";
import { scrubUserPaths } from "./scrub.js";
import { redactSecrets } from "./security.js";

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "missed", "skipped", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const FINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "missed", "skipped", "cancelled"]);
export const DEFAULT_TIMEZONE = "Europe/Istanbul";
export const OUTPUT_LIMIT_BYTES = 64 * 1024;
/** A queued SSH run the Center has not claimed in this time is recorded as missed. */
export const CENTER_CLAIM_WINDOW_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Validation

const cronExpr = z.string().trim().min(1).max(200).superRefine((value, ctx) => {
  try {
    parseCron(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid cron expression" });
  }
});

export const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expr: cronExpr }).strict(),
  z.object({ kind: z.literal("interval"), minutes: z.number().int().min(5).max(10_080) }).strict(),
  z.object({ kind: z.literal("once"), at: z.string().datetime({ offset: true }) }).strict(),
]);

export const timezoneSchema = z.string().refine(isValidTimeZone, "unknown IANA time zone");

export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device"), deviceId: z.string().uuid() }).strict(),
  z.object({
    kind: z.literal("ssh"),
    centerId: z.string().uuid(),
    hostId: z.string().trim().min(1).max(200),
    hostLabel: z.string().trim().min(1).max(200),
  }).strict(),
]);

const commandSchema = z.string().min(1).max(4000)
  .refine((v) => v.trim().length > 0, "command is empty")
  .refine((v) => !v.includes("\u0000"), "command contains a NUL character");

const taskFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  target: targetSchema,
  command: commandSchema,
  schedule: scheduleSchema,
  timezone: timezoneSchema,
  enabled: z.boolean(),
  timeoutSec: z.number().int().min(10).max(3600),
  notify: z.enum(["failure", "always", "never"]),
};

export const createTaskSchema = z.object({
  name: taskFields.name,
  description: taskFields.description.optional(),
  target: taskFields.target,
  command: taskFields.command,
  schedule: taskFields.schedule,
  timezone: taskFields.timezone.default(DEFAULT_TIMEZONE),
  enabled: taskFields.enabled.default(true),
  timeoutSec: taskFields.timeoutSec.default(600),
  notify: taskFields.notify.default("failure"),
});

export const patchTaskSchema = z.object({
  name: taskFields.name.optional(),
  description: taskFields.description.optional(),
  target: taskFields.target.optional(),
  command: taskFields.command.optional(),
  schedule: taskFields.schedule.optional(),
  timezone: taskFields.timezone.optional(),
  enabled: taskFields.enabled.optional(),
  timeoutSec: taskFields.timeoutSec.optional(),
  notify: taskFields.notify.optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), "nothing to change");

export const previewSchema = z.object({
  schedule: scheduleSchema,
  timezone: timezoneSchema.default(DEFAULT_TIMEZONE),
});

export const centerResultSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable().optional(),
  output: z.string().max(4 * 1024 * 1024).optional(),
  error: z.string().max(2000).optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type PatchTaskInput = z.infer<typeof patchTaskSchema>;
export type Target = z.infer<typeof targetSchema>;

/** A zod or schedule error as the contract's 400 body. */
export function validationError(error: unknown): { error: string; message: string } {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") + ": " : "";
    return { error: "invalid_request", message: (where + (issue?.message ?? "invalid request")).slice(0, 300) };
  }
  if (error instanceof ScheduleError) return { error: "invalid_schedule", message: error.message };
  return { error: "invalid_request", message: "invalid request" };
}

/** First run of a new or re-scheduled task (null: nothing more to run). */
export function initialNextRun(schedule: Schedule, timezone: string, now: Date): Date | null {
  // Interval tasks start one interval after they are saved.
  return nextRun(schedule, timezone, now, schedule.kind === "interval" ? now : undefined);
}

// ---------------------------------------------------------------------------
// Output

/** Masks secrets and user folder names, then keeps the last 64 KiB. */
export function processOutput(text: string, limit = OUTPUT_LIMIT_BYTES): string {
  const clean = scrubUserPaths(redactSecrets(text.replace(/\u0000/g, "")));
  const bytes = Buffer.from(clean, "utf8");
  if (bytes.length <= limit) return clean;
  const marker = `…[${bytes.length - limit} bytes truncated]\n`;
  const keep = limit - Buffer.byteLength(marker);
  // Drop a partial UTF-8 sequence at the cut.
  const tail = bytes.subarray(bytes.length - keep).toString("utf8").replace(/^�+/, "");
  return marker + tail;
}

/** stdout then stderr of an agent result, as one text. */
export function combineOutput(result: { stdout?: unknown; stderr?: unknown } | null | undefined) {
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr : "";
  if (!stderr) return stdout;
  return stdout + (stdout && !stdout.endsWith("\n") ? "\n" : "") + stderr;
}

// ---------------------------------------------------------------------------
// Rows and API shapes

export type TaskRow = {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  target_kind: "device" | "ssh";
  device_id: string | null;
  center_id: string | null;
  host_id: string | null;
  host_label: string | null;
  command: string;
  schedule: Schedule;
  timezone: string;
  enabled: boolean;
  timeout_sec: number;
  notify: "failure" | "always" | "never";
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  next_run_at: Date | string | null;
  device_name?: string | null;
};

export type RunRow = {
  id: string;
  task_id: string;
  organization_id: string;
  scheduled_for: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  status: RunStatus;
  exit_code: number | null;
  output: string | null;
  runner: "agent" | "center";
  trigger: "schedule" | "manual";
  error: string | null;
  command: string;
  center_id: string | null;
  agent_task_id: string | null;
  lease_owner: string | null;
  lease_until: Date | string | null;
};

const isoOrNull = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

export function toApiRun(row: RunRow, includeOutput = true) {
  return {
    id: row.id,
    taskId: row.task_id,
    scheduledFor: new Date(row.scheduled_for).toISOString(),
    ...(row.started_at ? { startedAt: isoOrNull(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: isoOrNull(row.finished_at) } : {}),
    status: row.status,
    ...(row.exit_code !== null && row.exit_code !== undefined ? { exitCode: row.exit_code } : {}),
    ...(includeOutput && row.output !== null && row.output !== undefined ? { output: row.output } : {}),
    runner: row.runner,
    trigger: row.trigger,
    ...(row.error ? { error: row.error } : {}),
  };
}
export type ApiRun = ReturnType<typeof toApiRun>;

export function toApiTask(row: TaskRow, lastRun?: RunRow | null) {
  const target: Target = row.target_kind === "device"
    ? { kind: "device", deviceId: row.device_id! }
    : { kind: "ssh", centerId: row.center_id!, hostId: row.host_id!, hostLabel: row.host_label! };
  return {
    id: row.id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    target,
    ...(row.target_kind === "device" && row.device_name ? { targetLabel: row.device_name } : {}),
    command: row.command,
    schedule: row.schedule,
    timezone: row.timezone,
    enabled: row.enabled,
    timeoutSec: row.timeout_sec,
    notify: row.notify,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    nextRunAt: isoOrNull(row.next_run_at),
    ...(lastRun ? { lastRun: toApiRun(lastRun, false) } : {}),
  };
}
export type ApiTask = ReturnType<typeof toApiTask>;

// ---------------------------------------------------------------------------
// Storage

export type Queryable = {
  query: <R = any>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
};
export type Transactional = Queryable & {
  connect: () => Promise<Queryable & { release: () => void }>;
};

const TASK_COLUMNS = `t.id,t.organization_id,t.name,t.description,t.target_kind,t.device_id,t.center_id,
  t.host_id,t.host_label,t.command,t.schedule,t.timezone,t.enabled,t.timeout_sec,t.notify,t.created_by,
  t.created_at,t.updated_at,t.next_run_at`;
const RUN_COLUMNS = `id,task_id,organization_id,scheduled_for,started_at,finished_at,status,exit_code,output,
  runner,trigger,error,command,center_id,agent_task_id,lease_owner,lease_until`;

export type RunPatch = {
  status?: RunStatus;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  exitCode?: number | null;
  output?: string | null;
  error?: string | null;
  agentTaskId?: string | null;
  leaseUntil?: Date | null;
};

/** What the scheduler claimed: the task (already moved to its next run) and its new run. */
export type Claimed = { task: TaskRow; run: RunRow | null; previous: RunRow | null };

export class ScheduledTaskStore {
  constructor(private readonly db: Transactional) {}

  async list(organizationId: string) {
    const tasks = await this.db.query<TaskRow>(
      `select ${TASK_COLUMNS}, d.name as device_name
         from scheduled_tasks t left join devices d on d.id=t.device_id
        where t.organization_id=$1 order by t.created_at asc`,
      [organizationId],
    );
    const last = await this.db.query<RunRow>(
      `select distinct on (task_id) ${RUN_COLUMNS} from scheduled_task_runs
        where organization_id=$1 order by task_id, created_at desc`,
      [organizationId],
    );
    const byTask = new Map(last.rows.map((r) => [r.task_id, r]));
    return tasks.rows.map((t) => ({ task: t, lastRun: byTask.get(t.id) ?? null }));
  }

  async get(organizationId: string, id: string) {
    const result = await this.db.query<TaskRow>(
      `select ${TASK_COLUMNS}, d.name as device_name
         from scheduled_tasks t left join devices d on d.id=t.device_id
        where t.organization_id=$1 and t.id=$2`,
      [organizationId, id],
    );
    return result.rows[0] ?? null;
  }

  async lastRun(taskId: string) {
    const result = await this.db.query<RunRow>(
      `select ${RUN_COLUMNS} from scheduled_task_runs where task_id=$1 order by created_at desc limit 1`, [taskId]);
    return result.rows[0] ?? null;
  }

  async count(organizationId: string) {
    const result = await this.db.query<{ n: number }>(
      "select count(*)::int as n from scheduled_tasks where organization_id=$1", [organizationId]);
    return result.rows[0]?.n ?? 0;
  }

  async deviceInWorkspace(organizationId: string, deviceId: string) {
    const result = await this.db.query(
      "select 1 from devices where id=$1 and organization_id=$2 and revoked_at is null", [deviceId, organizationId]);
    return Boolean(result.rowCount);
  }

  async centerInWorkspace(organizationId: string, centerId: string) {
    const result = await this.db.query(
      "select 1 from management_centers where id=$1 and organization_id=$2 and revoked_at is null",
      [centerId, organizationId]);
    return Boolean(result.rowCount);
  }

  async create(organizationId: string, input: CreateTaskInput, createdBy: string, nextRunAt: Date | null) {
    const t = input.target;
    const result = await this.db.query<{ id: string }>(
      `insert into scheduled_tasks(organization_id,name,description,target_kind,device_id,center_id,host_id,host_label,
         command,schedule,timezone,enabled,timeout_sec,notify,created_by,next_run_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16) returning id`,
      [organizationId, input.name, input.description ?? "", t.kind,
        t.kind === "device" ? t.deviceId : null, t.kind === "ssh" ? t.centerId : null,
        t.kind === "ssh" ? t.hostId : null, t.kind === "ssh" ? t.hostLabel : null,
        input.command, JSON.stringify(input.schedule), input.timezone, input.enabled, input.timeoutSec,
        input.notify, createdBy, input.enabled ? nextRunAt : null],
    );
    return (await this.get(organizationId, result.rows[0]!.id))!;
  }

  /** Writes the merged task (all fields) back. */
  async update(row: TaskRow) {
    await this.db.query(
      `update scheduled_tasks set name=$3,description=$4,target_kind=$5,device_id=$6,center_id=$7,host_id=$8,
          host_label=$9,command=$10,schedule=$11::jsonb,timezone=$12,enabled=$13,timeout_sec=$14,notify=$15,
          next_run_at=$16,updated_at=now()
        where organization_id=$1 and id=$2`,
      [row.organization_id, row.id, row.name, row.description, row.target_kind, row.device_id, row.center_id,
        row.host_id, row.host_label, row.command, JSON.stringify(row.schedule), row.timezone, row.enabled,
        row.timeout_sec, row.notify, row.next_run_at],
    );
    return (await this.get(row.organization_id, row.id))!;
  }

  async remove(organizationId: string, id: string) {
    const result = await this.db.query("delete from scheduled_tasks where organization_id=$1 and id=$2", [organizationId, id]);
    return Boolean(result.rowCount);
  }

  async runs(organizationId: string, taskId: string, limit: number) {
    const result = await this.db.query<RunRow>(
      `select ${RUN_COLUMNS} from scheduled_task_runs where organization_id=$1 and task_id=$2
        order by created_at desc limit $3`,
      [organizationId, taskId, limit],
    );
    return result.rows;
  }

  async getRun(runId: string) {
    const result = await this.db.query<RunRow>(`select ${RUN_COLUMNS} from scheduled_task_runs where id=$1`, [runId]);
    return result.rows[0] ?? null;
  }

  async taskById(taskId: string) {
    const result = await this.db.query<TaskRow>(
      `select ${TASK_COLUMNS}, d.name as device_name from scheduled_tasks t left join devices d on d.id=t.device_id
        where t.id=$1`, [taskId]);
    return result.rows[0] ?? null;
  }

  /** A manual run (run now). Device runs are leased to this gateway instance for dispatch. */
  async insertManualRun(task: TaskRow, leaseOwner: string) {
    const result = await this.db.query<RunRow>(
      `insert into scheduled_task_runs(task_id,organization_id,scheduled_for,status,runner,trigger,command,center_id,
         lease_owner,lease_until)
       values($1,$2,now(),'queued',$3,'manual',$4,$5,$6,case when $3='agent' then now()+interval '2 minutes' end)
       returning ${RUN_COLUMNS}`,
      [task.id, task.organization_id, task.target_kind === "device" ? "agent" : "center", task.command,
        task.center_id, task.target_kind === "device" ? leaseOwner : null],
    );
    return result.rows[0]!;
  }

  /**
   * Claims due tasks safely across gateway instances: the rows are locked
   * with FOR UPDATE SKIP LOCKED, moved to their next run time and given a run
   * in the same transaction, so each due time is claimed exactly once.
   */
  async claimDue(
    now: Date,
    leaseOwner: string,
    computeNext: (task: TaskRow, scheduledFor: Date) => Date | null,
    limit = 50,
  ): Promise<Claimed[]> {
    const client = await this.db.connect();
    const claimed: Claimed[] = [];
    try {
      await client.query("begin");
      const due = await client.query<TaskRow>(
        `select ${TASK_COLUMNS} from scheduled_tasks t
          where t.enabled and t.next_run_at is not null and t.next_run_at<=$1
          order by t.next_run_at asc limit $2
          for update of t skip locked`,
        [now, limit],
      );
      for (const task of due.rows) {
        const scheduledFor = new Date(task.next_run_at!);
        let next: Date | null = null;
        try {
          next = task.schedule.kind === "once" ? null : computeNext(task, scheduledFor);
        } catch {
          next = null; // an unparseable schedule stops instead of looping
        }
        const disable = next === null;
        await client.query(
          `update scheduled_tasks set next_run_at=$2, enabled=case when $3 then false else enabled end
            where id=$1`,
          [task.id, next, disable],
        );
        const previous = (await client.query<RunRow>(
          `select ${RUN_COLUMNS} from scheduled_task_runs where task_id=$1 order by created_at desc limit 1`,
          [task.id],
        )).rows[0] ?? null;
        const runner = task.target_kind === "device" ? "agent" : "center";
        let run: RunRow | null = null;
        if (runner === "center" && previous && previous.status === "queued") {
          // The app has not picked up the last run yet: one pending run per task.
          run = null;
        } else {
          const busy = previous && (previous.status === "running" || previous.status === "queued");
          run = (await client.query<RunRow>(
            `insert into scheduled_task_runs(task_id,organization_id,scheduled_for,status,runner,trigger,command,
               center_id,error,finished_at,lease_owner,lease_until)
             values($1,$2,$3,$4,$5,'schedule',$6,$7,$8,$9,$10,$11)
             on conflict (task_id,scheduled_for) where trigger='schedule' do nothing
             returning ${RUN_COLUMNS}`,
            [task.id, task.organization_id, scheduledFor, busy ? "skipped" : "queued", runner, task.command,
              task.center_id, busy ? "previous_run_still_running" : null, busy ? now : null,
              !busy && runner === "agent" ? leaseOwner : null,
              !busy && runner === "agent" ? new Date(now.getTime() + 120_000) : null],
          )).rows[0] ?? null;
        }
        claimed.push({ task: { ...task, next_run_at: next, enabled: task.enabled && !disable }, run, previous });
      }
      await client.query("commit");
      return claimed;
    } catch (error) {
      try { await client.query("rollback"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  /** Agent runs whose gateway lease ran out (an instance stopped mid-run): taken over by this one. */
  async claimStaleAgentRuns(now: Date, leaseOwner: string, limit = 20) {
    const result = await this.db.query<RunRow>(
      `update scheduled_task_runs r set lease_owner=$2, lease_until=$1::timestamptz + interval '2 minutes'
        where r.id in (
          select id from scheduled_task_runs
           where runner='agent' and status in ('queued','running') and lease_until<$1
           order by lease_until asc limit $3
           for update skip locked)
        returning ${RUN_COLUMNS.split(",").map((c) => "r." + c.trim()).join(",")}`,
      [now, leaseOwner, limit],
    );
    return result.rows;
  }

  /** Updates a run that is still open (and, with `leaseOwner`, still ours). Returns null otherwise. */
  async updateRun(runId: string, patch: RunPatch, leaseOwner?: string) {
    const sets: string[] = [];
    const args: unknown[] = [runId];
    const add = (column: string, value: unknown) => { args.push(value); sets.push(`${column}=$${args.length}`); };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.startedAt !== undefined) add("started_at", patch.startedAt);
    if (patch.finishedAt !== undefined) add("finished_at", patch.finishedAt);
    if (patch.exitCode !== undefined) add("exit_code", patch.exitCode);
    if (patch.output !== undefined) add("output", patch.output);
    if (patch.error !== undefined) add("error", patch.error === null ? null : patch.error.slice(0, 2000));
    if (patch.agentTaskId !== undefined) add("agent_task_id", patch.agentTaskId);
    if (patch.leaseUntil !== undefined) add("lease_until", patch.leaseUntil);
    if (!sets.length) return null;
    let where = "id=$1 and status in ('queued','running')";
    if (leaseOwner !== undefined) { args.push(leaseOwner); where += ` and lease_owner=$${args.length}`; }
    const result = await this.db.query<RunRow>(
      `update scheduled_task_runs set ${sets.join(",")} where ${where} returning ${RUN_COLUMNS}`, args);
    return result.rows[0] ?? null;
  }

  /** Removes an open run (or, with `anyStatus`, a just-expired one) that is folded into an earlier missed run. */
  async deleteRun(runId: string, anyStatus = false) {
    await this.db.query(
      `delete from scheduled_task_runs where id=$1${anyStatus ? "" : " and status in ('queued','running')"}`, [runId]);
  }

  /** The Center takes the SSH runs queued for it (lease: 15 min or the task timeout plus 5 min). */
  async claimForCenter(organizationId: string, centerId: string, limit = 20) {
    const result = await this.db.query<RunRow>(
      `update scheduled_task_runs r
          set status='running', started_at=now(), lease_owner='center:'||$2::text,
              lease_until=now() + greatest(interval '15 minutes',
                (select t.timeout_sec from scheduled_tasks t where t.id=r.task_id) * interval '1 second' + interval '5 minutes')
        where r.id in (
          select id from scheduled_task_runs
           where organization_id=$1 and center_id=$2 and runner='center' and status='queued'
           order by scheduled_for asc limit $3
           for update skip locked)
        returning ${RUN_COLUMNS.split(",").map((c) => "r." + c.trim()).join(",")}`,
      [organizationId, centerId, limit],
    );
    return result.rows;
  }

  async finishCenterRun(organizationId: string, centerId: string, runId: string, patch: RunPatch) {
    const result = await this.db.query<RunRow>(
      `update scheduled_task_runs set status=$4, finished_at=now(), exit_code=$5, output=$6, error=$7
        where id=$3 and organization_id=$1 and center_id=$2 and runner='center' and status='running'
        returning ${RUN_COLUMNS}`,
      [organizationId, centerId, runId, patch.status, patch.exitCode ?? null, patch.output ?? null,
        patch.error ? patch.error.slice(0, 2000) : null],
    );
    return result.rows[0] ?? null;
  }

  /**
   * SSH runs the Center never claimed within 15 minutes become missed, and
   * claimed runs whose lease ran out without a result fail.
   */
  async expireCenterRuns(now: Date) {
    const missed = await this.db.query<RunRow>(
      `update scheduled_task_runs set status='missed', finished_at=$1, error='not_claimed_by_app'
        where runner='center' and status='queued' and created_at < $1::timestamptz - interval '15 minutes'
        returning ${RUN_COLUMNS}`,
      [now],
    );
    const lost = await this.db.query<RunRow>(
      `update scheduled_task_runs set status='failed', finished_at=$1, error='no_result_from_app'
        where runner='center' and status='running' and lease_until < $1
        returning ${RUN_COLUMNS}`,
      [now],
    );
    return [...missed.rows, ...lost.rows];
  }

  /** The run before `run` of the same task (for "one missed run per outage"). */
  async previousRun(run: RunRow) {
    const result = await this.db.query<RunRow>(
      `select ${RUN_COLUMNS} from scheduled_task_runs
        where task_id=$1 and id<>$2 and created_at<=(select created_at from scheduled_task_runs where id=$2)
        order by created_at desc limit 1`,
      [run.task_id, run.id],
    );
    return result.rows[0] ?? null;
  }

  async audit(organizationId: string, actor: string, deviceId: string | null, tool: string, risk: string,
    outcome: string, detail: unknown) {
    await this.db.query(
      "insert into audit_logs(organization_id,actor,device_id,tool,risk,outcome,detail) values($1,$2,$3,$4,$5,$6,$7)",
      [organizationId, actor, deviceId, tool, risk, outcome, typeof detail === "string" ? detail : JSON.stringify(detail)],
    );
  }

  /** Who hears about a run: the task's creator, or the workspace owners/admins when that is not a person. */
  async notifyRecipients(task: TaskRow) {
    const userId = /^user:([0-9a-f-]{36})$/i.exec(task.created_by)?.[1];
    if (userId) {
      const own = await this.db.query<{ email: string }>(
        `select u.email from users u join organization_members m on m.user_id=u.id and m.organization_id=$2
          where u.id=$1 and u.disabled_at is null and u.email_verified_at is not null`,
        [userId, task.organization_id],
      );
      if (own.rowCount) return own.rows.map((r) => r.email);
    }
    const admins = await this.db.query<{ email: string }>(
      `select u.email from organization_members m join users u on u.id=m.user_id
        where m.organization_id=$1 and m.role in ('owner','admin')
          and u.disabled_at is null and u.email_verified_at is not null
        order by m.role desc, u.email limit 5`,
      [task.organization_id],
    );
    return admins.rows.map((r) => r.email);
  }
}

// ---------------------------------------------------------------------------
// Notifications

/** Whether a finished run should be reported to the owner. */
export function shouldNotify(notify: TaskRow["notify"], status: RunStatus) {
  if (notify === "never" || !FINAL_STATUSES.has(status)) return false;
  if (notify === "always") return status !== "skipped";
  return status === "failed" || status === "missed";
}

export function runMail(task: TaskRow, run: RunRow, baseUrl: string) {
  const target = task.target_kind === "device" ? (task.device_name || task.device_id || "") : (task.host_label || "");
  const statusTr: Record<string, string> = {
    succeeded: "başarılı", failed: "başarısız", missed: "kaçırıldı", cancelled: "iptal edildi", skipped: "atlandı",
  };
  const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 300);
  const tail = (run.output ?? "").slice(-1500);
  const when = new Date(run.scheduled_for).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const link = `${baseUrl.replace(/\/+$/, "")}/scheduled-tasks`;
  return {
    subject: `WECOMMANDER: zamanlanmış görev ${statusTr[run.status] ?? run.status} · ${oneLine(task.name)}`.slice(0, 160),
    text:
      `Zamanlanmış görev: ${oneLine(task.name)}\nHedef: ${oneLine(target)}\nKomut: ${oneLine(task.command)}\n` +
      `Planlanan: ${when}\nSonuç: ${statusTr[run.status] ?? run.status}` +
      (run.exit_code !== null && run.exit_code !== undefined ? ` (çıkış kodu ${run.exit_code})` : "") +
      (run.error ? `\nHata: ${oneLine(run.error)}` : "") +
      (tail ? `\n\nÇıktının sonu:\n${tail}` : "") +
      `\n\nAyrıntılar: ${link}\n\n---\nScheduled task "${oneLine(task.name)}" on ${oneLine(target)}: ${run.status}. ${link}`,
  };
}
