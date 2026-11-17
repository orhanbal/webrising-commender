import assert from "node:assert/strict";
import test from "node:test";

process.env.CONTROL_API_KEY ||= "x".repeat(32);
process.env.APPROVAL_SIGNING_SECRET ||= "y".repeat(32);
process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";

const {
  createTaskSchema, patchTaskSchema, previewSchema, processOutput, combineOutput, shouldNotify, validationError,
  ScheduledTaskStore, toApiTask, toApiRun, OUTPUT_LIMIT_BYTES,
} = await import("./scheduled-tasks.js");
const { ScheduledTaskRunner } = await import("./scheduled-task-runner.js");
const { centerMayAccess } = await import("./center-link.js");
type TaskRow = import("./scheduled-tasks.js").TaskRow;
type RunRow = import("./scheduled-tasks.js").RunRow;

const DEVICE = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000002";
const TASK = "00000000-0000-4000-8000-000000000003";

const valid = {
  name: "Backup", target: { kind: "device", deviceId: DEVICE }, command: "echo hi",
  schedule: { kind: "cron", expr: "0 3 * * *" },
};

test("task validation: defaults and limits from the contract", () => {
  const parsed = createTaskSchema.parse(valid);
  assert.equal(parsed.timezone, "Europe/Istanbul");
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.timeoutSec, 600);
  assert.equal(parsed.notify, "failure");
  const bad = [
    { ...valid, name: "" }, { ...valid, name: "x".repeat(81) }, { ...valid, command: "" }, { ...valid, command: "   " },
    { ...valid, command: "x".repeat(4001) }, { ...valid, command: "a\u0000b" },
    { ...valid, schedule: { kind: "cron", expr: "* * *" } }, { ...valid, schedule: { kind: "interval", minutes: 4 } },
    { ...valid, schedule: { kind: "interval", minutes: 10081 } }, { ...valid, schedule: { kind: "once", at: "tomorrow" } },
    { ...valid, schedule: { kind: "weekly" } }, { ...valid, timezone: "+03:00" }, { ...valid, timeoutSec: 9 },
    { ...valid, timeoutSec: 3601 }, { ...valid, notify: "sometimes" }, { ...valid, target: { kind: "device", deviceId: "x" } },
    { ...valid, target: { kind: "ssh", centerId: DEVICE, hostId: "h" } },
  ];
  for (const input of bad) assert.throws(() => createTaskSchema.parse(input), JSON.stringify(input));
  assert.equal(createTaskSchema.parse({ ...valid, command: "line1\nline2" }).command, "line1\nline2");
  assert.equal(createTaskSchema.parse({ ...valid, schedule: { kind: "once", at: "2027-01-01T09:00:00+03:00" } }).schedule.kind, "once");
  assert.throws(() => patchTaskSchema.parse({}), "an empty patch changes nothing");
  assert.equal(patchTaskSchema.parse({ enabled: false }).enabled, false);
  assert.equal(previewSchema.parse({ schedule: { kind: "interval", minutes: 5 } }).timezone, "Europe/Istanbul");
});

test("validation errors carry a code and a readable message", () => {
  try {
    createTaskSchema.parse({ ...valid, schedule: { kind: "cron", expr: "61 * * * *" } });
    assert.fail("should throw");
  } catch (error) {
    const body = validationError(error);
    assert.equal(body.error, "invalid_request");
    assert.match(body.message, /schedule\.expr: minute: 61 is outside 0-59/);
  }
});

test("output is scrubbed and capped at 64 KiB keeping the tail", () => {
  const out = processOutput("token=abc123 at /home/alice/x and C:\\Users\\Bob\\y\n");
  assert.equal(out, "token=[REDACTED] at /home/…/x and C:\\Users\\…\\y\n");
  const long = processOutput("é".repeat(40_000) + "TAIL");
  assert.ok(Buffer.byteLength(long) <= OUTPUT_LIMIT_BYTES);
  assert.match(long, /^…\[\d+ bytes truncated\]\n/);
  assert.ok(long.endsWith("TAIL"));
  assert.ok(!long.includes("\uFFFD"), "no broken character at the cut");
  assert.equal(combineOutput({ stdout: "a", stderr: "b" }), "a\nb");
  assert.equal(combineOutput({ stdout: "a\n", stderr: "" }), "a\n");
  assert.equal(combineOutput(null), "");
});

test("notification policy", () => {
  assert.equal(shouldNotify("failure", "failed"), true);
  assert.equal(shouldNotify("failure", "missed"), true);
  assert.equal(shouldNotify("failure", "succeeded"), false);
  assert.equal(shouldNotify("always", "succeeded"), true);
  assert.equal(shouldNotify("always", "skipped"), false);
  assert.equal(shouldNotify("always", "running"), false);
  assert.equal(shouldNotify("never", "failed"), false);
});

test("the Management Center reaches the scheduled task routes, nothing more", () => {
  assert.equal(centerMayAccess("GET", "/api/scheduled-tasks"), true);
  assert.equal(centerMayAccess("POST", `/api/scheduled-tasks/${TASK}/run`), true);
  assert.equal(centerMayAccess("PATCH", `/api/scheduled-tasks/${TASK}`), true);
  assert.equal(centerMayAccess("GET", "/api/center/scheduled-runs/claim"), true);
  assert.equal(centerMayAccess("POST", `/api/center/scheduled-runs/${TASK}/result`), true);
  assert.equal(centerMayAccess("PUT", `/api/scheduled-tasks/${TASK}`), false);
  assert.equal(centerMayAccess("POST", "/mcp"), false);
});

function taskRow(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: TASK, organization_id: ORG, name: "Backup", description: "", target_kind: "device", device_id: DEVICE,
    center_id: null, host_id: null, host_label: null, command: "echo hi", schedule: { kind: "cron", expr: "0 * * * *" },
    timezone: "UTC", enabled: true, timeout_sec: 60, notify: "failure", created_by: "user:" + ORG,
    created_at: "2026-11-17T10:00:00Z", updated_at: "2026-11-17T10:00:00Z", next_run_at: "2026-11-17T11:00:00Z",
    ...over,
  };
}
function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    id: "00000000-0000-4000-8000-0000000000aa", task_id: TASK, organization_id: ORG,
    scheduled_for: "2026-11-17T11:00:00Z", started_at: null, finished_at: null, status: "queued", exit_code: null,
    output: null, runner: "agent", trigger: "schedule", error: null, command: "echo hi", center_id: null,
    agent_task_id: null, lease_owner: "me", lease_until: null, ...over,
  };
}

test("API shapes follow the contract", () => {
  const api = toApiTask(taskRow({ device_name: "pc" }), runRow({ status: "succeeded", output: "x", exit_code: 0 }));
  assert.deepEqual(api.target, { kind: "device", deviceId: DEVICE });
  assert.equal(api.nextRunAt, "2026-11-17T11:00:00.000Z");
  assert.equal(api.lastRun?.status, "succeeded");
  assert.equal("output" in api.lastRun!, false, "the list does not carry run output");
  const run = toApiRun(runRow({ status: "failed", exit_code: 2, error: "boom" }));
  assert.equal(run.exitCode, 2);
  assert.equal(run.error, "boom");
  assert.equal("startedAt" in run, false);
  const ssh = toApiTask(taskRow({ target_kind: "ssh", device_id: null, center_id: ORG, host_id: "h1", host_label: "web" }));
  assert.deepEqual(ssh.target, { kind: "ssh", centerId: ORG, hostId: "h1", hostLabel: "web" });
});

test("claiming due tasks locks rows with SKIP LOCKED and moves them in the same transaction", async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const due = [taskRow(), taskRow({ id: "00000000-0000-4000-8000-000000000004", schedule: { kind: "once", at: "2026-11-17T11:00:00Z" } }),
    taskRow({ id: "00000000-0000-4000-8000-000000000005", target_kind: "ssh", device_id: null, center_id: ORG, host_id: "h", host_label: "web" })];
  let released = false;
  const client = {
    query: async (sql: string, args: unknown[] = []) => {
      calls.push({ sql, args });
      if (/for update of t skip locked/.test(sql)) return { rows: due, rowCount: due.length };
      if (/order by created_at desc limit 1/.test(sql)) {
        // The SSH task still has an unclaimed run: no second one is queued.
        return args[0] === "00000000-0000-4000-8000-000000000005"
          ? { rows: [runRow({ status: "queued", runner: "center" })], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/insert into scheduled_task_runs/.test(sql)) return { rows: [runRow({ task_id: String(args[0]) })], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  };
  const store = new ScheduledTaskStore({ query: client.query as any, connect: async () => client as any });
  const now = new Date("2026-11-17T11:00:20Z");
  const claimed = await store.claimDue(now, "me", (_task, at) => new Date(at.getTime() + 3_600_000));
  assert.equal(calls[0]!.sql, "begin");
  assert.match(calls[1]!.sql, /next_run_at<=\$1[\s\S]*for update of t skip locked/);
  assert.equal(calls.at(-1)!.sql, "commit");
  assert.equal(released, true);
  const updates = calls.filter((c) => /update scheduled_tasks set next_run_at/.test(c.sql));
  assert.deepEqual(updates.map((u) => [u.args[0], (u.args[1] as Date | null)?.toISOString() ?? null, u.args[2]]), [
    [TASK, "2026-11-17T12:00:00.000Z", false],
    ["00000000-0000-4000-8000-000000000004", null, true], // once: disabled after its run
    ["00000000-0000-4000-8000-000000000005", "2026-11-17T12:00:00.000Z", false],
  ]);
  const inserts = calls.filter((c) => /insert into scheduled_task_runs/.test(c.sql));
  assert.equal(inserts.length, 2);
  assert.match(inserts[0]!.sql, /on conflict \(task_id,scheduled_for\) where trigger='schedule' do nothing/);
  assert.equal(claimed.length, 3);
  assert.equal(claimed[1]!.task.enabled, false);
  assert.equal(claimed[2]!.run, null);
});

test("a failing claim rolls back and releases the connection", async () => {
  const seen: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => { seen.push(sql); if (/skip locked/.test(sql)) throw new Error("db down"); return { rows: [], rowCount: 0 }; },
    release: () => { released = true; },
  };
  const store = new ScheduledTaskStore({ query: client.query as any, connect: async () => client as any });
  await assert.rejects(store.claimDue(new Date(), "me", () => null), /db down/);
  assert.equal(seen.at(-1), "rollback");
  assert.equal(released, true);
});

// --- Runner -----------------------------------------------------------------

function fakeStore(claims: Array<{ task: TaskRow; run: RunRow | null; previous: RunRow | null }> = []) {
  const runs = new Map<string, RunRow>();
  const audits: Array<{ actor: string; outcome: string; detail: any }> = [];
  const deleted: string[] = [];
  for (const c of claims) if (c.run) runs.set(c.run.id, c.run);
  const store = {
    runs, audits, deleted,
    claimDue: async () => claims,
    claimStaleAgentRuns: async () => [],
    expireCenterRuns: async () => [],
    previousRun: async () => null,
    taskById: async () => claims[0]?.task ?? null,
    insertManualRun: async (task: TaskRow) => {
      const run = runRow({ id: "00000000-0000-4000-8000-0000000000bb", trigger: "manual", command: task.command });
      runs.set(run.id, run);
      return run;
    },
    updateRun: async (id: string, patch: any) => {
      const run = runs.get(id);
      if (!run || !["queued", "running"].includes(run.status)) return null;
      const next = { ...run };
      if (patch.status) next.status = patch.status;
      if (patch.exitCode !== undefined) next.exit_code = patch.exitCode;
      if (patch.output !== undefined) next.output = patch.output;
      if (patch.error !== undefined) next.error = patch.error;
      if (patch.agentTaskId !== undefined) next.agent_task_id = patch.agentTaskId;
      if (patch.startedAt !== undefined) next.started_at = patch.startedAt;
      runs.set(id, next);
      return next;
    },
    deleteRun: async (id: string) => { deleted.push(id); runs.delete(id); },
    audit: async (_org: string, actor: string, _device: string | null, _tool: string, _risk: string, outcome: string, detail: any) => {
      audits.push({ actor, outcome, detail });
    },
  };
  return store;
}

function fakeDevices(opts: { online?: boolean; statuses?: unknown[]; startError?: string } = {}) {
  const requests: Array<{ action: any; token: unknown; scope: any }> = [];
  const statuses = [...(opts.statuses ?? [])];
  return {
    requests,
    isOnline: async () => opts.online ?? true,
    request: async (_device: string, action: any, token?: unknown, _s?: unknown, _p?: unknown, _id?: unknown, _sp?: unknown, scope?: unknown) => {
      requests.push({ action, token, scope });
      if (action.kind === "task_start") {
        if (opts.startError) throw new Error(opts.startError);
        return { taskId: "agent-task-1", status: "running" };
      }
      if (action.kind === "task_status") {
        const next = statuses.shift();
        if (next instanceof Error) throw next;
        return next ?? { status: "running" };
      }
      return {};
    },
  };
}

function runner(store: ReturnType<typeof fakeStore>, devices: ReturnType<typeof fakeDevices>, notified: RunRow[] = []) {
  return new ScheduledTaskRunner({
    store: store as any, devices: devices as any, instanceId: "me",
    issueToken: (_d, action) => "token-for-" + action.kind,
    notify: async (_task, run) => { notified.push(run); },
    sleep: async () => undefined, pollDelaysMs: [0], log: () => undefined,
    now: () => new Date("2026-11-17T11:00:05Z"),
  });
}

test("a due device run starts on the agent with its own approval and records the result", async () => {
  const task = taskRow();
  const store = fakeStore([{ task, run: runRow(), previous: null }]);
  const devices = fakeDevices({ statuses: [{ status: "running" }, new Error("device-offline"), {
    status: "completed", result: { exitCode: 0, success: true, stdout: "done api_key=abc\n", stderr: "" },
  }] });
  const notified: RunRow[] = [];
  const r = runner(store, devices, notified);
  assert.deepEqual(await r.tick(), { claimed: 1, recovered: 0, expired: 0 });
  await r.idle();
  const start = devices.requests[0]!;
  assert.deepEqual(start.action, { kind: "task_start", command: "echo hi", timeoutMs: 60_000 });
  assert.equal(start.token, "token-for-task_start");
  assert.equal(start.scope.actor, `scheduled-task:${TASK}`);
  assert.equal(devices.requests.filter((x) => x.action.kind === "task_status").length, 3, "polls through an outage");
  const run = [...store.runs.values()][0]!;
  assert.equal(run.status, "succeeded");
  assert.equal(run.exit_code, 0);
  assert.equal(run.output, "done api_key=[REDACTED]\n");
  assert.deepEqual(store.audits.map((a) => a.outcome), ["started", "succeeded"]);
  assert.equal(store.audits[1]!.actor, `scheduled-task:${TASK}`);
  assert.equal(store.audits[1]!.detail.origin, `scheduled-task:${TASK}`);
  assert.equal(notified.length, 0, "success is not mailed with notify=failure");
});

test("a non-zero exit code and a policy refusal fail the run and notify", async () => {
  const exit = fakeStore([{ task: taskRow(), run: runRow(), previous: null }]);
  const notified: RunRow[] = [];
  const r1 = runner(exit, fakeDevices({ statuses: [{ status: "completed", result: { exitCode: 2, stdout: "", stderr: "nope" } }] }), notified);
  await r1.tick();
  await r1.idle();
  const failed = [...exit.runs.values()][0]!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.exit_code, 2);
  assert.equal(failed.output, "nope");
  const refused = fakeStore([{ task: taskRow(), run: runRow(), previous: null }]);
  const r2 = runner(refused, fakeDevices({ startError: "device_policy_denied: command execution is disabled on this device" }), notified);
  await r2.tick();
  await r2.idle();
  assert.match([...refused.runs.values()][0]!.error!, /device_policy_denied/);
  assert.equal(notified.length, 2);
});

test("an offline device: missed once per outage, no catch-up", async () => {
  const notified: RunRow[] = [];
  const first = fakeStore([{ task: taskRow(), run: runRow(), previous: runRow({ status: "succeeded" }) }]);
  const r1 = runner(first, fakeDevices({ online: false }), notified);
  await r1.tick();
  await r1.idle();
  assert.equal([...first.runs.values()][0]!.status, "missed");
  assert.equal([...first.runs.values()][0]!.error, "device_offline");
  assert.equal(notified.length, 1);
  const second = fakeStore([{ task: taskRow(), run: runRow(), previous: runRow({ status: "missed", error: "device_offline" }) }]);
  const r2 = runner(second, fakeDevices({ online: false }), notified);
  await r2.tick();
  await r2.idle();
  assert.deepEqual(second.deleted, [runRow().id], "the second missed due time is folded into the first");
  assert.equal(notified.length, 1);
});

test("the next run after a claim is never in the past and keeps the interval grid", () => {
  const r = runner(fakeStore(), fakeDevices());
  // now = 11:00:05; a 15-minute interval due at 09:00 (gateway was down) goes to 11:15, not 09:15.
  const next = r.nextAfterClaim(taskRow({ schedule: { kind: "interval", minutes: 15 } }), new Date("2026-11-17T09:00:00Z"));
  assert.equal(next?.toISOString(), "2026-11-17T11:15:00.000Z");
  const cron = r.nextAfterClaim(taskRow({ schedule: { kind: "cron", expr: "* * * * *" } }), new Date("2026-11-17T09:00:00Z"));
  assert.equal(cron?.toISOString(), "2026-11-17T11:01:00.000Z");
});

test("the scheduler never throws, whatever the database does", async () => {
  const broken = {
    claimDue: async () => { throw new Error("db down"); },
    claimStaleAgentRuns: async () => { throw new Error("db down"); },
    expireCenterRuns: async () => { throw new Error("db down"); },
  };
  const logs: string[] = [];
  const r = new ScheduledTaskRunner({
    store: broken as any, devices: fakeDevices() as any, issueToken: () => "t", notify: async () => undefined,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(await r.tick(), { claimed: 0, recovered: 0, expired: 0 });
  assert.equal(logs.length, 3);
  // A store that fails while closing a run is logged, not thrown.
  const store = fakeStore([{ task: taskRow(), run: runRow(), previous: null }]);
  store.updateRun = async () => { throw new Error("write failed"); };
  const r2 = runner(store, fakeDevices({ online: false }));
  await r2.tick();
  await r2.idle();
});

test("skipped runs (previous still running) are recorded without dispatch", async () => {
  const store = fakeStore([{ task: taskRow(), run: runRow({ status: "skipped", error: "previous_run_still_running" }), previous: null }]);
  const devices = fakeDevices();
  const r = runner(store, devices);
  await r.tick();
  await r.idle();
  assert.equal(devices.requests.length, 0);
  assert.deepEqual(store.audits.map((a) => a.outcome), ["skipped"]);
});
