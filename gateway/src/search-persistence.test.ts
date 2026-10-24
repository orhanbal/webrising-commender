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
      rows: [{ ...sampleRow, status: "running", origin_alive: true }],
      rowCount: 1,
    }),
  } as unknown as Pool;
  const observer = new PgSearchPersistence(fake);
  const page = await observer.page(owner, id, 0, 10);
  assert.equal(page.status, "running");
  assert.equal(page.error, undefined);
  assert.deepEqual(page.items, []);
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
  assert.match(sql[0]!.statement, /set status='stopped',items='\[\]'::jsonb/);
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
  assert.equal(sql[0]!.params[5], "[]");
  assert.equal(sql[0]!.params[6], true);
  assert.match(sql[0]!.statement, /returning id/);
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
