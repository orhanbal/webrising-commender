import crypto from "node:crypto";
import type { AgentAction, SearchProgress } from "./protocol.js";
import type { DeviceRouter } from "./device-router.js";
import type { Principal } from "./auth.js";
import type { SearchPersistence, SearchRecoveryCandidate } from "./search-persistence.js";
import { isNativeContentCheckpoint, isNativeFilenameCheckpoint } from "./search-checkpoint.js";
import type { NativeContentCheckpoint, NativeFilenameCheckpoint } from "./search-checkpoint.js";

/**
 * Bounded, tenant/actor-isolated search sessions.
 * Native file/content scanning publishes bounded incremental pages while
 * the agent is running (direct Relay/Gateway route). Completed results remain
 * the authoritative final snapshot; remote regional relays use final snapshots.
 */
type SearchEntry = {
  id: string;
  organizationId: string;
  actor: string;
  deviceId: string;
  path: string;
  query: string;
  searchType: "files" | "content";
  createdAt: number;
  status: "running" | "completed" | "error" | "stopped";
  items: unknown[];
  truncated: boolean;
  timedOut: boolean;
  paused: boolean;
  controlPending: boolean;
  scannedEntries: number;
  scannedBytes: number;
  progressUpdates: number;
  /** A stopped search still occupies its native execution slot until its request settles. */
  inFlight: boolean;
  controller: AbortController;
  error?: string;
};
const MAX_SESSIONS = 64;
const PER_ACTOR_LIMIT = 8;
const TTL_MS = 5 * 60_000;
const sessions = new Map<string, SearchEntry>();
let persistence: SearchPersistence | undefined;
export function setSearchPersistence(store: SearchPersistence | undefined) { persistence = store; }

function expire(now = Date.now()) {
  for (const [id, s] of sessions) {
    if (!s.inFlight && now - s.createdAt > TTL_MS) sessions.delete(id);
  }
}
function safeSearchError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  // Native errors can include filenames or file contents. Never echo them into
  // session summaries or a model's tool result.
  const allowed = new Set([
    "device-offline", "device-request-timeout", "device-request-limit",
    "gateway-overloaded", "relay_request_failed",
  ]);
  return allowed.has(code) ? code : "search_failed";
}
/** Keep final native results within the same durable 1 MiB / 500 item
 * boundary even when PostgreSQL is disabled. Preserve an ordered prefix,
 * and never report a silently shortened result as complete. */
function boundFinalSearchItems(value: unknown): { items: unknown[]; truncated: boolean } {
  const source = Array.isArray(value) ? value : [];
  let items = source.slice(0, 500);
  let truncated = source.length > items.length;
  if (Buffer.byteLength(JSON.stringify(items), "utf8") > 1024 * 1024) {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(JSON.stringify(items.slice(0, middle)), "utf8") <= 1024 * 1024) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    items = items.slice(0, low);
    truncated = true;
  }
  return { items, truncated };
}
function isCheckpointFor(
  searchType: "files" | "content", value: unknown,
): value is NativeFilenameCheckpoint | NativeContentCheckpoint {
  return searchType === "files"
    ? isNativeFilenameCheckpoint(value)
    : isNativeContentCheckpoint(value);
}
function owner(s: SearchEntry, p: Principal, deviceId: string) {
  return s.organizationId === p.organizationId && s.actor === p.actor && s.deviceId === deviceId;
}
function summary(s: SearchEntry) {
  return {
    searchId: s.id,
    path: s.path,
    query: s.query,
    searchType: s.searchType,
    status: s.status,
    createdAt: new Date(s.createdAt).toISOString(),
    resultCount: s.items.length,
    paused: s.status === "running" && s.paused,
    scannedEntries: s.scannedEntries,
    scannedBytes: s.scannedBytes,
    progressUpdates: s.progressUpdates,
    truncated: s.truncated,
    timedOut: s.timedOut,
    ...(s.error ? { error: s.error } : {}),
  };
}
export async function startSearch(
  principal: Principal,
  deviceId: string,
  router: DeviceRouter,
  arg: { path: string; query: string; search_type: string; case_sensitive?: boolean; start_paused?: boolean },
  recovery?: SearchRecoveryCandidate,
) {
  expire();
  if (typeof arg.path !== "string" || !arg.path || arg.path.length > 4096 ||
      typeof arg.query !== "string" || !arg.query.trim() ||
      arg.query.length > 1024 || Buffer.byteLength(arg.query, "utf8") > 1024 ||
      !["files", "content"].includes(arg.search_type) ||
      (arg.case_sensitive !== undefined && typeof arg.case_sensitive !== "boolean") ||
      (arg.start_paused !== undefined && typeof arg.start_paused !== "boolean")) {
    throw new Error("invalid_search_arguments");
  }
  if (recovery && (
      recovery.organizationId !== principal.organizationId ||
      recovery.actor !== principal.actor || recovery.deviceId !== deviceId ||
      recovery.searchType !== arg.search_type ||
      recovery.path !== arg.path || recovery.query !== arg.query ||
      !isCheckpointFor(recovery.searchType, recovery.checkpoint) ||
      recovery.checkpoint.query !== arg.query ||
      recovery.checkpoint.root !== arg.path ||
      recovery.checkpoint.caseSensitive !== Boolean(arg.case_sensitive))) {
    throw new Error("invalid_search_checkpoint");
  }
  // Only active native requests consume concurrency slots. Completed searches
  // must not block the actor for the entire result-retention TTL. A stopped
  // search remains in-flight until the agent settles: stop_search currently
  // suppresses results but does not physically cancel native scanning.
  // A single actor cannot bypass the native scan quota by switching devices.
  // Keep tenant scoping: actors with the same ID in distinct organizations
  // must not consume one another's slots.
  const matches = [...sessions.values()].filter(s =>
    s.organizationId === principal.organizationId &&
    s.actor === principal.actor && s.inFlight);
  // Evict the oldest settled snapshots only if the global retention cap is hit.
  // Never evict active scans to admit more concurrent work.
  if (sessions.size >= MAX_SESSIONS) {
    for (const [id, session] of sessions) {
      if (sessions.size < MAX_SESSIONS) break;
      if (!session.inFlight) sessions.delete(id);
    }
  }
  if (matches.length >= PER_ACTOR_LIMIT || sessions.size >= MAX_SESSIONS) {
    throw new Error("search_session_limit");
  }
  const entry: SearchEntry = {
    id: recovery?.id ?? crypto.randomUUID(),
    organizationId: principal.organizationId,
    actor: principal.actor,
    deviceId,
    path: arg.path,
    query: arg.query,
    searchType: arg.search_type as "files" | "content",
    createdAt: recovery?.createdAt ?? Date.now(),
    status: "running",
    items: recovery && isCheckpointFor(recovery.searchType, recovery.checkpoint)
      ? recovery.checkpoint.items : [],
    truncated: false,
    timedOut: false,
    paused: Boolean(arg.start_paused),
    controlPending: false,
    scannedEntries: recovery && isCheckpointFor(recovery.searchType, recovery.checkpoint)
      ? recovery.checkpoint.scannedEntries : 0,
    scannedBytes: recovery && isNativeContentCheckpoint(recovery.checkpoint)
      ? recovery.checkpoint.scannedBytes : 0,
    progressUpdates: recovery?.progressUpdates ?? 0,
    inFlight: true,
    controller: new AbortController(),
  };
  sessions.set(entry.id, entry);
  if (persistence && !recovery) {
    try {
      await persistence.create(entry);
    } catch (error) {
      sessions.delete(entry.id);
      if (error instanceof Error && error.message === "search_session_limit") throw error;
      throw new Error("search_store_unavailable");
    }
  }
  const action: AgentAction = entry.searchType === "files"
    ? { kind: "fs_search", path: arg.path, query: arg.query,
        caseSensitive: Boolean(arg.case_sensitive), maxResults: 500,
        ...(recovery ? { resumeCheckpoint: recovery.checkpoint } : {}) }
    : { kind: "text_search", path: arg.path, query: arg.query,
        caseSensitive: Boolean(arg.case_sensitive), maxResults: 500,
        ...(recovery ? { resumeCheckpoint: recovery.checkpoint } : {}) };
  // Do not block the MCP request; a follow-up call collects paged results.
  const clearStoppedNativeSlot = async () => {
    try { await persistence?.settleStopped?.(entry); } catch {
      // Keep the conservative database slot until its bounded lease expires.
    }
  };
  const onProgress = (progress: SearchProgress) => {
    if (!entry.inFlight || entry.status !== "running" || entry.paused ||
        entry.controller.signal.aborted) return;
    if (!Array.isArray(progress.items) || progress.items.length > 500 ||
        !Number.isSafeInteger(progress.scannedEntries) || progress.scannedEntries < 0 ||
        !Number.isSafeInteger(progress.scannedBytes) || progress.scannedBytes < 0 ||
        progress.scannedEntries > 100_000 || progress.scannedBytes > 64 * 1024 * 1024 ||
        progress.scannedEntries < entry.scannedEntries ||
        progress.scannedBytes < entry.scannedBytes) return;
    // The hub validates payload size; retain the same limit in this boundary,
    // including when a test or alternate router calls us directly.
    if (Buffer.byteLength(JSON.stringify(progress.items), "utf8") > 1024 * 1024) return;
    const candidate = progress.checkpoint;
    const checkpoint = isCheckpointFor(entry.searchType, candidate) &&
      candidate.root === entry.path &&
      candidate.query === entry.query &&
      candidate.caseSensitive === Boolean(arg.case_sensitive) &&
      candidate.scannedEntries === progress.scannedEntries &&
      (entry.searchType !== "content" ||
        (isNativeContentCheckpoint(candidate) &&
          candidate.scannedBytes === progress.scannedBytes)) &&
      JSON.stringify(candidate.items) === JSON.stringify(progress.items)
      ? candidate : undefined;
    entry.progressUpdates += 1;
    entry.items = progress.items;
    entry.scannedEntries = progress.scannedEntries;
    entry.scannedBytes = progress.scannedBytes;
    if (persistence?.progress) {
      const sequence = entry.progressUpdates;
      void persistence.progress(entry, {
        items: progress.items, scannedEntries: progress.scannedEntries,
        scannedBytes: progress.scannedBytes, sequence,
        ...(checkpoint ? { checkpoint } : {}),
      }).then(() => {
        // A stale out-of-order write can legitimately lose the monotone CAS.
        // Stop/expiry revocation is database-authoritative; never cancel a
        // healthy scanner solely because an older progress write lost the race.
      }).catch(() => {
        if (entry.status === "running" && entry.inFlight) entry.controller.abort();
      });
    }
  };
  void router.request(deviceId, action, undefined, entry.controller.signal, onProgress,
    entry.id, entry.paused).then(async data => {
    entry.inFlight = false;
    if (entry.status !== "running") {
      await clearStoppedNativeSlot();
      return;
    }
    const payload = data as {
      items?: unknown[]; truncated?: boolean; timedOut?: boolean;
      scannedEntries?: number; scannedBytes?: number;
    };
    const bounded = boundFinalSearchItems(payload?.items);
    const candidate = {
      status: "completed" as const,
      items: bounded.items,
      truncated: Boolean(payload?.truncated) || bounded.truncated,
      timedOut: Boolean(payload?.timedOut),
      progressUpdates: entry.progressUpdates,
      // A small native scan can complete before its first progress event.
      // Persist the final counters too; reject forged, negative or regressing
      // values rather than trusting an unvalidated Agent response.
      scannedEntries: typeof payload?.scannedEntries === "number" &&
        Number.isSafeInteger(payload.scannedEntries) &&
        payload.scannedEntries >= entry.scannedEntries &&
        payload.scannedEntries <= 100_000
        ? payload.scannedEntries : entry.scannedEntries,
      scannedBytes: typeof payload?.scannedBytes === "number" &&
        Number.isSafeInteger(payload.scannedBytes) &&
        payload.scannedBytes >= entry.scannedBytes &&
        payload.scannedBytes <= 64 * 1024 * 1024
        ? payload.scannedBytes : entry.scannedBytes,
    };
    try {
      const committed = persistence ? await persistence.finish(entry, candidate) : true;
      if (!committed) {
        // Another Gateway may have stopped or expired this request; never revive results.
        entry.status = "stopped";
        entry.items = [];
        await clearStoppedNativeSlot();
        return;
      }
    } catch {
      if (entry.status === "running") {
        entry.status = "error";
        entry.error = "search_store_unavailable";
      }
      return;
    }
    if (entry.status !== "running") return;
    entry.items = candidate.items;
    entry.truncated = candidate.truncated;
    entry.timedOut = candidate.timedOut;
    entry.scannedEntries = candidate.scannedEntries;
    entry.scannedBytes = candidate.scannedBytes;
    entry.status = "completed";
  }, async error => {
    entry.inFlight = false;
    if (entry.status !== "running") {
      await clearStoppedNativeSlot();
      return;
    }
    const message = safeSearchError(error);
    try {
      const committed = persistence ? await persistence.finish(entry, {
        status: "error", items: [], truncated: false, timedOut: false, error: message,
      }) : true;
      if (!committed) {
        entry.status = "stopped";
        entry.items = [];
        await clearStoppedNativeSlot();
        return;
      }
    } catch {
      if (entry.status === "running") entry.error = "search_store_unavailable";
      return;
    }
    if (entry.status !== "running") return;
    entry.status = "error";
    entry.error = message;
  });
  return summary(entry);
}
let recoveryActive = false;
/** Resume bounded filename scans, or match-free content scans at a completed
 * path boundary. PostgreSQL atomically fences out a dead Gateway first.
 * Checkpoint-free or match-bearing content rows never invent a cursor.
 */
export async function recoverInterruptedSearches(router: DeviceRouter) {
  const store = persistence;
  if (!store?.recoveryCandidates || !store.claimRecovery || recoveryActive) return;
  recoveryActive = true;
  try {
    expire();
    for (const candidate of await store.recoveryCandidates()) {
      if (sessions.has(candidate.id) || sessions.size >= MAX_SESSIONS) continue;
      const checkpoint = candidate.checkpoint;
      if (!isCheckpointFor(candidate.searchType, checkpoint) ||
          checkpoint.query !== candidate.query ||
          checkpoint.root !== candidate.path) continue;
      if (candidate.createdAt + TTL_MS <= Date.now()) continue;
      const activeForActor = [...sessions.values()].filter(s =>
        s.organizationId === candidate.organizationId && s.actor === candidate.actor && s.inFlight);
      if (activeForActor.length >= PER_ACTOR_LIMIT) continue;
      if (!await router.isOnline(candidate.deviceId)) continue;
      const claim = await store.claimRecovery(candidate);
      if (claim === null) continue; // Another Gateway claimed or user stopped.
      // An earlier progress frame can race with recoveryCandidates(). Only the
      // checkpoint returned by the successful owner-fencing CAS is authoritative.
      // Treat an invalid claim as a failed recovery rather than replaying stale
      // candidate data or leaking an acquired native execution slot.
      try {
        if (!isCheckpointFor(candidate.searchType, claim.checkpoint) ||
            claim.checkpoint.query !== candidate.query ||
            claim.checkpoint.root !== candidate.path) {
          throw new Error("invalid_search_checkpoint");
        }
        await startSearch({
          organizationId: candidate.organizationId, actor: candidate.actor,
        } as Principal, candidate.deviceId, router, {
          path: candidate.path, query: candidate.query, search_type: candidate.searchType,
          case_sensitive: claim.checkpoint.caseSensitive,
        }, { ...candidate, checkpoint: claim.checkpoint, progressUpdates: claim.sequence });
      } catch {
        // A post-claim dispatch failure must not strand the native quota.
        await store.finish(candidate, {
          status: "error", items: [], truncated: false, timedOut: false,
          error: "search_recovery_failed",
        }).catch(() => {});
      }
    }
  } finally {
    recoveryActive = false;
  }
}

/** Poll persisted stops to abort native requests started on this Gateway but
 * stopped via another Gateway. Called at a bounded interval by the server.
 * A database outage leaves the native timeout/cancellation budget in force.
 */
export async function reconcileRemoteSearchStops() {
  if (!persistence) return;
  const active = [...sessions.values()].filter(s => s.inFlight && s.status === "running");
  if (active.length === 0) return;
  const stopped = new Set(await persistence.stoppedIds(active.map(s => s.id)));
  for (const s of active) {
    if (!stopped.has(s.id) || s.status !== "running") continue;
    s.status = "stopped";
    s.items = [];
    s.controller.abort();
  }
}

export function searchPage(
  principal: Principal, deviceId: string, searchId: string, offset: number, length: number,
) {
  expire();
  if (!Number.isInteger(offset) || offset < 0 || offset > 500 ||
      !Number.isInteger(length) || length < 1 || length > 100) {
    throw new Error("invalid_search_page");
  }
  const scope = { organizationId: principal.organizationId, actor: principal.actor, deviceId };
  // The database is authoritative whenever enabled: another gateway may have
  // revoked or stopped the search, even if our in-memory snapshot is stale.
  if (persistence) {
    if (!/^[0-9a-f-]{36}$/i.test(searchId)) throw new Error("search_not_found");
    return persistence.page(scope, searchId, offset, length);
  }
  const s = sessions.get(searchId);
  if (!s || !owner(s, principal, deviceId)) throw new Error("search_not_found");
  return {
    ...summary(s), offset, length, items: s.items.slice(offset, offset + length),
    hasMore: offset + length < s.items.length,
  };
}
export function listSearches(principal: Principal, deviceId: string) {
  expire();
  // Do not overlay local memory on database rows: cross-instance stop must win.
  if (persistence) return persistence.list({
    organizationId: principal.organizationId, actor: principal.actor, deviceId,
  });
  return { items: [...sessions.values()]
    .filter(s => owner(s, principal, deviceId)).map(summary) };
}
export async function controlSearch(
  principal: Principal, deviceId: string, searchId: string,
  router: DeviceRouter, paused: boolean,
) {
  expire();
  const s = sessions.get(searchId);
  // The native worker is owned by the Gateway that started it, even if a
  // foreign Gateway can read persisted snapshots. No cross-actor/device relay.
  if (!s || !owner(s, principal, deviceId)) throw new Error("search_not_found");
  if (s.status !== "running" || !s.inFlight || s.controller.signal.aborted) {
    throw new Error("search_not_running");
  }
  if (s.controlPending) throw new Error("search_control_in_progress");
  if (persistence) {
    let page;
    try {
      page = await persistence.page(
        { organizationId: principal.organizationId, actor: principal.actor, deviceId },
        searchId, 0, 1,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "search_not_found") throw error;
      throw new Error("search_store_unavailable");
    }
    if (page.status !== "running") throw new Error("search_not_running");
  }
  if (s.paused === paused) return summary(s);
  s.controlPending = true;
  try {
    // A fast native scan can emit all progress before the resume ACK returns.
    // Clear the durable and local pause flags *before* sending the resume:
    // otherwise both the Gateway observer and PostgreSQL reject valid frames.
    if (!paused) {
      if (persistence?.setPaused && !await persistence.setPaused(s, false)) {
        throw new Error("search_not_running");
      }
      if (s.status !== "running" || !s.inFlight) throw new Error("search_not_running");
      s.paused = false;
    }
    const accepted = await router.controlSearch(deviceId, searchId, paused);
    if (!accepted || s.status !== "running" || !s.inFlight) {
      throw new Error("search_control_unavailable");
    }
    if (paused) {
      if (persistence?.setPaused && !await persistence.setPaused(s, true)) {
        throw new Error("search_not_running");
      }
      s.paused = true;
    }
    return summary(s);
  } catch (error) {
    if (s.status === "running" && error instanceof Error &&
        error.message !== "search_control_in_progress") {
      // A missing acknowledgment makes native state uncertain. Fail closed.
      s.controller.abort();
    }
    // Relay transport exceptions may include internal URLs or sensitive device
    // details. Only structured search errors are safe for MCP callers.
    if (error instanceof Error &&
        ["search_not_running", "search_control_unavailable"].includes(error.message)) {
      throw error;
    }
    throw new Error("search_control_unavailable");
  } finally {
    s.controlPending = false;
  }
}

export async function stopSearch(principal: Principal, deviceId: string, searchId: string) {
  expire();
  const s = sessions.get(searchId);
  const scope = { organizationId: principal.organizationId, actor: principal.actor, deviceId };
  if (persistence) {
    if (!/^[0-9a-f-]{36}$/i.test(searchId)) throw new Error("search_not_found");
    // Persist the stop before returning success; failure must never be masked.
    // This also prevents a concurrently finishing native scan from reviving
    // the stopped result in another Gateway.
    await persistence.stop({ id: searchId, ...scope });
    if (s && owner(s, principal, deviceId)) {
      s.status = "stopped";
      s.paused = false;
      s.items = [];
      s.controller.abort();
    }
    const page = await persistence.page(scope, searchId, 0, 1);
    return {
      searchId: page.searchId, path: page.path, query: page.query,
      searchType: page.searchType, status: page.status,
      createdAt: page.createdAt, resultCount: page.resultCount,
      truncated: page.truncated, timedOut: page.timedOut,
    };
  }
  if (!s || !owner(s, principal, deviceId)) throw new Error("search_not_found");
  s.status = "stopped";
  s.paused = false;
  s.items = [];
  s.controller.abort();
  return summary(s);
}
