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
// - Every command and file change needs the person's one-time approval here
//   (approval_requests bound to client, target and the exact arguments,
//   5 minutes, single use); a timed period never applies remotely. Readonly
//   targets refuse changes before anything is queued.
// - Personal hosts stay personal: only the user who owns the computer sees
//   its targets, and only that user can approve their commands.
// - Every call is written to audit_logs (target, tool, decision, outcome;
//   never command text, file contents or output).

import crypto from "node:crypto";
import { roleAtLeast, type Principal } from "./auth.js";
import { db } from "./db.js";
import { redactSecrets } from "./security.js";

/** Tools an SSH target supports (the rest answer unsupported_for_target). */
export const SSH_TARGET_TOOLS = [
  "process_exec", "fs_list", "fs_read", "fs_stat", "server_overview", "server_disk_usage", "server_processes",
  "fs_write", "fs_mkdir", "fs_move", "fs_delete",
] as const;
const SSH_TOOLS = new Set<string>(SSH_TARGET_TOOLS);
/** Commands and file changes: approval every time, refused on readonly. */
export const SSH_CHANGE_TOOLS = new Set(["process_exec", "fs_write", "fs_mkdir", "fs_move", "fs_delete"]);

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

export type TargetRow = {
  target_id: string; center_id: string; host_id: string; name: string; preset: string; sudo: string;
  center_name: string; online: boolean;
};

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
            coalesce(c.connector_seen_at > now() - ($3::int * interval '1 second'), false) as online
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
    tools: [...SSH_TARGET_TOOLS],
  };
}

/** PUT /api/center/connector/targets: replaces what this computer publishes. */
export async function publishTargets(organizationId: string, centerId: string, targets: PublishedTarget[]) {
  const client = await db.connect();
  try {
    await client.query("begin");
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
    return err("readonly_preset", "This server is read-only for AI: commands and file changes are off. The person can change it in WECOMMANDER (server → AI access).");
  }
  if (!row.online) {
    await audit(tool, risk, "error", { ...where, reason: "connector_offline" });
    return err("connector_offline", OFFLINE_MESSAGE);
  }

  let approvalId: string | null = null;
  if (normalized.action) {
    approvalId = await consumeSshApproval(principal.organizationId, principal.actor, row, normalized.action);
    if (!approvalId) {
      const pending = await ensureSshApproval(principal.organizationId, principal.actor, row, normalized.action);
      await audit(tool, risk, "approval_pending", { ...where, approvalRequestId: pending.id });
      return err("approval_required",
        "The person must approve this exact operation first (WECOMMANDER app notification or wecommander.app → Approvals), then retry the identical call. The approval is single use and expires in 5 minutes.",
        { action: tool, approval_request_id: pending.id, approval_expires_at: pending.expires_at });
    }
    await audit(tool, risk, "approval_consumed", { ...where, approvalRequestId: approvalId });
  }

  const timeoutMs = tool === "process_exec" ? Number((normalized.args as any).timeout_ms) : 60_000;
  const inserted = await db.query<{ id: string }>(
    `insert into connector_calls(organization_id,center_id,host_id,target_id,tool,args,approved,client,claim_by,deadline)
     values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,now()+($9::int * interval '1 millisecond'),now()+($10::int * interval '1 millisecond'))
     returning id`,
    [principal.organizationId, row.center_id, row.host_id, row.target_id, tool,
     JSON.stringify({ ...normalized.args, target: row.host_id }), approvalId !== null,
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
        if (approvalId && normalized.action) await restoreSshApproval(principal.organizationId, approvalId, normalized.action);
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
