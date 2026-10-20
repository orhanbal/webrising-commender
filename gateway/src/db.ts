import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

export const db = new Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
});

export async function migrate() {
  await db.query(`
    create extension if not exists pgcrypto;

    create table if not exists organizations (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists api_tokens (
      id uuid primary key default gen_random_uuid(),
      organization_id uuid not null references organizations(id) on delete cascade,
      name text not null,
      role text not null check (role in ('viewer','operator','admin','owner')),
      token_hash text not null unique,
      created_by text not null,
      last_used_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz not null default now()
    );
    create index if not exists api_tokens_org_idx on api_tokens(organization_id);

    create table if not exists devices (
      id uuid primary key,
      organization_id uuid not null references organizations(id) on delete cascade,
      name text not null,
      hostname text not null default '',
      platform text not null default '',
      token_hash text not null,
      capabilities jsonb not null default '[]'::jsonb,
      agent_version text not null default '',
      last_seen_at timestamptz,
      created_at timestamptz not null default now(),
      revoked_at timestamptz
    );
    create index if not exists devices_org_idx on devices(organization_id);

    create table if not exists pairing_codes (
      id uuid primary key default gen_random_uuid(),
      organization_id uuid not null references organizations(id) on delete cascade,
      code_hash text not null unique,
      expires_at timestamptz not null,
      used_at timestamptz,
      created_at timestamptz not null default now()
    );

    create table if not exists approvals (
      id uuid primary key default gen_random_uuid(),
      organization_id uuid not null references organizations(id) on delete cascade,
      device_id uuid not null references devices(id) on delete cascade,
      action text not null,
      nonce text not null unique,
      expires_at timestamptz not null,
      consumed_at timestamptz,
      created_at timestamptz not null default now()
    );
    alter table approvals add column if not exists consumed_at timestamptz;

    create table if not exists approval_requests (
      id uuid primary key default gen_random_uuid(),
      organization_id uuid not null references organizations(id) on delete cascade,
      device_id uuid not null references devices(id) on delete cascade,
      requested_by text not null,
      action_kind text not null,
      action jsonb not null,
      status text not null default 'pending'
        check (status in ('pending','approved','denied','consumed','expired')),
      expires_at timestamptz not null,
      decided_by text,
      decided_at timestamptz,
      consumed_at timestamptz,
      created_at timestamptz not null default now()
    );
    create index if not exists approval_requests_org_status_idx
      on approval_requests(organization_id,status,created_at desc);

    create table if not exists audit_logs (
      id bigserial primary key,
      organization_id uuid references organizations(id) on delete set null,
      actor text not null,
      device_id uuid,
      tool text not null,
      risk text not null,
      outcome text not null,
      detail text not null default '',
      created_at timestamptz not null default now()
    );
    create index if not exists audit_logs_created_idx on audit_logs(created_at desc);

    insert into organizations(name)
      select 'Self Hosted'
      where not exists(select 1 from organizations);
  `);
}

export async function defaultOrganizationId(): Promise<string> {
  const result = await db.query<{ id: string }>("select id from organizations order by created_at asc limit 1");
  const row = result.rows[0];
  if (!row) throw new Error("default organization missing");
  return row.id;
}

export async function ready() {
  const result = await db.query("select 1 as ok");
  return result.rowCount === 1;
}

function auditRetentionDays() {
  const value = Number(process.env.AUDIT_RETENTION_DAYS ?? 90);
  if (!Number.isFinite(value) || value < 0) return 90;
  return Math.min(3650, Math.floor(value));
}

export async function housekeeping() {
  await db.query("delete from pairing_codes where expires_at < now() or used_at < now() - interval '1 day'");
  await db.query("delete from approvals where expires_at < now() - interval '1 day'");
  await db.query(
    "update approval_requests set status='expired' where status in ('pending','approved') and expires_at<=now()",
  );
  await db.query(
    "delete from approval_requests where created_at < now() - interval '30 days'",
  );

  const retentionDays = auditRetentionDays();
  if (retentionDays > 0) {
    await db.query(
      "delete from audit_logs where created_at < now() - ($1::int * interval '1 day')",
      [retentionDays],
    );
  }
}
