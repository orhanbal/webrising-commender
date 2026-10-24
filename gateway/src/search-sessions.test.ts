import assert from "node:assert/strict";
import test from "node:test";
import type { Principal } from "./auth.js";
import type { DeviceRouter } from "./device-router.js";
import { listSearches, reconcileRemoteSearchStops, searchPage, setSearchPersistence, startSearch, stopSearch } from "./search-sessions.js";

const principal: Principal = {
  organizationId: "org-a",
  actor: "user-a",
  authKind: "token",
  role: "viewer",
  global: false,
};
const remote = {
  request: async (_deviceId: string, action: {kind: string}) => ({
    items: action.kind === "fs_search"
      ? [{ path: "/safe/one.txt" }, { path: "/safe/two.txt" }]
      : [{ path: "/safe/one.txt", line: 1, preview: "hello" }],
    truncated: false,
  }),
} as unknown as DeviceRouter;

test("starts and pages bounded search sessions by actor and device", async () => {
  const started = await startSearch(principal, "device-a", remote, {
    path: "/safe", query: "txt", search_type: "files",
  });
  assert.equal(started.status, "running");
  await new Promise(resolve => setImmediate(resolve));
  const page = await searchPage(principal, "device-a", started.searchId, 0, 1);
  assert.equal(page.status, "completed");
  assert.equal(page.items.length, 1);
  assert.equal(page.hasMore, true);
  const next = await searchPage(principal, "device-a", started.searchId, 1, 1);
  assert.equal(next.hasMore, false);
  assert.equal(next.items.length, 1);
  await assert.rejects(async () => searchPage({...principal, actor: "other"}, "device-a", started.searchId, 0, 1), /search_not_found/);
  await assert.rejects(async () => searchPage(principal, "other-device", started.searchId, 0, 1), /search_not_found/);
  assert.ok((await listSearches(principal, "device-a")).items.some(s => s.searchId === started.searchId));
  const stopped = await stopSearch(principal, "device-a", started.searchId);
  assert.equal(stopped.status, "stopped");
  assert.equal((await searchPage(principal, "device-a", started.searchId, 0, 1)).items.length, 0);
});

test("rejects invalid searches and pagination bounds", async () => {
  await assert.rejects(startSearch(principal, "device-b", remote, {
    path: "/", query: "", search_type: "content",
  }), /invalid_search_arguments/);
  const s = await startSearch(principal, "device-b", remote, {
    path: "/safe", query: "needle", search_type: "content",
  });
  await assert.rejects(async () => searchPage(principal, "device-b", s.searchId, -1, 10), /invalid_search_page/);
  await assert.rejects(async () => searchPage(principal, "device-b", s.searchId, 0, 101), /invalid_search_page/);
});

test("search failure is retained without leaking sessions to other actors", async () => {
  const failing = { request: async () => { throw new Error("device-offline"); } } as unknown as DeviceRouter;
  const s = await startSearch({...principal, actor: "offline-user"}, "device-c", failing, {
    path: "/safe", query: "foo", search_type: "files",
  });
  await new Promise(resolve => setImmediate(resolve));
  const result = await searchPage({...principal, actor: "offline-user"}, "device-c", s.searchId, 0, 10);
  assert.equal(result.status, "error");
  assert.equal(result.error, "device-offline");
});

test("file search sessions forward case sensitivity to the native device action", async () => {
  const observed: Array<{ kind: string; caseSensitive?: boolean }> = [];
  const capturing = {
    request: async (_deviceId: string, action: { kind: string; caseSensitive?: boolean }) => {
      observed.push(action);
      return { items: [], truncated: false };
    },
  } as unknown as DeviceRouter;
  const session = await startSearch(principal, "device-case-sensitive", capturing, {
    path: "/safe", query: "MixedCase", search_type: "files", case_sensitive: true,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await searchPage(principal, "device-case-sensitive", session.searchId, 0, 10)).status, "completed");
  assert.deepEqual(observed, [{ kind: "fs_search", path: "/safe", query: "MixedCase",
    caseSensitive: true, maxResults: 500 }]);
});

test("in-flight search quotas survive stop until native request settles", async () => {
  const p = { ...principal, actor: "quota-search-user" };
  const args = { path: "/safe", query: "sample", search_type: "files" };
  const pending: Array<(value: { items: unknown[]; truncated: boolean }) => void> = [];
  const delayed = {
    request: async () => new Promise<{ items: unknown[]; truncated: boolean }>(resolve => {
      pending.push(resolve);
    }),
  } as unknown as DeviceRouter;
  const created = [];
  for (let index = 0; index < 8; index += 1) {
    created.push(await startSearch(p, "quota-device", delayed, args));
  }
  await assert.rejects(startSearch(p, "quota-device", delayed, args), /search_session_limit/);
  const stopped = await stopSearch(p, "quota-device", created[0]!.searchId);
  assert.equal(stopped.status, "stopped");
  // stop_search discards the result, but does not cancel the native request.
  // It must not permit unbounded concurrent native scans.
  await assert.rejects(startSearch(p, "quota-device", delayed, args), /search_session_limit/);
  pending[0]!({ items: [{ path: "/safe/secret" }], truncated: false });
  await new Promise(resolve => setImmediate(resolve));
  const replacement = await startSearch(p, "quota-device", delayed, args);
  assert.equal(typeof replacement.searchId, "string");
  assert.equal((await searchPage(p, "quota-device", created[0]!.searchId, 0, 1)).status, "stopped");
  assert.deepEqual((await searchPage(p, "quota-device", created[0]!.searchId, 0, 1)).items, []);
  // A completed search also frees its execution slot while preserving its page.
  pending[1]!({ items: [{ path: "/safe/completed" }], truncated: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await searchPage(p, "quota-device", created[1]!.searchId, 0, 1)).status, "completed");
  const afterCompleted = await startSearch(p, "quota-device", delayed, args);
  assert.equal(typeof afterCompleted.searchId, "string");
  for (const resolve of pending) resolve({ items: [], truncated: false });
});

test("completed searches do not consume native concurrency quota", async () => {
  const p = { ...principal, actor: "completed-quota-user" };
  const args = { path: "/safe", query: "txt", search_type: "files" };
  for (let index = 0; index < 10; index += 1) {
    const started = await startSearch(p, "completed-quota-device", remote, args);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await searchPage(p, "completed-quota-device", started.searchId, 0, 10)).status, "completed");
  }
});

test("search errors do not expose native filesystem or secret details", async () => {
  const p = { ...principal, actor: "error-redaction-user" };
  const failing = {
    request: async () => { throw new Error("secret_token=never-leak path=/sensitive/private"); },
  } as unknown as DeviceRouter;
  const started = await startSearch(p, "redaction-device", failing, {
    path: "/safe", query: "needle", search_type: "content",
  });
  await new Promise(resolve => setImmediate(resolve));
  const result = await searchPage(p, "redaction-device", started.searchId, 0, 1);
  assert.equal(result.status, "error");
  assert.equal(result.error, "search_failed");
  assert.ok(!JSON.stringify(result).includes("never-leak"));
});

test("stopped search cannot resurrect results from an in-flight agent response", async () => {
  let complete!: (value: { items: unknown[]; truncated: boolean }) => void;
  const pending = new Promise<{ items: unknown[]; truncated: boolean }>((resolve) => {
    complete = resolve;
  });
  const delayed = { request: async () => pending } as unknown as DeviceRouter;
  const p = { ...principal, actor: "cancel-race-user" };
  const started = await startSearch(p, "cancel-race-device", delayed, {
    path: "/safe", query: "needle", search_type: "content",
  });
  assert.equal((await stopSearch(p, "cancel-race-device", started.searchId)).status, "stopped");
  complete({ items: [{ path: "/safe/secret.txt" }], truncated: false });
  await new Promise(resolve => setImmediate(resolve));
  const result = await searchPage(p, "cancel-race-device", started.searchId, 0, 10);
  assert.equal(result.status, "stopped");
  assert.deepEqual(result.items, []);
});

test("stop_search forwards a native cancellation signal and holds its quota slot", async () => {
  const p = { ...principal, actor: "native-cancel-user" };
  let seen: AbortSignal | undefined;
  let settle!: (value: { items: unknown[]; truncated: boolean }) => void;
  const router = {
    request: async (_device: string, _action: unknown, _approval: unknown, signal?: AbortSignal) => {
      seen = signal;
      return new Promise<{ items: unknown[]; truncated: boolean }>(resolve => { settle = resolve; });
    },
  } as unknown as DeviceRouter;
  const args = { path: "/safe", query: "needle", search_type: "content" };
  const first = await startSearch(p, "native-cancel-device", router, args);
  assert.equal(seen?.aborted, false);
  await stopSearch(p, "native-cancel-device", first.searchId);
  assert.equal(seen?.aborted, true);
  assert.equal((await searchPage(p, "native-cancel-device", first.searchId, 0, 10)).status, "stopped");
  settle({ items: [{ path: "/safe/secret" }], truncated: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await searchPage(p, "native-cancel-device", first.searchId, 0, 10)).items, []);
});

test("remote Gateway stop aborts only its matching local native scanner", async () => {
  const p = { ...principal, actor: "cross-gateway-stop-user" };
  const observed = new Map<string, AbortSignal>();
  const router = {
    request: async (deviceId: string, _action: unknown, _approval: unknown, signal: AbortSignal) => {
      observed.set(deviceId, signal);
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    },
  } as unknown as DeviceRouter;
  let remoteStops: string[] = [];
  const store = {
    create: async () => {},
    finish: async () => true,
    stoppedIds: async (ids: string[]) => remoteStops.filter(id => ids.includes(id)),
  };
  setSearchPersistence(store as never);
  try {
    const args = { path: "/safe", query: "needle", search_type: "files" };
    const a = await startSearch(p, "remote-stop-a", router, args);
    const b = await startSearch(p, "remote-stop-b", router, args);
    remoteStops = ["00000000-0000-4000-8000-000000000099"];
    await reconcileRemoteSearchStops();
    assert.equal(observed.get("remote-stop-a")?.aborted, false);
    assert.equal(observed.get("remote-stop-b")?.aborted, false);
    remoteStops = [a.searchId];
    await reconcileRemoteSearchStops();
    assert.equal(observed.get("remote-stop-a")?.aborted, true);
    assert.equal(observed.get("remote-stop-b")?.aborted, false);
    // The unrelated scan remains running until explicitly stopped.
    remoteStops = [b.searchId];
    await reconcileRemoteSearchStops();
    assert.equal(observed.get("remote-stop-b")?.aborted, true);
  } finally {
    setSearchPersistence(undefined);
  }
});
