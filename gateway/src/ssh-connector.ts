// Hybrid Access H3/H4 (docs/HYBRID_ACCESS.md §5): remote MCP clients reach
// the saved SSH hosts a person shared with "Uzak yapay zekâlar" through the
// WECOMMANDER app on that person's own computer (the connector).
//
// - The app (a Management Center token) publishes its shared hosts:
//   PUT /api/center/connector/targets {targets:[{hostId,name,preset,sudo}]}.
//   Never the address, user or credential; the target id the AI sees is
//   derived from (center, host) and reveals neither.
// - MCP tool calls with such a target are queued in connector_calls; the app
//   long-polls GET /api/center/connector/claim, runs the call in its core
//   (the SSH keys never leave that computer) and posts
//   POST /api/center/connector/calls/:id/result. Interactive calls fail
//   closed: a computer that does not claim within a few seconds is offline
//   (`connector_offline`), nothing waits in a queue for later.
// - AI permissions per target (docs/AI_PERMISSIONS.md), set in the web panel
//   like an agent device's: trust strict/standard/full (full optionally
//   time-limited), run_as user/root and the safety net. A command or change
//   needs the person's one-time approval here (approval_requests bound to
//   client, target and the exact arguments, 5 minutes, single use) unless
//   trust is full, or trust is standard and the command is on the target's
//   allowlist. The computer's own timed period never applies remotely.
//   Readonly targets refuse changes before anything is queued, whatever the
//   trust. run_as=root sends run_as "root" with process_exec and fs_write
//   (bound into the approval); it needs the computer's sudo setting for the
//   host ('sudoers'), which the computer checks again before using sudo -n.
// - Personal hosts stay personal: only the user who owns the computer sees
//   its targets, and only that user can approve their commands.
// - Every call is written to audit_logs (target, tool, decision, outcome;
//   never command text, file contents or output).

import crypto from "node:crypto";
import { roleAtLeast, type Principal } from "./auth.js";
import { db } from "./db.js";
import { redactSecrets } from "./security.js";
import { safetyNetCheck } from "./safety-net.js";
import { sshAllowlistMatch } from "./command-allowlist.js";
import { DOCKER_LOG_LINES_MAX, dockerContainerSchema, dockerDaemonSchema, dockerSinceSchema } from "./protocol.js";

/** Tools an SSH target supports (the rest answer unsupported_for_target). */
export const SSH_TARGET_TOOLS = [
  "process_exec", "fs_list", "fs_read", "fs_stat", "server_overview", "server_disk_usage", "server_processes",
  "fs_write", "fs_mkdir", "fs_move", "fs_delete",
  // The server tools of agent devices, run with the same wc-server scripts
  // over SSH from the person's computer.
  "server_cleanup_scan", "server_cleanup_run", "server_process_signal",
  "server_timers_list", "docker_containers_list", "docker_container_logs", "docker_container_action",
] as const;
const SSH_TOOLS = new Set<string>(SSH_TARGET_TOOLS);
/** Commands, file and server changes: refused on readonly; approval unless the target's trust says otherwise. */
export const SSH_CHANGE_TOOLS = new Set([
  "process_exec", "fs_write", "fs_mkdir", "fs_move", "fs_delete",
  "server_cleanup_run", "server_process_signal", "docker_container_action",
]);

/** Tools that run as root on a target set to run_as root (the rest stay the SSH user). */
export const SSH_ROOT_TOOLS = new Set(["process_exec", "fs_write"]);

/** How long the computer may take for a call, by tool (default 60 s). */
const TOOL_TIMEOUT_MS: Record<string, number> = {
  server_cleanup_scan: 300_000,
  // Each category may take up to 15 minutes (tens of GB of build cache).
  server_cleanup_run: 1_800_000,
  server_timers_list: 180_000,
  docker_containers_list: 180_000,
  docker_container_logs: 120_000,
  docker_container_action: 120_000,
};

/** How long a queued call may run on the computer, in milliseconds. */
export function callTimeoutMs(tool: string, args: Record<string, unknown>) {
  if (tool === "process_exec") return Number(args.timeout_ms);
  return TOOL_TIMEOUT_MS[tool] ?? 60_000;
}

/** A cleanup id from server_cleanup_scan (the agent schema's pattern). */
const CLEANUP_ID = /^[a-z-]{2,40}(@u[0-9]{1,10})?$/;
/** Docker daemons (system or u<uid>) and container ids or names: the same
 *  schemas as agent devices (protocol.ts, wc_server::containers). */
const DOCKER_DAEMON = { test: (s: string) => dockerDaemonSchema.safeParse(s).success };
const CONTAINER_REF = { test: (s: string) => dockerContainerSchema.safeParse(s).success };
export const DOCKER_LOG_TAIL_DEFAULT = 200;
export const DOCKER_LOG_TAIL_MAX = DOCKER_LOG_LINES_MAX;

/** `container` (ref or ref@u<uid>) and `daemon` as one daemon and one ref. */
function dockerTarget(a: Record<string, any>): { daemon: string; container: string } | null {
  let ref = str(a.container).trim().replace(/^\//, "");
  let suffix: string | null = null;
  const at = ref.indexOf("@");
  if (at >= 0) { suffix = ref.slice(at + 1); ref = ref.slice(0, at); }
  const given = a.daemon === undefined || a.daemon === null || str(a.daemon).trim() === "" ? null : str(a.daemon).trim();
  if (suffix !== null && given !== null && suffix !== given) return null;
  const daemon = suffix ?? given ?? "system";
  if (!DOCKER_DAEMON.test(daemon) || !CONTAINER_REF.test(ref)) return null;
  return { daemon, container: ref };
}

/** A computer that polled within this many seconds is online. */
export const CONNECTOR_ONLINE_SECONDS = 45;
/** How long a queued call waits for the computer to pick it up. */
const CLAIM_WITHIN_MS = Number(process.env.CONNECTOR_CLAIM_WITHIN_MS || 20_000);
const POLL_MS = 250;
/** Remote reads are capped (results travel back through the gateway). */
export const MAX_REMOTE_READ = 1024 * 1024;
export const MAX_REMOTE_WRITE = 1024 * 1024;
const MAX_TARGETS = 200;

export const OFFLINE_MESSAGE =
  "Bu sunucuya erişen bilgisayar şu an kapalı ya da WECOMMANDER orada açık değil. " +
  "The computer that reaches this server is off or WECOMMANDER is not running on it: " +
  "ask the person to open WECOMMANDER on that computer, then try again.";

export function sshTargetId(centerId: string, hostId: string) {
  return "ssh-" + crypto.createHash("sha256").update(`${centerId}:${hostId}`).digest("hex").slice(0, 24);
}

export function isSshTargetId(value: unknown): value is string {
  return typeof value === "string" && /^ssh-[0-9a-f]{24}$/.test(value);
}

export type PublishedTarget = {
  hostId: string;
  name: string;
  preset: "readonly" | "approval";
  sudo: "never" | "sudoers";
};

/** Validates what an app publishes; null when it is not acceptable. */
export function parseTargets(body: unknown): PublishedTarget[] | null {
  const list = (body as { targets?: unknown })?.targets;
  if (!Array.isArray(list) || list.length > MAX_TARGETS) return null;
  const out: PublishedTarget[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const t = item as Record<string, unknown>;
    const hostId = typeof t.hostId === "string" ? t.hostId.trim() : "";
    const name = typeof t.name === "string" ? t.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "";
    // "timed" is local only: a remote change always needs an approval.
    const preset = t.preset === "readonly" ? "readonly" : t.preset === "approval" || t.preset === "timed" ? "approval" : null;
    const sudo = t.sudo === "sudoers" ? "sudoers" : t.sudo === "never" || t.sudo === undefined ? "never" : null;
    if (!hostId || hostId.length > 200 || !name || !preset || !sudo || seen.has(hostId)) return null;
    seen.add(hostId);
    out.push({ hostId, name, preset, sudo });
  }
  return out;
}

export type SshTrust = "strict" | "standard" | "full";
export type TargetRow = {
  target_id: string; center_id: string; host_id: string; name: string; preset: string; sudo: string;
  center_name: string; online: boolean;
  /** Effective trust (an expired full is standard). Absent on old rows: standard. */
  trust?: SshTrust;
  trust_full_until?: Date | null;
  run_as?: "user" | "root";
  safety_net?: boolean;
  safety_net_allow_power?: boolean;
};

/** The SQL of a target's effective AI permissions (alias t). */
export const SSH_PERMISSION_COLUMNS =
  `case when t.trust_level='full' and t.trust_full_until is not null and t.trust_full_until<=now()
        then 'standard' else t.trust_level end as trust,
   case when t.trust_level='full' then t.trust_full_until else null end as trust_full_until,
   t.run_as,t.safety_net,t.safety_net_allow_power`;

/** Root is possible only while the computer allows sudo for AI on this host. */
export function sshRootCapable(row: Pick<TargetRow, "sudo">) {
  return row.sudo === "sudoers";
}

/** The user an MCP principal acts for (OAuth/session/center, or the creator of an API token). */
export async function principalUserId(principal: Principal): Promise<string | null> {
  if (principal.userId) return principal.userId;
  const token = /^token:([0-9a-f-]{36})$/i.exec(principal.actor);
  if (!token) return null;
  const row = await db.query<{ created_by: string }>(
    "select created_by from api_tokens where id=$1 and organization_id=$2 and revoked_at is null",
    [token[1], principal.organizationId],
  );
  const by = /^user:([0-9a-f-]{36})$/i.exec(row.rows[0]?.created_by ?? "");
  return by ? by[1]! : null;
}

/** SSH targets this principal may see: published by the computers of the same user. */
export async function listSshTargets(principal: Principal): Promise<TargetRow[]> {
  const userId = await principalUserId(principal);
  if (!userId) return [];
  const result = await db.query<TargetRow>(
    `select t.target_id,t.center_id,t.host_id,t.name,t.preset,t.sudo,c.name as center_name,
            coalesce(c.connector_seen_at > now() - ($3::int * interval '1 second'), false) as online,
            ${SSH_PERMISSION_COLUMNS}
       from connector_targets t
       join management_centers c on c.id=t.center_id and c.revoked_at is null
      where t.organization_id=$1 and c.user_id=$2
      order by t.name, t.target_id`,
    [principal.organizationId, userId, CONNECTOR_ONLINE_SECONDS],
  );
  return result.rows;
}

/** targets_list: agent devices and SSH targets, never an address or credential. */
export function targetView(row: TargetRow) {
  const readonly = row.preset === "readonly";
  return {
    target_id: row.target_id,
    name: row.name,
    kind: "ssh" as const,
    online: row.online,
    via: `${row.center_name} (WECOMMANDER on the person's computer)`,
    capabilities: { exec: !readonly, read: true, write: !readonly, terminal: false, persistent_tasks: false, path_policy: "none" },
    preset: row.preset,
    sudo: row.sudo,
    trust: row.trust ?? "standard",
    ...(row.trust === "full" ? { trust_full_until: row.trust_full_until ?? null } : {}),
    run_as: row.run_as === "root" && sshRootCapable(row) ? "root" as const : "user" as const,
    root_capable: sshRootCapable(row),
    safety_net: row.safety_net !== false,
    tools: [...SSH_TARGET_TOOLS],
  };
}

/** PUT /api/center/connector/targets: replaces what this computer publishes. */
export async function publishTargets(organizationId: string, centerId: string, targets: PublishedTarget[]) {
  const client = await db.connect();
  try {
    await client.query("begin");
    // run_as root needs the computer's sudo setting for that host: a host
    // published without it returns to user (audited, like a device whose
    // agent stopped reporting root_capable).
    const noSudo = targets.filter((t) => t.sudo !== "sudoers").map((t) => t.hostId);
    const fallback = await client.query<{ target_id: string; name: string }>(
      `update connector_targets set run_as='user',updated_at=now()
        where center_id=$1 and run_as='root' and host_id = any($2::text[])
        returning target_id,name`,
      [centerId, noSudo],
    );
    for (const row of fallback.rows) {
      await client.query(
        "insert into audit_logs(organization_id,actor,device_id,tool,risk,outcome,detail) values($1,'system',null,'ssh_target.run_as','high','fallback',$2)",
        [organizationId, JSON.stringify({ target: row.target_id, targetLabel: row.name, runAs: "user", reason: "sudo_not_allowed_on_computer" })],
      );
    }
    await client.query("update management_centers set connector_seen_at=now() where id=$1", [centerId]);
    await client.query(
      "delete from connector_targets where center_id=$1 and not (host_id = any($2::text[]))",
      [centerId, targets.map((t) => t.hostId)],
    );
    for (const t of targets) {
      await client.query(
        `insert into connector_targets(organization_id,center_id,host_id,target_id,name,preset,sudo)
         values($1,$2,$3,$4,$5,$6,$7)
         on conflict (center_id,host_id) do update
           set name=excluded.name,preset=excluded.preset,sudo=excluded.sudo,updated_at=now()`,
        [organizationId, centerId, t.hostId, sshTargetId(centerId, t.hostId), t.name, t.preset, t.sudo],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return targets.map((t) => ({ hostId: t.hostId, targetId: sshTargetId(centerId, t.hostId) }));
}

export type ClaimedCall = { id: string; hostId: string; tool: string; args: Record<string, unknown>; approved: boolean; client: string };

/** GET /api/center/connector/claim: waits up to `waitMs` for calls queued for this computer. */
export async function claimCalls(organizationId: string, centerId: string, waitMs: number): Promise<ClaimedCall[]> {
  const end = Date.now() + Math.max(0, Math.min(waitMs, 15_000));
  for (;;) {
    await db.query("update management_centers set connector_seen_at=now() where id=$1", [centerId]);
    const claimed = await db.query<{ id: string; host_id: string; tool: string; args: Record<string, unknown>; approved: boolean; client: string }>(
      `update connector_calls set status='running',claimed_at=now()
        where id in (select id from connector_calls
                      where organization_id=$1 and center_id=$2 and status='queued' and claim_by>now()
                      order by created_at for update skip locked limit 8)
        returning id,host_id,tool,args,approved,client`,
      [organizationId, centerId],
    );
    if (claimed.rowCount || Date.now() >= end) {
      return claimed.rows.map((r) => ({ id: r.id, hostId: r.host_id, tool: r.tool, args: r.args, approved: r.approved, client: r.client }));
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export type CallResult = { ok: true; result: unknown } | { ok: false; error: string; message: string };

export function parseResult(body: unknown): CallResult | null {
  const b = body as Record<string, unknown>;
  if (b?.ok === true) return { ok: true, result: b.result ?? null };
  if (b?.ok === false && typeof b.error === "string" && /^[a-z_]{1,64}$/.test(b.error)) {
    return { ok: false, error: b.error, message: typeof b.message === "string" ? redactSecrets(b.message).slice(0, 500) : "" };
  }
  return null;
}

/** POST /api/center/connector/calls/:id/result: only for a running call of this computer. */
export async function finishCall(organizationId: string, centerId: string, callId: string, result: CallResult) {
  const updated = await db.query(
    `update connector_calls set status='done',result=$4::jsonb,finished_at=now()
      where id=$1 and organization_id=$2 and center_id=$3 and status='running' and deadline>now()`,
    [callId, organizationId, centerId, JSON.stringify(result)],
  );
  return (updated.rowCount ?? 0) > 0;
}

// ---- approvals (approval_requests rows with center_id/target_id) ----------

async function ensureSshApproval(orgId: string, actor: string, row: TargetRow, action: Record<string, unknown>) {
  const json = JSON.stringify(action);
  const existing = await db.query<{ id: string; expires_at: Date }>(
    `select id,expires_at from approval_requests
      where organization_id=$1 and center_id=$2 and target_id=$3 and requested_by=$4 and action=$5::jsonb
        and status='pending' and expires_at>now()
      order by created_at desc limit 1`,
    [orgId, row.center_id, row.target_id, actor, json],
  );
  if (existing.rows[0]) return { ...existing.rows[0], created: false };
  const created = await db.query<{ id: string; expires_at: Date }>(
    `insert into approval_requests(organization_id,device_id,center_id,target_id,target_label,requested_by,action_kind,action,status,expires_at)
     values($1,null,$2,$3,$4,$5,$6,$7::jsonb,'pending',now()+interval '5 minutes')
     returning id,expires_at`,
    [orgId, row.center_id, row.target_id, row.name, actor, String(action.kind), json],
  );
  return { ...created.rows[0]!, created: true };
}

async function consumeSshApproval(orgId: string, actor: string, row: TargetRow, action: Record<string, unknown>) {
  const result = await db.query<{ id: string }>(
    `with candidate as (
       select id from approval_requests
        where organization_id=$1 and center_id=$2 and target_id=$3 and requested_by=$4 and action=$5::jsonb
          and status='approved' and consumed_at is null and expires_at>now()
        order by decided_at desc nulls last, created_at desc
        for update skip locked limit 1)
     update approval_requests r
        set status='consumed',consumed_at=now(),action=jsonb_build_object('kind',r.action_kind,'redacted',true)
       from candidate where r.id=candidate.id and r.status='approved' and r.consumed_at is null
     returning r.id`,
    [orgId, row.center_id, row.target_id, actor, JSON.stringify(action)],
  );
  return result.rows[0]?.id ?? null;
}

/** A consumed approval whose call never reached the computer is given back (like device-offline). */
async function restoreSshApproval(orgId: string, requestId: string, action: Record<string, unknown>) {
  await db.query(
    `update approval_requests set status='approved',consumed_at=null,action=$3::jsonb
      where id=$1 and organization_id=$2 and status='consumed' and expires_at>now()`,
    [requestId, orgId, JSON.stringify(action)],
  );
}

// ---- the MCP side -----------------------------------------------------------

type ToolOutcome = { data: unknown; isError: boolean };
type Audit = (tool: string, risk: string, outcome: string, detail: Record<string, unknown>) => Promise<void>;

const err = (error: string, message: string, extra: Record<string, unknown> = {}): ToolOutcome =>
  ({ data: { error, message, ...extra }, isError: true });

function str(v: unknown) {
  return typeof v === "string" ? v : "";
}
function cleanPath(v: unknown) {
  const p = str(v).trim();
  return p && p.length <= 4096 && !/[\u0000-\u001f]/.test(p) ? p : null;
}
function sha(v: unknown) {
  const s = str(v).trim().toLowerCase();
  return s ? (/^[0-9a-f]{64}$/.test(s) ? s : undefined) : null;
}

/**
 * The arguments sent to the computer and, for changes, the exact operation
 * the approval is bound to (a written file by its size and SHA-256).
 */
export function normalize(tool: string, a: Record<string, any>, targetId: string):
  { args: Record<string, unknown>; action: Record<string, unknown> | null } | { error: string; message: string } {
  const bad = (message: string) => ({ error: "invalid_arguments", message });
  switch (tool) {
    case "process_exec": {
      const command = str(a.command);
      if (!command.trim() || command.length > 8000) return bad("command must be 1-8000 characters");
      const cwd = a.cwd === undefined || a.cwd === null || str(a.cwd).trim() === "" ? null : cleanPath(a.cwd);
      if (cwd === null && a.cwd !== undefined && a.cwd !== null && str(a.cwd).trim() !== "") return bad("cwd is not a valid folder");
      const raw = Number(a.timeout_ms ?? 30_000);
      const timeoutMs = Number.isFinite(raw) ? Math.min(600_000, Math.max(1000, Math.floor(raw))) : 30_000;
      return {
        args: { command, ...(cwd ? { cwd } : {}), timeout_ms: timeoutMs },
        action: { kind: "process_exec", target: targetId, command, cwd, timeoutMs },
      };
    }
    case "fs_write": {
      const path = cleanPath(a.path);
      if (!path) return bad("path is not valid");
      const encoded = str(a.content_base64);
      if (encoded.length > Math.ceil(MAX_REMOTE_WRITE / 3) * 4 + 4) {
        return { error: "file_too_large", message: "at most 1 MiB can be written remotely at once" };
      }
      const content = Buffer.from(encoded, "base64");
      if (content.toString("base64").replace(/=+$/, "") !== encoded.trim().replace(/=+$/, "")) return bad("content_base64 is not valid base64");
      if (content.length > MAX_REMOTE_WRITE) return { error: "file_too_large", message: "at most 1 MiB can be written remotely at once" };
      const expected = sha(a.expected_sha256);
      if (expected === undefined) return bad("expected_sha256 must be 64 hex characters");
      const createParents = a.create_parents === true;
      return {
        args: { path, content_base64: content.toString("base64"), create_parents: createParents, ...(expected ? { expected_sha256: expected } : {}) },
        action: {
          kind: "fs_write", target: targetId, path, size: content.length,
          sha256: crypto.createHash("sha256").update(content).digest("hex"), createParents, expectedSha256: expected,
        },
      };
    }
    case "fs_mkdir": {
      const path = cleanPath(a.path);
      if (!path) return bad("path is not valid");
      const recursive = a.recursive === true;
      return { args: { path, recursive }, action: { kind: "fs_mkdir", target: targetId, path, recursive } };
    }
    case "fs_move": {
      const source = cleanPath(a.source);
      const destination = cleanPath(a.destination);
      if (!source || !destination) return bad("source and destination must be valid paths");
      return { args: { source, destination }, action: { kind: "fs_move", target: targetId, source, destination } };
    }
    case "fs_delete": {
      const path = cleanPath(a.path);
      if (!path) return bad("path is not valid");
      const recursive = a.recursive === true;
      const expected = sha(a.expected_sha256);
      if (expected === undefined) return bad("expected_sha256 must be 64 hex characters");
      return {
        args: { path, recursive, ...(expected ? { expected_sha256: expected } : {}) },
        action: { kind: "fs_delete", target: targetId, path, recursive, expectedSha256: expected },
      };
    }
    case "fs_list":
    case "fs_stat":
      return { args: { path: str(a.path).slice(0, 4096) }, action: null };
    case "fs_read": {
      const raw = Number(a.max_bytes ?? MAX_REMOTE_READ);
      const maxBytes = Number.isFinite(raw) ? Math.min(MAX_REMOTE_READ, Math.max(1, Math.floor(raw))) : MAX_REMOTE_READ;
      return { args: { path: str(a.path).slice(0, 4096), max_bytes: maxBytes }, action: null };
    }
    case "server_disk_usage":
      return { args: a.path === undefined ? {} : { path: str(a.path).slice(0, 4096) }, action: null };
    case "server_cleanup_run": {
      const ids = a.ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || !ids.every((id) => typeof id === "string" && CLEANUP_ID.test(id))) {
        return bad("ids must be 1-20 category ids from server_cleanup_scan");
      }
      return { args: { ids: [...ids] }, action: { kind: "server_cleanup_run", target: targetId, ids: [...ids] } };
    }
    case "server_process_signal": {
      const pid = a.pid;
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 2 || pid > 4194304) return bad("pid must be a process id (2-4194304)");
      const name = str(a.name);
      if (!name || name.length > 64 || /[\n\0]/.test(name)) return bad("name must be the process name from server_processes");
      const action = a.action;
      if (action !== "reap" && action !== "term" && action !== "kill") return bad("action must be reap, term or kill");
      const confirmDatabase = a.confirm_database === true;
      return {
        args: { pid, name, action, confirm_database: confirmDatabase },
        action: { kind: "server_process_signal", target: targetId, pid, name, action, confirmDatabase },
      };
    }
    case "docker_containers_list": {
      if (a.daemon === undefined || a.daemon === null || str(a.daemon).trim() === "") return { args: {}, action: null };
      const daemon = str(a.daemon).trim();
      if (!DOCKER_DAEMON.test(daemon)) return bad("daemon must be system or u<uid>");
      return { args: { daemon }, action: null };
    }
    case "docker_container_logs": {
      const t = dockerTarget(a);
      if (!t) return bad("container must be an id or name from docker_containers_list (id@u<uid> or daemon for a rootless one)");
      let tail = DOCKER_LOG_TAIL_DEFAULT;
      if (a.tail !== undefined && a.tail !== null) {
        if (typeof a.tail !== "number" || !Number.isInteger(a.tail) || a.tail < 1 || a.tail > DOCKER_LOG_TAIL_MAX) return bad("tail must be 1-2000");
        tail = a.tail;
      }
      if (a.since === undefined || a.since === null) return { args: { ...t, tail }, action: null };
      if (typeof a.since !== "string" || !dockerSinceSchema.safeParse(a.since).success) {
        return bad("since must be a duration like 10m, a Unix time or an RFC 3339 time");
      }
      return { args: { ...t, tail, since: a.since }, action: null };
    }
    case "docker_container_action": {
      const t = dockerTarget(a);
      if (!t) return bad("container must be an id or name from docker_containers_list (id@u<uid> or daemon for a rootless one)");
      const action = a.action;
      if (action !== "start" && action !== "stop" && action !== "restart") return bad("action must be start, stop or restart");
      return { args: { ...t, action }, action: { kind: "docker_container_action", target: targetId, ...t, action } };
    }
    default:
      return { args: {}, action: null };
  }
}

function maskOutput(data: unknown): unknown {
  if (data && typeof data === "object" && typeof (data as any).output === "string") {
    return { ...(data as object), output: redactSecrets((data as any).output) };
  }
  return data;
}

/** A tools/call whose target is an SSH target. */
export async function sshTargetCall(principal: Principal, tool: string, rawArgs: Record<string, any>, targetId: string, audit: Audit): Promise<ToolOutcome> {
  const risk = SSH_CHANGE_TOOLS.has(tool) ? "high" : "low";
  if (!SSH_TOOLS.has(tool)) {
    await audit(tool, risk, "denied", { target: targetId, reason: "unsupported_for_target" });
    return err("unsupported_for_target",
      `${tool} is not available on SSH targets (SSH targets support: ${SSH_TARGET_TOOLS.join(", ")}). Install the WECOMMANDER agent on the server for more.`);
  }
  const row = (await listSshTargets(principal)).find((t) => t.target_id === targetId);
  if (!row) {
    await audit(tool, risk, "denied", { target: targetId, reason: "target_not_found" });
    return err("target_not_found", "No such target for this account (see targets_list). The person may have turned remote AI access off.");
  }
  const where = { target: row.target_id, targetLabel: row.name, centerId: row.center_id };
  const requiredRole = risk === "low" ? "viewer" : "operator";
  if (!roleAtLeast(principal, requiredRole)) {
    await audit(tool, risk, "denied", { ...where, reason: `role_${requiredRole}_required` });
    return err("forbidden", `this needs the ${requiredRole} role`, { required_role: requiredRole });
  }
  const normalized = normalize(tool, rawArgs, row.target_id);
  if ("error" in normalized) {
    await audit(tool, risk, "denied", { ...where, reason: normalized.error });
    return err(normalized.error, normalized.message);
  }
  if (normalized.action && row.preset === "readonly") {
    await audit(tool, risk, "denied", { ...where, reason: "readonly_preset" });
    return err("readonly_preset", "This server is read-only for AI: commands, file changes and server changes are off. The person can change it in WECOMMANDER (server → AI access).");
  }
  // Safety net (safety-net.ts): the same short hard-deny list as on agent
  // devices, whatever the trust, run_as or an approval says.
  if (tool === "process_exec" && row.safety_net !== false) {
    const hit = safetyNetCheck(String(normalized.args.command), { allowPower: row.safety_net_allow_power === true });
    if (hit) {
      await audit(tool, risk, "denied", { ...where, reason: "safety_net", rule: hit.rule, runAs: row.run_as ?? "user" });
      return err("safety_net_blocked",
        `Refused by this server's safety net: ${hit.reason}. The owner can switch the safety net off for this server in the WECOMMANDER web panel (Devices > AI permissions).`,
        { rule: hit.rule });
    }
  }
  // run_as root: run_as "root" travels with the call and is part of the
  // approved action; the computer runs it through sudo -n only if its own
  // sudo setting for this host allows it.
  let args = normalized.args;
  let action = normalized.action;
  const runAs = row.run_as === "root" && SSH_ROOT_TOOLS.has(tool) ? "root" : "user";
  if (runAs === "root") {
    if (!sshRootCapable(row)) {
      await audit(tool, risk, "denied", { ...where, reason: "run_as_root_unavailable" });
      return err("run_as_root_unavailable",
        "This server is set to run as root, but the computer that reaches it does not allow sudo for AI on it (WECOMMANDER → server → AI access → sudo). Ask the owner to set run as: user, or to allow sudo there.");
    }
    args = { ...args, run_as: "root" };
    if (action) action = { ...action, runAs: "root" };
  }
  if (!row.online) {
    await audit(tool, risk, "error", { ...where, reason: "connector_offline" });
    return err("connector_offline", OFFLINE_MESSAGE);
  }

  let approvalId: string | null = null;
  let preApproved = false;
  const trust: SshTrust = row.trust ?? "standard";
  if (action && trust === "full") {
    // Full trust for this target: no per-call approval (readonly, the
    // safety net and the computer's own checks still apply).
    preApproved = true;
    await audit(tool, risk, "trusted_full", { ...where, kind: tool, runAs });
  } else if (action && tool === "process_exec" && trust === "standard") {
    const allowed = await sshAllowlistMatch(principal.organizationId, row.center_id, row.host_id, String(args.command));
    if (allowed) {
      preApproved = true;
      await audit(tool, risk, "allowlisted", { ...where, allowlistId: allowed.id, pattern: allowed.pattern, runAs });
    }
  }
  if (action && !preApproved) {
    approvalId = await consumeSshApproval(principal.organizationId, principal.actor, row, action);
    if (!approvalId) {
      const pending = await ensureSshApproval(principal.organizationId, principal.actor, row, action);
      await audit(tool, risk, "approval_pending", { ...where, approvalRequestId: pending.id });
      return err("approval_required",
        "The person must approve this exact operation first (WECOMMANDER app notification or wecommander.app → Approvals), then retry the identical call. The approval is single use and expires in 5 minutes.",
        { action: tool, approval_request_id: pending.id, approval_expires_at: pending.expires_at });
    }
    await audit(tool, risk, "approval_consumed", { ...where, approvalRequestId: approvalId, runAs });
  }

  const timeoutMs = callTimeoutMs(tool, args);
  const inserted = await db.query<{ id: string }>(
    `insert into connector_calls(organization_id,center_id,host_id,target_id,tool,args,approved,client,claim_by,deadline)
     values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,now()+($9::int * interval '1 millisecond'),now()+($10::int * interval '1 millisecond'))
     returning id`,
    [principal.organizationId, row.center_id, row.host_id, row.target_id, tool,
     JSON.stringify({ ...args, target: row.host_id }), approvalId !== null || preApproved,
     (principal.oauthClientKind || principal.actor).slice(0, 100), CLAIM_WITHIN_MS, CLAIM_WITHIN_MS + timeoutMs + 30_000],
  );
  const callId = inserted.rows[0]!.id;

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const state = await db.query<{ status: string; result: CallResult | null; unclaimed: boolean; late: boolean }>(
      `select status,result,(status='queued' and claim_by<=now()) as unclaimed,(deadline<=now()) as late
         from connector_calls where id=$1`,
      [callId],
    );
    const s = state.rows[0];
    if (!s) return err("connector_error", "the call was lost; try again");
    if (s.status === "done" && s.result) {
      // Nothing of the call (command, content, output) is kept once answered.
      await db.query("delete from connector_calls where id=$1", [callId]);
      const r = s.result;
      if (r.ok) {
        await audit(tool, risk, "success", { ...where, ...(approvalId ? { approvalRequestId: approvalId } : {}) });
        return { data: maskOutput(r.result), isError: false };
      }
      await audit(tool, risk, "error", { ...where, reason: r.error });
      return err(r.error, r.message);
    }
    if (s.unclaimed) {
      const expired = await db.query("delete from connector_calls where id=$1 and status='queued' returning id", [callId]);
      if (expired.rowCount) {
        if (approvalId && action) await restoreSshApproval(principal.organizationId, approvalId, action);
        await audit(tool, risk, "error", { ...where, reason: "connector_offline", ...(approvalId ? { approvalRestored: approvalId } : {}) });
        return err("connector_offline", OFFLINE_MESSAGE, approvalId ? { approval_request_id: approvalId } : {});
      }
      continue;
    }
    if (s.late) {
      await db.query("delete from connector_calls where id=$1", [callId]);
      await audit(tool, risk, "error", { ...where, reason: "connector_timeout" });
      return err("connector_timeout", "The computer did not answer in time; the operation may or may not have run. Check before retrying.");
    }
  }
}
