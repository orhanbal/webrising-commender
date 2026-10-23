import assert from "node:assert/strict";
import test from "node:test";
import type { Principal } from "./auth.js";
import type { DeviceRouter } from "./device-router.js";
import { listSearches, searchPage, startSearch, stopSearch } from "./search-sessions.js";

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
  const page = searchPage(principal, "device-a", started.searchId, 0, 1);
  assert.equal(page.status, "completed");
  assert.equal(page.items.length, 1);
  assert.equal(page.hasMore, true);
  const next = searchPage(principal, "device-a", started.searchId, 1, 1);
  assert.equal(next.hasMore, false);
  assert.equal(next.items.length, 1);
  assert.throws(() => searchPage({...principal, actor: "other"}, "device-a", started.searchId, 0, 1), /search_not_found/);
  assert.throws(() => searchPage(principal, "other-device", started.searchId, 0, 1), /search_not_found/);
  assert.ok(listSearches(principal, "device-a").items.some(s => s.searchId === started.searchId));
  const stopped = stopSearch(principal, "device-a", started.searchId);
  assert.equal(stopped.status, "stopped");
  assert.equal(searchPage(principal, "device-a", started.searchId, 0, 1).items.length, 0);
});

test("rejects invalid searches and pagination bounds", async () => {
  await assert.rejects(startSearch(principal, "device-b", remote, {
    path: "/", query: "", search_type: "content",
  }), /invalid_search_arguments/);
  const s = await startSearch(principal, "device-b", remote, {
    path: "/safe", query: "needle", search_type: "content",
  });
  assert.throws(() => searchPage(principal, "device-b", s.searchId, -1, 10), /invalid_search_page/);
  assert.throws(() => searchPage(principal, "device-b", s.searchId, 0, 101), /invalid_search_page/);
});

test("search failure is retained without leaking sessions to other actors", async () => {
  const failing = { request: async () => { throw new Error("device-offline"); } } as unknown as DeviceRouter;
  const s = await startSearch({...principal, actor: "offline-user"}, "device-c", failing, {
    path: "/safe", query: "foo", search_type: "files",
  });
  await new Promise(resolve => setImmediate(resolve));
  const result = searchPage({...principal, actor: "offline-user"}, "device-c", s.searchId, 0, 10);
  assert.equal(result.status, "error");
  assert.equal(result.error, "device-offline");
});
