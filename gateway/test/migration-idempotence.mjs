import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let transactionOpen = false;
try {
  const before = await client.query(
    "select count(*)::int as count from commender_schema_migrations",
  );
  assert.ok(before.rows[0].count >= 1, "startup must stamp the applied schema");

  // Hold an exclusive lock on a live table. A repeated migration of the
  // unchanged schema must complete without touching this locked table.
  // Previously, repeated ALTER TABLE/CREATE INDEX on every Gateway restart
  // could deadlock with audit writes during relay recovery.
  await client.query("begin");
  transactionOpen = true;
  await client.query("lock table organizations in access exclusive mode");
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { migrate, db } from './dist/db.js'; try { await migrate(); } finally { await db.end(); }",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      timeout: 7_000,
    },
  );
  assert.equal(
    child.status,
    0,
    `unchanged migration blocked by live table lock: ${child.error?.message || child.stderr || child.stdout}`,
  );
  await client.query("rollback");
  transactionOpen = false;

  const after = await client.query(
    "select count(*)::int as count from commender_schema_migrations",
  );
  assert.equal(after.rows[0].count, before.rows[0].count);
  console.log("migration-e2e: unchanged Gateway restart skipped live-table DDL");
} finally {
  if (transactionOpen) await client.query("rollback").catch(() => {});
  await client.end();
}
