import assert from "node:assert/strict";
import test from "node:test";
import type { Principal } from "./auth.js";
import type { DeviceRouter } from "./device-router.js";
import { controlSearch, listSearches, reconcileRemoteSearchStops, recoverInterruptedSearches, searchPage, setSearchPersistence, startSearch, stopSearch } from "./search-sessions.js";

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

test("an out-of-order durable progress CAS does not cancel a healthy native scan", async () => {
  const actor = { ...principal, actor: "stale-progress-actor" };
  let signal!: AbortSignal;
  let emit!: (progress: { items: unknown[]; scannedEntries: number; scannedBytes: number }) => void;
  let settle!: (data: { items: unknown[]; truncated: boolean }) => void;
  const router = {
    request: async (_device: string, _action: unknown, _approval: unknown,
      controller: AbortSignal, onProgress: typeof emit) => {
      signal = controller;
      emit = onProgress;
      return new Promise<{ items: unknown[]; truncated: boolean }>(resolve => { settle = resolve; });
    },
  } as unknown as DeviceRouter;
  const persistence = {
    create: async () => {},
    progress: async () => false, // Old sequence lost its PostgreSQL CAS race.
    finish: async () => true,
  };
  setSearchPersistence(persistence as never);
  try {
    const started = await startSearch(actor, "stale-progress-device", router, {
      path: "/safe", query: "sample", search_type: "files",
    });
    assert.equal(started.status, "running");
    emit({ items: [{ path: "/safe/first" }], scannedEntries: 32, scannedBytes: 0 });
    // Reject a rewind even before PostgreSQL is contacted.
    emit({ items: [{ path: "/safe/old" }], scannedEntries: 8, scannedBytes: 0 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, false);
    settle({ items: [{ path: "/safe/final" }], truncated: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, false);
  } finally {
    setSearchPersistence(undefined);
  }
});

test("native completion persists final bounded counters even without a progress event", async () => {
  const actor = { ...principal, actor: "final-counter-actor" };
  const completions: Array<{ scannedEntries: number; scannedBytes: number }> = [];
  const persistence = {
    create: async () => {},
    finish: async (_key: unknown, value: { scannedEntries: number; scannedBytes: number }) => {
      completions.push(value);
      return true;
    },
  };
  const router = {
    request: async () => ({
      items: [], truncated: false, scannedEntries: 7, scannedBytes: 1024,
    }),
  } as unknown as DeviceRouter;
  setSearchPersistence(persistence as never);
  try {
    await startSearch(actor, "final-counter-device", router, {
      path: "/safe", query: "needle", search_type: "content",
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(completions.map(({ scannedEntries, scannedBytes }) =>
      ({ scannedEntries, scannedBytes })), [{ scannedEntries: 7, scannedBytes: 1024 }]);
  } finally {
    setSearchPersistence(undefined);
  }
});

test("native progress exposes scoped live pages and cannot resurrect stopped results", async () => {
  const actor = { ...principal, actor: "progress-actor" };
  let progress!: (value: { items: unknown[]; scannedEntries: number; scannedBytes: number }) => void;
  let finish!: (value: { items: unknown[]; truncated: boolean }) => void;
  const router = {
    request: async (_device: string, _action: unknown, _approval: unknown,
      _signal: AbortSignal, onProgress: typeof progress) => {
      progress = onProgress;
      return new Promise<{ items: unknown[]; truncated: boolean }>(resolve => { finish = resolve; });
    },
  } as unknown as DeviceRouter;
  const started = await startSearch(actor, "progress-device", router, {
    path: "/safe", query: "needle", search_type: "files",
  });
  progress({ items: [{ path: "/safe/one" }], scannedEntries: 64, scannedBytes: 0 });
  const live = await searchPage(actor, "progress-device", started.searchId, 0, 10);
  assert.equal(live.status, "running");
  assert.deepEqual(live.items, [{ path: "/safe/one" }]);
  assert.equal(live.progressUpdates, 1);
  assert.equal(live.scannedEntries, 64);
  await assert.rejects(
    async () => searchPage({ ...actor, actor: "other" }, "progress-device", started.searchId, 0, 10),
    /search_not_found/,
  );
  // Unbounded or forged progress must not replace the guarded snapshot.
  progress({ items: Array.from({ length: 501 }, () => "x"), scannedEntries: 100, scannedBytes: 0 });
  assert.equal((await searchPage(actor, "progress-device", started.searchId, 0, 10)).progressUpdates, 1);
  await stopSearch(actor, "progress-device", started.searchId);
  progress({ items: [{ path: "/safe/secret" }], scannedEntries: 200, scannedBytes: 0 });
  finish({ items: [{ path: "/safe/secret" }], truncated: false });
  await new Promise(resolve => setImmediate(resolve));
  const stopped = await searchPage(actor, "progress-device", started.searchId, 0, 10);
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(stopped.items, []);
});

test("pause/resume only controls an owned active native search and never leaks across actor/device", async () => {
  const actor = { ...principal, actor: "pause-owner" };
  const controls: boolean[] = [];
  let cancelled!: AbortSignal;
  let settle!: (value: { items: unknown[]; truncated: boolean }) => void;
  const router = {
    request: async (_device: string, _action: unknown, _approval: unknown,
      signal: AbortSignal) => {
      cancelled = signal;
      return new Promise<{ items: unknown[]; truncated: boolean }>(resolve => { settle = resolve; });
    },
    controlSearch: async (_device: string, _searchId: string, paused: boolean) => {
      controls.push(paused);
      return true;
    },
  } as unknown as DeviceRouter;
  const started = await startSearch(actor, "pause-device", router, {
    path: "/safe", query: "sample", search_type: "files",
  });
  await assert.rejects(
    controlSearch({ ...actor, actor: "intruder" }, "pause-device", started.searchId, router, true),
    /search_not_found/,
  );
  await assert.rejects(
    controlSearch(actor, "foreign-device", started.searchId, router, true),
    /search_not_found/,
  );
  assert.equal((await controlSearch(actor, "pause-device", started.searchId, router, true)).paused, true);
  assert.equal((await searchPage(actor, "pause-device", started.searchId, 0, 10)).paused, true);
  assert.equal((await controlSearch(actor, "pause-device", started.searchId, router, false)).paused, false);
  assert.deepEqual(controls, [true, false]);
  assert.equal(cancelled.aborted, false);
  await stopSearch(actor, "pause-device", started.searchId);
  await assert.rejects(
    controlSearch(actor, "pause-device", started.searchId, router, true),
    /search_not_running/,
  );
  settle({ items: [{ path: "/safe/must-not-appear" }], truncated: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await searchPage(actor, "pause-device", started.searchId, 0, 10)).items, []);
});

test("fast resumed native progress is accepted before the control ACK returns", async () => {
  const actor = { ...principal, actor: "resume-race-owner" };
  let emit!: (value: { items: unknown[]; scannedEntries: number; scannedBytes: number }) => void;
  let settle!: (value: { items: unknown[]; truncated: boolean }) => void;
  const calls: string[] = [];
  const router = {
    request: async (_device: string, _action: unknown, _approval: unknown,
      _signal: AbortSignal, onProgress: typeof emit) => {
      emit = onProgress;
      return new Promise<{ items: unknown[]; truncated: boolean }>(resolve => { settle = resolve; });
    },
    controlSearch: async () => {
      calls.push("native");
      emit({ items: [{ path: "/safe/needle.txt" }], scannedEntries: 32, scannedBytes: 0 });
      return true;
    },
  } as unknown as DeviceRouter;
  const persistence = {
    create: async () => {},
    page: async () => ({ status: "running", paused: true }),
    setPaused: async (_key: unknown, paused: boolean) => {
      calls.push(paused ? "db-pause" : "db-resume"); return true;
    },
    progress: async () => { calls.push("progress"); return true; },
    finish: async () => true,
  };
  setSearchPersistence(persistence as never);
  try {
    const entry = await startSearch(actor, "resume-race-device", router, {
      path: "/safe", query: "needle", search_type: "files", start_paused: true,
    });
    const resumed = await controlSearch(actor, "resume-race-device", entry.searchId, router, false);
    assert.equal(resumed.paused, false);
    assert.equal(resumed.progressUpdates, 1);
    assert.deepEqual(calls.slice(0, 2), ["db-resume", "native"]);
    settle({ items: [{ path: "/safe/needle.txt" }], truncated: false });
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    setSearchPersistence(undefined);
  }
});

test("failed native pause acknowledgment cancels only the owned scan", async () => {
  const actor = { ...principal, actor: "pause-reject-owner" };
  let cancelled!: AbortSignal;
  let settle!: (value: { items: unknown[]; truncated: boolean }) => void;
  const router = {
    request: async (_device: string, _action: unknown, _approval: unknown,
      signal: AbortSignal) => {
      cancelled = signal;
      return new Promise(resolve => { settle = resolve; });
    },
    controlSearch: async () => false,
  } as unknown as DeviceRouter;
  const started = await startSearch(actor, "reject-device", router, {
    path: "/safe", query: "needle", search_type: "content",
  });
  await assert.rejects(
    controlSearch(actor, "reject-device", started.searchId, router, true),
    /search_control_unavailable/,
  );
  assert.equal(cancelled.aborted, true);
  settle({ items: [], truncated: false });
  await new Promise(resolve => setImmediate(resolve));
});

test("pause control redacts remote relay failures and cancels the uncertain native scan", async () => {
  const actor = { ...principal, actor: "pause-redaction-owner" };
  let signal!: AbortSignal;
  let settle!: (value: { items: unknown[]; truncated: boolean }) => void;
  const router = {
    request: async (_device: string, _action: unknown, _approval: unknown,
      controller: AbortSignal) => {
      signal = controller;
      return new Promise<{ items: unknown[]; truncated: boolean }>(resolve => {
        settle = resolve;
      });
    },
    controlSearch: async () => {
      throw new Error("internal relay https://secret.internal/?token=never-leak");
    },
  } as unknown as DeviceRouter;
  const started = await startSearch(actor, "pause-redaction-device", router, {
    path: "/safe", query: "needle", search_type: "files",
  });
  await assert.rejects(
    controlSearch(actor, "pause-redaction-device", started.searchId, router, true),
    error => error instanceof Error && error.message === "search_control_unavailable",
  );
  assert.equal(signal.aborted, true);
  settle({ items: [], truncated: false });
  await new Promise(resolve => setImmediate(resolve));
});

test("checkpoint takeover keeps the original session ID and replays only its pending native directories", async () => {
  const user = { ...principal, actor: "recovery-actor" };
  const checkpoint = {
    version: 1, root: "/safe", query: "needle", caseSensitive: false,
    pending: ["/safe/unvisited"], items: [{ path: "/safe/needle-one.txt" }],
    scannedEntries: 32,
  };
  const candidate = {
    id: "bfe0222a-2222-4222-8222-111111111112",
    organizationId: user.organizationId, actor: user.actor,
    deviceId: "recovery-device", path: "/safe", query: "needle",
    searchType: "files" as const, createdAt: Date.now(),
    checkpoint, progressUpdates: 4,
  };
  // The list query saw an older checkpoint. A progress write can commit a
  // newer complete directory boundary before the owner-fencing SQL update.
  const claimedCheckpoint = {
    ...checkpoint, pending: ["/safe/later"], scannedEntries: 64,
    items: [{ path: "/safe/needle-one.txt" }, { path: "/safe/needle-mid.txt" }],
  };
  let requestAction: unknown;
  let requestSession: string | undefined;
  let finish!: (value: { items: unknown[]; truncated: boolean }) => void;
  let created = false;
  const router = {
    isOnline: async () => true,
    request: async (_device: string, action: unknown, _approval: unknown,
      _signal: AbortSignal, _progress: unknown, sessionId: string) => {
      requestAction = action;
      requestSession = sessionId;
      return new Promise<{ items: unknown[]; truncated: boolean }>(resolve => { finish = resolve; });
    },
  } as unknown as DeviceRouter;
  const store = {
    create: async () => { created = true; },
    recoveryCandidates: async () => [candidate],
    claimRecovery: async () => ({ sequence: 5, checkpoint: claimedCheckpoint }),
    finish: async () => true,
  };
  setSearchPersistence(store as never);
  try {
    await recoverInterruptedSearches(router);
    assert.equal(created, false, "A takeover must not allocate a second native slot");
    assert.equal(requestSession, candidate.id);
    assert.deepEqual((requestAction as { resumeCheckpoint: unknown }).resumeCheckpoint,
      claimedCheckpoint, "must replay the checkpoint returned by the atomic CAS");
    finish({ items: [...claimedCheckpoint.items, { path: "/safe/needle-two.txt" }],
      truncated: false });
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    setSearchPersistence(undefined);
  }
});

test("match-free content checkpoint resumes with original actor/session/byte budget", async () => {
  const actor = { ...principal, actor: "content-recovery-owner" };
  const checkpoint = {
    version: 1, searchType: "content", root: "/safe",
    query: "needle", caseSensitive: false, pending: ["/safe/unread.txt"],
    items: [], scannedEntries: 32, scannedBytes: 96,
  };
  const candidate = {
    id: "7fe0222a-2222-4222-8222-111111111132",
    organizationId: actor.organizationId, actor: actor.actor,
    deviceId: "content-recovery-device", path: "/safe",
    query: "needle", searchType: "content" as const,
    createdAt: Date.now(), checkpoint, progressUpdates: 8,
  };
  let dispatchedAction: unknown;
  let dispatchedSession: string | undefined;
  let resolveNative!: (value: { items: unknown[]; truncated: boolean; scannedBytes: number }) => void;
  const router = {
    isOnline: async () => true,
    request: async (_device: string, action: unknown, _approval: unknown,
      _signal: AbortSignal, _progress: unknown, searchId: string) => {
      dispatchedAction = action;
      dispatchedSession = searchId;
      return new Promise(resolve => { resolveNative = resolve; });
    },
  } as unknown as DeviceRouter;
  const store = {
    recoveryCandidates: async () => [candidate],
    claimRecovery: async () => ({ sequence: 9, checkpoint }),
    finish: async () => true,
  };
  setSearchPersistence(store as never);
  try {
    await recoverInterruptedSearches(router);
    assert.equal(dispatchedSession, candidate.id);
    assert.equal((dispatchedAction as { kind: string }).kind, "text_search");
    assert.deepEqual((dispatchedAction as { resumeCheckpoint: unknown }).resumeCheckpoint, checkpoint);
    const running = await searchPage(actor, candidate.deviceId, candidate.id, 0, 10);
    assert.equal(running.scannedBytes, 96);
    resolveNative({ items: [{ path: "/safe/unread.txt", line: 1,
      preview: "needle" }], truncated: false, scannedBytes: 110 });
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    setSearchPersistence(undefined);
  }
});

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

test("native search quota follows actor across devices without crossing tenants", async () => {
  const actor = { ...principal, actor: "multi-device-quota-user" };
  const args = { path: "/safe", query: "needle", search_type: "files" };
  const pending: Array<(value: { items: unknown[]; truncated: boolean }) => void> = [];
  const delayed = {
    request: async () => new Promise<{ items: unknown[]; truncated: boolean }>(resolve => {
      pending.push(resolve);
    }),
  } as unknown as DeviceRouter;
  try {
    const active = [];
    for (let index = 0; index < 8; index += 1) {
      active.push(await startSearch(actor, `multi-quota-device-${index}`, delayed, args));
    }
    await assert.rejects(
      startSearch(actor, "multi-quota-device-nine", delayed, args),
      /search_session_limit/,
    );
    // Neither a different actor nor an identically named actor in another
    // tenant should inherit this actor's native execution slots.
    const otherActor = await startSearch({ ...actor, actor: "different-actor" },
      "multi-quota-device-nine", delayed, args);
    const otherTenant = await startSearch({ ...actor, organizationId: "org-b" },
      "multi-quota-device-nine", delayed, args);
    assert.equal(otherActor.status, "running");
    assert.equal(otherTenant.status, "running");

    // Stopping a search cannot immediately free the slot: native cancellation
    // is asynchronous and the device may still be scanning.
    await stopSearch(actor, "multi-quota-device-0", active[0]!.searchId);
    await assert.rejects(
      startSearch(actor, "multi-quota-device-nine", delayed, args),
      /search_session_limit/,
    );
    pending[0]!({ items: [], truncated: false });
    await new Promise(resolve => setImmediate(resolve));
    const replacement = await startSearch(actor, "multi-quota-device-nine", delayed, args);
    assert.equal(replacement.status, "running");
  } finally {
    for (const resolve of pending) resolve({ items: [], truncated: false });
    await new Promise(resolve => setImmediate(resolve));
  }
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
