# Scheduled tasks

WECOMMANDER's own scheduled tasks are stored on the WECOMMANDER server (not in
the operating system's task scheduler) and run when they are due:

- **Device targets** are run by the gateway on the target device's agent, so
  they run while the owner's computer is off.
- **Saved SSH host targets** are run by the owner's desktop app (Management
  Center), which holds the SSH credentials: the gateway queues the run and the
  app claims and executes it.

The existing OS-level views (Windows Task Scheduler window, systemd timers)
stay as separate tools.

Web panel: **Workspace › Scheduled tasks** (`/scheduled-tasks`).

## Model

```text
ScheduledTask {
  id: uuid, name: string (1..80), description?: string (≤500),
  target: { kind: "device", deviceId: uuid }
        | { kind: "ssh", centerId: uuid, hostId: string, hostLabel: string },
  targetLabel?: string,            // device name (read-only, list only)
  command: string (1..4000),       // the exact shell command
  schedule: { kind: "cron", expr: "m h dom mon dow" }
          | { kind: "interval", minutes: 5..10080 }
          | { kind: "once", at: ISO-8601 with offset },
  timezone: IANA name (default Europe/Istanbul),
  enabled: boolean, timeoutSec: 10..3600 (default 600),
  notify: "failure" | "always" | "never" (default "failure"),
  createdBy, createdAt, updatedAt,
  nextRunAt: ISO | null, lastRun?: Run (without output)
}
Run {
  id: uuid, taskId, scheduledFor: ISO, startedAt?, finishedAt?,
  status: "queued"|"running"|"succeeded"|"failed"|"missed"|"skipped"|"cancelled",
  exitCode?: number, output?: string (stdout then stderr, scrubbed, ≤ 64 KiB, tail kept),
  runner: "agent"|"center", trigger: "schedule"|"manual", error?: string
}
```

## REST

Same authentication as the rest of `/api`: browser session cookie (with the
CSRF header on writes), an API token, or a Management Center `wmc_` token.
Everything is scoped to the caller's workspace. Reading needs any role;
creating, changing, deleting and running need **owner or admin**.

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| GET | `/api/scheduled-tasks` | | `200 { items: ScheduledTask[] }` |
| POST | `/api/scheduled-tasks` | task fields (no id) | `201 { item }` |
| PATCH | `/api/scheduled-tasks/:id` | any task fields | `200 { item }` |
| DELETE | `/api/scheduled-tasks/:id` | | `200 { ok: true }` |
| POST | `/api/scheduled-tasks/:id/run` | | `200 { run }` (trigger `manual`, status `queued`) |
| GET | `/api/scheduled-tasks/:id/runs?limit=50` | | `200 { items: Run[] }` (newest first, ≤200) |
| POST | `/api/scheduled-tasks/preview` | `{ schedule, timezone }` | `200 { next: ISO[] }` (next 5 run times) |

Errors: `400 { error, message }` for validation (`invalid_request`,
`invalid_schedule`, `unknown_device`, `unknown_center`), `403 { error:
"forbidden", requiredRole }`, `403 { error: "ssh_task_app_only" }` (see below),
`404 not_found`, `409 { error: "scheduled_task_limit", used, limit }`, `402
billing_required`, `429 rate_limited` (run now: 10/min per task; preview:
120/min per caller).

Rules:

- A `once` time in the past is refused. A cron expression that never matches a
  date (`0 0 31 2 *`) is refused.
- SSH targets are created, and their target or command changed, only with a
  Management Center token (the app knows the saved hosts; the server never
  sees SSH credentials). The web panel shows SSH tasks and may rename,
  reschedule, enable/disable, run now and delete them.
- Changing the schedule, the time zone, or enabling a task recomputes
  `nextRunAt` from now; disabling clears it. An `interval` task first runs one
  interval after it is saved.
- Plan limit: plan metadata `maxScheduledTasks` (free plan default 10), never
  more than 100 per workspace.
- Every change is written to the audit log as the caller
  (`scheduled_task.create|update|delete|run_now`, risk `high`, with the exact
  command, secrets masked). Changes from the app carry `via: {center, centerId}`.

## Desktop app (SSH targets)

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| GET | `/api/center/scheduled-runs/claim` | | `200 { items: [{ run, task }] }` |
| POST | `/api/center/scheduled-runs/:runId/result` | `{ status: "succeeded"\|"failed", exitCode?, output?, error? }` | `200 { ok: true }` |

Both need a Center token (`403 center_token_required` otherwise) of an
owner/admin. `claim` atomically moves the runs queued for **this** center to
`running` (FOR UPDATE SKIP LOCKED, so two polls never get the same run) and
leases them for 15 minutes or the task timeout plus 5 minutes, whichever is
longer. `task.command` in the claim is the command that was due. The app polls
`claim` every 30 s while it runs and right after start. `result` accepts one
result per claimed run (`404 run_not_found` afterwards); the output is scrubbed
and capped on the server too.

A queued SSH run not claimed within 15 minutes becomes `missed`
(`error: "not_claimed_by_app"`); a claimed run without a result when its lease
ends becomes `failed` (`no_result_from_app`). While a run of the task is still
queued, due times add no further queued run, and consecutive unclaimed due
times keep a single missed run.

## How device runs work

Every gateway instance runs the scheduler every 30 s
(`SCHEDULED_TASKS_INTERVAL_MS`, `SCHEDULED_TASKS_DISABLED=true` turns it off):

1. **Claim.** In one transaction it selects due, enabled tasks with
   `FOR UPDATE SKIP LOCKED`, moves each to its next run time, disables `once`
   tasks, and inserts the run. A unique index on `(task_id, scheduled_for)` for
   scheduled runs is a second guard, so each due time runs once however many
   instances there are.
2. **No catch-up storm.** The next run is computed from *now*: a gateway that
   was down for hours runs a task once, then continues on its schedule
   (interval tasks stay on their grid).
3. **Dispatch.** Device offline at due time: the run is `missed`
   (`device_offline`); further due times during the same outage add no more
   missed runs. A run still `running`/`queued` when the next is due: the new
   one is `skipped` (`previous_run_still_running`). Otherwise the gateway sends
   the agent a background task (`task_start`, the same command execution as
   `process_exec`, with `timeoutMs = timeoutSec × 1000`) and polls
   `task_status` until it finishes. The command runs through the existing relay
   with origin `scheduled-task:<taskId>`.
4. **Approval.** The owner's creation of the task is the approval: the gateway
   issues the one-use device approval for that exact command itself. No
   approval request is created per run, whatever the device's trust level. The
   agent's own local policy still applies: restricted mode or disabled commands
   refuse the run, and the run fails with that reason.
5. **Result.** Exit code 0 is `succeeded`, any other exit code `failed`; a
   command the agent stopped (timeout) or refused is `failed` with the agent's
   message. Output is stdout then stderr, secrets masked (`token=…`,
   `password=…`, bearer headers, database URLs), user folder names removed,
   and only the last 64 KiB kept (`…[N bytes truncated]` in front).
6. **Robustness.** Runs are leased to the instance polling them (2 minutes,
   renewed on every poll). If an instance stops, another takes the run over
   when the lease ends and keeps polling the agent; a run that never reached
   the agent is retried within 15 minutes of its due time, later it is
   `missed`. If the agent restarted and lost the task, the run fails with that
   reason. No scheduler error can stop the gateway: errors are recorded on the
   run or logged.
7. **Audit and notification.** Every run start and outcome is audited as actor
   `scheduled-task:<taskId>`, tool `scheduled_task.run`, with `origin` and
   `approvedBy` (the task's creator) in the detail. With `notify: "failure"`
   failed and missed runs are e-mailed, with `"always"` every finished run; the
   mail goes to the task's creator, or to the workspace owners/admins when the
   creator is not a person (API token). In the web panel the Scheduled tasks
   menu item shows how many tasks' last run failed or was missed.

Finished runs are kept for 90 days.

## Schedules and time zones

`cron` is standard 5-field cron: `*`, numbers, ranges `a-b`, steps `*/n`,
`a-b/n` and `a/n`, lists `a,b,c`, month names `jan`–`dec`, weekday names
`sun`–`sat` (0 and 7 are Sunday). When both day-of-month and day-of-week are
restricted, a day matches if either matches (classic cron). Times are wall-clock
times in the task's IANA `timezone`:

- A local time skipped by a daylight-saving change (02:30 on a 02:00→03:00
  night) runs at the same offset after the change (03:30), so a daily job is
  not lost.
- A local time that occurs twice (fall back) runs once, at its first
  occurrence; a job whose hour field is `*` keeps running every real hour.

`POST /api/scheduled-tasks/preview` returns the next five times so the panel
and the apps show them before saving.
