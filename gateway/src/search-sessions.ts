import crypto from "node:crypto";
import type { AgentAction } from "./protocol.js";
import type { DeviceRouter } from "./device-router.js";
import type { Principal } from "./auth.js";

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
  error?: string;
};
const MAX_SESSIONS = 64;
const PER_ACTOR_LIMIT = 8;
const TTL_MS = 5 * 60_000;
const sessions = new Map<string, SearchEntry>();

function expire(now = Date.now()) {
  for (const [id, s] of sessions) if (now - s.createdAt > TTL_MS) sessions.delete(id);
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
  const matches = [...sessions.values()].filter(s => owner(s, principal, deviceId));
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
  };
  sessions.set(entry.id, entry);
  const action: AgentAction = entry.searchType === "files"
    ? { kind: "fs_search", path: arg.path, query: arg.query, maxResults: 500 }
    : { kind: "text_search", path: arg.path, query: arg.query,
        caseSensitive: Boolean(arg.case_sensitive), maxResults: 500 };
  // Do not block the MCP request; a follow-up call collects paged results.
  void router.request(deviceId, action).then(data => {
    if (entry.status !== "running") return;
    const payload = data as { items?: unknown[]; truncated?: boolean };
    entry.items = Array.isArray(payload?.items) ? payload.items.slice(0, 500) : [];
    entry.truncated = Boolean(payload?.truncated);
    entry.status = "completed";
  }, error => {
    if (entry.status !== "running") return;
    entry.status = "error";
    entry.error = error instanceof Error ? error.message.slice(0, 240) : "search_failed";
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
  const s = sessions.get(searchId);
  if (!s || !owner(s, principal, deviceId)) throw new Error("search_not_found");
  return {
    ...summary(s),
    offset,
    length,
    items: s.items.slice(offset, offset + length),
    hasMore: offset + length < s.items.length,
  };
}
export function listSearches(principal: Principal, deviceId: string) {
  expire();
  return {
    items: [...sessions.values()]
      .filter(s => owner(s, principal, deviceId))
      .map(summary),
  };
}
export function stopSearch(principal: Principal, deviceId: string, searchId: string) {
  expire();
  const s = sessions.get(searchId);
  if (!s || !owner(s, principal, deviceId)) throw new Error("search_not_found");
  s.status = "stopped";
  s.items = [];
  return summary(s);
}
