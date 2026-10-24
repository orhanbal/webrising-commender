import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { PgSearchPersistence } from "./search-persistence.js";

const owner = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  actor: "actor-one",
  deviceId: "00000000-0000-4000-8000-000000000002",
};
const id = "00000000-0000-4000-8000-000000000003";
const sampleRow = {
  id, path: "/allowed", query: "needle", search_type: "files" as const,
  status: "completed" as const, origin_instance: "prior-gateway-instance",
  created_at: new Date("2026-10-24T09:00:00.000Z"),
  items: [{ path: "/allowed/a.txt" }, { path: "/allowed/b.txt" }],
  truncated: false, timed_out: false, error_code: null,
};

test("monotone progress persistence cannot update stopped or another actor's scan", async () => {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const fake = {
    query: async (sql: string, args: unknown[]) => {
      writes.push({ sql, args });
      return { rows: [{ id }], rowCount: 1 };
    },
  } as unknown as Pool;
  const store = new PgSearchPersistence(fake);
  const accepted = await store.progress({ ...owner, id }, {
    items: [{ path: "/allowed/one" }], scannedEntries: 80,
    scannedBytes: 1000, sequence: 2,
  });
  assert.equal(accepted, true);
  assert.match(writes[0]!.sql, /status='running'/);
  assert.match(writes[0]!.sql, /origin_instance=\$9/);
  assert.match(writes[0]!.sql, /progress_sequence<\$8/);
  assert.deepEqual(writes[0]!.args.slice(0, 4),
    [id, owner.organizationId, owner.actor, owner.deviceId]);
  assert.equal(writes[0]!.args[7], 2);
  const tooLarge = Array.from({ length: 500 }, (_, i) => ({
    path: `/allowed/${i}`, preview: "ü".repeat(2000),
  }));
  await store.progress({ ...owner, id }, {
    items: tooLarge, scannedEntries: 90, scannedBytes: 2000, sequence: 3,
  });
  const persisted = JSON.parse(writes[1]!.args[4] as string) as unknown[];
  assert.ok(persisted.length > 0 && persisted.length < 500);
  assert.ok(Buffer.byteLength(writes[1]!.args[4] as string, "utf8") <= 1024 * 1024);
  const rejecting = {
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as Pool;
  assert.equal(await new PgSearchPersistence(rejecting).progress({ ...owner, id }, {
    items: [{ path: "/allowed/must-not-reappear" }],
    scannedEntries: 100, scannedBytes: 2000, sequence: 4,
  }), false);
});

test("completed search page survives new gateway persistence instance and is actor scoped", async () => {
  const queries: Array<{ statement: string; parameters: unknown[] | undefined }> = [];
  const fake = {
    query: async (statement: string, parameters?: unknown[]) => {
      queries.push({ statement, parameters });
      const allowed = parameters?.[1] === owner.organizationId &&
        parameters?.[2] === owner.actor && parameters?.[3] === owner.deviceId;
      return { rows: allowed ? [sampleRow] : [], rowCount: allowed ? 1 : 0 };
    },
  } as unknown as Pool;
  const afterRestart = new PgSearchPersistence(fake);
  const page = await afterRestart.page(owner, id, 1, 1);
  assert.equal(page.status, "completed");
  assert.deepEqual(page.items, [{ path: "/allowed/b.txt" }]);
  assert.equal(page.resultCount, 2);
  await assert.rejects(afterRestart.page({ ...owner, actor: "other" }, id, 0, 10), /search_not_found/);
  await assert.rejects(afterRestart.page({ ...owner, deviceId: "other-device" }, id, 0, 10), /search_not_found/);
  assert.ok(queries.every(({ statement }) =>
    /s.organization_id=\$2 and s.actor=\$3 and s.device_id=\$4/.test(statement)));
});

test("a live remote Gateway keeps its running search visible", async () => {
  const fake = {
    query: async () => ({
      rows: [{ ...sampleRow, status: "running", items: [], origin_alive: true }],
      rowCount: 1,
    }),
  } as unknown as Pool;
  const observer = new PgSearchPersistence(fake);
  const page = await observer.page(owner, id, 0, 10);
  assert.equal(page.status, "running");
  assert.equal(page.error, undefined);
  assert.deepEqual(page.items, []);
});

test("active remote Gateway exposes only its persisted incremental progress pages", async () => {
  const visibleItems = [{ path: "/allowed/in-progress" }];
  const fake = {
    query: async () => ({
      rows: [{ ...sampleRow, status: "running", items: visibleItems,
        origin_alive: true, progress_sequence: 3, scanned_entries: 96, scanned_bytes: 12 }],
      rowCount: 1,
    }),
  } as unknown as Pool;
  const observer = new PgSearchPersistence(fake);
  const page = await observer.page(owner, id, 0, 10);
  assert.equal(page.status, "running");
  assert.deepEqual(page.items, visibleItems);
  assert.equal(page.progressUpdates, 3);
  assert.equal(page.scannedEntries, 96);
  assert.equal(page.scannedBytes, 12);
  const foreign = { ...sampleRow, status: "running", items: visibleItems,
    origin_alive: false, progress_sequence: 3 };
  const hidden = new PgSearchPersistence({
    query: async () => ({ rows: [foreign], rowCount: 1 }),
  } as unknown as Pool);
  const invisible = await hidden.page(owner, id, 0, 10);
  assert.equal(invisible.status, "error");
  assert.deepEqual(invisible.items, []);
});

test("search list retains native progress counters and exact tenant/actor/device SQL isolation", async () => {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const fake = {
    query: async (sql: string, args: unknown[]) => {
      statements.push({ sql, args });
      return { rows: [{ ...sampleRow, status: "running", origin_alive: true,
        progress_sequence: 4, scanned_entries: 128, scanned_bytes: 8192 }], rowCount: 1 };
    },
  } as unknown as Pool;
  const list = await new PgSearchPersistence(fake).list(owner);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0]!.status, "running");
  assert.equal(list.items[0]!.progressUpdates, 4);
  assert.equal(list.items[0]!.scannedEntries, 128);
  assert.equal(list.items[0]!.scannedBytes, 8192);
  assert.match(statements[0]!.sql, /s.progress_sequence,s.scanned_entries,s.scanned_bytes/);
  assert.match(statements[0]!.sql, /s.organization_id=\$1 and s.actor=\$2 and s.device_id=\$3/);
  assert.deepEqual(statements[0]!.args, [owner.organizationId, owner.actor, owner.deviceId]);
});

test("a native search owned by an unavailable gateway is never reported as completed", async () => {
  const fake = {
    query: async () => ({ rows: [{ ...sampleRow, status: "running" }], rowCount: 1 }),
  } as unknown as Pool;
  const recovered = new PgSearchPersistence(fake);
  const page = await recovered.page(owner, id, 0, 10);
  assert.equal(page.status, "error");
  assert.equal(page.error, "search_interrupted");
  assert.deepEqual(page.items, []);
});

test("paused durable search CAS is scoped to actor/device/native owner and active status", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const fake = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [{ id }], rowCount: 1 };
    },
  } as unknown as Pool;
  const store = new PgSearchPersistence(fake);
  assert.equal(await store.setPaused({ ...owner, id }, true), true);
  assert.match(calls[0]!.sql, /status='running'/);
  assert.match(calls[0]!.sql, /native_inflight=true/);
  assert.match(calls[0]!.sql, /origin_instance=\$6/);
  assert.deepEqual(calls[0]!.params.slice(0, 5),
    [id, owner.organizationId, owner.actor, owner.deviceId, true]);
  assert.equal(typeof calls[0]!.params[5], "string");
  const rejected = new PgSearchPersistence({
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as Pool);
  assert.equal(await rejected.setPaused({ ...owner, id }, true), false);
});

test("stopping durable search clears persisted results under exact ownership guard", async () => {
  const sql: Array<{ statement: string; params: unknown[] }> = [];
  const fake = {
    query: async (statement: string, params: unknown[]) => {
      sql.push({ statement, params });
      return { rows: [{ id }], rowCount: 1 };
    },
  } as unknown as Pool;
  const store = new PgSearchPersistence(fake);
  await store.stop({ ...owner, id });
  assert.match(sql[0]!.statement, /set status='stopped',paused=false,items='\[\]'::jsonb/);
  assert.deepEqual(sql[0]!.params, [id, owner.organizationId, owner.actor, owner.deviceId]);
});

test("persisted completions use a size bound and status transition guard", async () => {
  const sql: Array<{ statement: string; params: unknown[] }> = [];
  const fake = {
    query: async (statement: string, params: unknown[]) => {
      sql.push({ statement, params });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  const store = new PgSearchPersistence(fake);
  await store.finish({ ...owner, id }, {
    status: "completed", items: [{ preview: "x".repeat(2 * 1024 * 1024) }],
    truncated: false, timedOut: false,
  });
  assert.match(sql[0]!.statement, /status='running'/);
  assert.match(sql[0]!.statement, /native_inflight=true/);
  assert.match(sql[0]!.statement, /origin_instance=\$13/);
  assert.match(sql[0]!.statement, /scanned_entries=greatest\(scanned_entries,\$11\)/);
  assert.match(sql[0]!.statement, /scanned_bytes=greatest\(scanned_bytes,\$12\)/);
  assert.equal(sql[0]!.params[10], 0);
  assert.equal(sql[0]!.params[11], 0);
  assert.equal(typeof sql[0]!.params[12], "string");
  assert.equal(sql[0]!.params[5], "[]");
  assert.equal(sql[0]!.params[6], true);
  assert.match(sql[0]!.statement, /returning id/);
});

test("oversized durable search keeps ordered pages under the 1 MiB cap", async () => {
  const calls: unknown[][] = [];
  const fake = {
    query: async (_statement: string, params: unknown[]) => {
      calls.push(params);
      return { rows: [{ id }], rowCount: 1 };
    },
  } as unknown as Pool;
  const store = new PgSearchPersistence(fake);
  const items = Array.from({ length: 500 }, (_, index) => ({
    path: `/allowed/${String(index).padStart(4, "0")}`,
    preview: "ü".repeat(1500),
  }));
  assert.equal(await store.finish({ ...owner, id }, {
    status: "completed", items, truncated: false, timedOut: false,
  }), true);
  const params = calls[0]!;
  const retained = JSON.parse(params[5] as string) as typeof items;
  assert.ok(retained.length > 0 && retained.length < 500);
  assert.ok(Buffer.byteLength(params[5] as string, "utf8") <= 1024 * 1024);
  assert.deepEqual(retained, items.slice(0, retained.length));
  assert.equal(params[6], true);
  assert.equal(params[7], false);
});

test("durable search enforces 500-item cap and preserves exact fitting snapshots", async () => {
  const calls: unknown[][] = [];
  const fake = {
    query: async (_statement: string, params: unknown[]) => {
      calls.push(params);
      return { rows: [{ id }], rowCount: 1 };
    },
  } as unknown as Pool;
  const store = new PgSearchPersistence(fake);
  const items = Array.from({ length: 501 }, (_, index) => ({ path: `/allowed/${index}` }));
  await store.finish({ ...owner, id }, {
    status: "completed", items, truncated: false, timedOut: false,
  });
  assert.equal((JSON.parse(calls[0]![5] as string) as unknown[]).length, 500);
  assert.equal(calls[0]![6], true);
  await store.finish({ ...owner, id }, {
    status: "completed", items: items.slice(0, 2), truncated: false, timedOut: false,
  });
  assert.deepEqual(JSON.parse(calls[1]![5] as string), items.slice(0, 2));
  assert.equal(calls[1]![6], false);
});

test("durable finish returns false when a stopped or expired row was not updated", async () => {
  const fake = {
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as Pool;
  const store = new PgSearchPersistence(fake);
  assert.equal(await store.finish({ ...owner, id }, {
    status: "completed", items: [{ path: "/allowed/must-not-reappear" }],
    truncated: false, timedOut: false,
  }), false);
});

test("cross-Gateway stop polling is scoped to the native owner and bounded IDs", async () => {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const fake = {
    query: async (sql: string, params: unknown[]) => {
      statements.push({ sql, params });
      return { rows: [{ id }], rowCount: 1 };
    },
  } as unknown as Pool;
  const store = new PgSearchPersistence(fake);
  assert.deepEqual(await store.stoppedIds([]), []);
  assert.equal(statements.length, 0);
  assert.deepEqual(await store.stoppedIds([id]), [id]);
  assert.match(statements[0]!.sql, /origin_instance=\$1/);
  assert.match(statements[0]!.sql, /id=any\(\$2::uuid\[\]\)/);
  assert.match(statements[0]!.sql, /status='stopped'/);
  assert.deepEqual(statements[0]!.params[1], [id]);
});

test("durable search allocation serializes actors across gateways and retains native stop slots", async () => {
  for (const occupied of [8, 7]) {
    const sql: Array<{ statement: string; params: unknown[] }> = [];
    let released = false;
    const client = {
      query: async (statement: string, params: unknown[] = []) => {
        sql.push({ statement, params });
        if (statement.includes("count(*)::integer")) {
          return { rows: [{ count: occupied }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      release: () => { released = true; },
    };
    const fake = { connect: async () => client } as unknown as Pool;
    const store = new PgSearchPersistence(fake);
    const sample = {
      ...owner, id, path: "/allowed", query: "needle", searchType: "files" as const,
      createdAt: Date.now(),
    };
    if (occupied === 8) {
      await assert.rejects(store.create(sample), /search_session_limit/);
      assert.ok(sql.some(x => x.statement === "rollback"));
      assert.ok(!sql.some(x => x.statement.includes("insert into search_sessions")));
    } else {
      await store.create(sample);
      assert.ok(sql.some(x => x.statement === "commit"));
      assert.ok(sql.some(x => x.statement.includes("insert into search_sessions")));
    }
    assert.equal(sql[0]!.statement, "begin");
    assert.ok(sql.some(x => x.statement.includes("pg_advisory_xact_lock")));
    assert.ok(sql.some(x =>
      x.statement.includes("s.native_inflight=true") &&
      x.statement.includes("s.organization_id=$1 and s.actor=$2") &&
      x.statement.includes("last_heartbeat_at")));
    assert.equal(released, true);
  }
});

test("settling a stopped scanner releases only the owned durable native slot", async () => {
  const calls: Array<{ statement: string; params: unknown[] }> = [];
  const fake = {
    query: async (statement: string, params: unknown[]) => {
      calls.push({ statement, params });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  await new PgSearchPersistence(fake).settleStopped({ ...owner, id });
  assert.match(calls[0]!.statement, /status='stopped' and native_inflight=true/);
  assert.match(calls[0]!.statement, /origin_instance=\$5/);
  assert.deepEqual(calls[0]!.params.slice(0, 4),
    [id, owner.organizationId, owner.actor, owner.deviceId]);
  assert.equal(typeof calls[0]!.params[4], "string");
});

