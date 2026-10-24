import crypto from "node:crypto";
import type { AgentAction } from "./protocol.js";
import type { DeviceRouter } from "./device-router.js";
import type { Principal } from "./auth.js";
import type { SearchPersistence } from "./search-persistence.js";

/**
 * Bounded, tenant/actor-isolated search sessions.
 * The native search currently returns a bounded snapshot (up to 500 matches);
 * pagination becomes available when that remote request completes. This is
 * NOT a streaming scanner and is intentionally labelled accordingly.
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
    truncated: s.truncated,
    timedOut: s.timedOut,
    ...(s.error ? { error: s.error } : {}),
  };
}
export async function startSearch(
  principal: Principal,
  deviceId: string,
  router: DeviceRouter,
  arg: { path: string; query: string; search_type: string; case_sensitive?: boolean },
) {
  expire();
  if (typeof arg.path !== "string" || !arg.path || arg.path.length > 4096 ||
      typeof arg.query !== "string" || !arg.query.trim() || arg.query.length > 1024 ||
      !["files", "content"].includes(arg.search_type) ||
      (arg.case_sensitive !== undefined && typeof arg.case_sensitive !== "boolean")) {
    throw new Error("invalid_search_arguments");
  }
  // Only active native requests consume concurrency slots. Completed searches
  // must not block the actor for the entire result-retention TTL. A stopped
  // search remains in-flight until the agent settles: stop_search currently
  // suppresses results but does not physically cancel native scanning.
  const matches = [...sessions.values()].filter(s =>
    owner(s, principal, deviceId) && s.inFlight);
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
    id: crypto.randomUUID(),
    organizationId: principal.organizationId,
    actor: principal.actor,
    deviceId,
    path: arg.path,
    query: arg.query,
    searchType: arg.search_type as "files" | "content",
    createdAt: Date.now(),
    status: "running",
    items: [],
    truncated: false,
    timedOut: false,
    inFlight: true,
    controller: new AbortController(),
  };
  sessions.set(entry.id, entry);
  if (persistence) {
    try {
      await persistence.create(entry);
    } catch {
      sessions.delete(entry.id);
      throw new Error("search_store_unavailable");
    }
  }
  const action: AgentAction = entry.searchType === "files"
    ? { kind: "fs_search", path: arg.path, query: arg.query,
        caseSensitive: Boolean(arg.case_sensitive), maxResults: 500 }
    : { kind: "text_search", path: arg.path, query: arg.query,
        caseSensitive: Boolean(arg.case_sensitive), maxResults: 500 };
  // Do not block the MCP request; a follow-up call collects paged results.
  void router.request(deviceId, action, undefined, entry.controller.signal).then(async data => {
    entry.inFlight = false;
    if (entry.status !== "running") return;
    const payload = data as { items?: unknown[]; truncated?: boolean; timedOut?: boolean };
    const candidate = {
      status: "completed" as const,
      items: Array.isArray(payload?.items) ? payload.items.slice(0, 500) : [],
      truncated: Boolean(payload?.truncated),
      timedOut: Boolean(payload?.timedOut),
    };
    try {
      const committed = persistence ? await persistence.finish(entry, candidate) : true;
      if (!committed) {
        // Another Gateway may have stopped or expired this request; never revive results.
        entry.status = "stopped";
        entry.items = [];
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
    entry.status = "completed";
  }, async error => {
    entry.inFlight = false;
    if (entry.status !== "running") return;
    const message = safeSearchError(error);
    try {
      const committed = persistence ? await persistence.finish(entry, {
        status: "error", items: [], truncated: false, timedOut: false, error: message,
      }) : true;
      if (!committed) {
        entry.status = "stopped";
        entry.items = [];
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
  s.items = [];
  s.controller.abort();
  return summary(s);
}
