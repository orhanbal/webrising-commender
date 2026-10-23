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
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_advisory_xact_lock(hashtext('webrising-commender:migrate'))",
    );
    await client.query(`
    create extension if not exists pgcrypto;

    create table if not exists organizations (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      created_at timestamptz not null default now()
    );

    alter table organizations add column if not exists relay_region text;

    create table if not exists relay_nodes (
      id text primary key,
      region text not null,
      public_ws_url text not null,
      internal_base_url text not null,
      max_devices integer not null default 10000 check (max_devices>0),
      enabled boolean not null default true,
      drain boolean not null default false,
      last_seen_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists relay_nodes_region_health_idx
      on relay_nodes(region,enabled,drain,last_seen_at desc);

    create table if not exists users (
      id uuid primary key default gen_random_uuid(),
      email text not null,
      password_hash text not null,
      disabled_at timestamptz,
      last_login_at timestamptz,
      created_at timestamptz not null default now()
    );
    create unique index if not exists users_email_lower_uidx on users(lower(email));

    alter table users add column if not exists email_verified_at timestamptz;
    update users set email_verified_at=coalesce(email_verified_at,created_at,now())
      where email_verified_at is null;

    create table if not exists pending_signups (
      id uuid primary key default gen_random_uuid(),
      email text not null,
      password_hash text not null,
      workspace_name text not null,
      token_hash text not null unique,
      expires_at timestamptz not null,
      consumed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index if not exists pending_signups_email_lower_uidx
      on pending_signups(lower(email));
    create index if not exists pending_signups_expiry_idx
      on pending_signups(expires_at);

    create table if not exists auth_tokens (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      purpose text not null check (purpose in ('password_reset')),
      token_hash text not null unique,
      expires_at timestamptz not null,
      consumed_at timestamptz,
      created_at timestamptz not null default now()
    );
    create index if not exists auth_tokens_user_purpose_idx
      on auth_tokens(user_id,purpose,created_at desc);

    create table if not exists mail_outbox (
      id bigserial primary key,
      recipient_hash text not null,
      payload_nonce text not null,
      payload_ciphertext text not null,
      payload_tag text not null,
      attempts integer not null default 0,
      next_attempt_at timestamptz not null default now(),
      locked_at timestamptz,
      locked_by text,
      sent_at timestamptz,
      failed_at timestamptz,
      last_error text,
      created_at timestamptz not null default now()
    );
    create index if not exists mail_outbox_delivery_idx
      on mail_outbox(sent_at,next_attempt_at,created_at)
      where sent_at is null;
    alter table mail_outbox add column if not exists failed_at timestamptz;

    create table if not exists organization_members (
      organization_id uuid not null references organizations(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      role text not null check (role in ('viewer','operator','admin','owner')),
      created_at timestamptz not null default now(),
      primary key (organization_id,user_id)
    );
    create index if not exists organization_members_user_idx on organization_members(user_id);

    create table if not exists platform_administrators (
      user_id uuid primary key references users(id) on delete cascade,
      granted_at timestamptz not null default now(),
      granted_by text not null,
      revoked_at timestamptz
    );
    create table if not exists platform_admin_audit (
      id bigserial primary key,
      actor_user_id uuid references users(id) on delete set null,
      action text not null,
      detail text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists browser_sessions (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      organization_id uuid not null references organizations(id) on delete cascade,
      token_hash text not null unique,
      csrf_hash text not null,
      expires_at timestamptz not null,
      last_seen_at timestamptz not null default now(),
      revoked_at timestamptz,
      created_at timestamptz not null default now()
    );
    create index if not exists browser_sessions_user_idx on browser_sessions(user_id);
    create index if not exists browser_sessions_expiry_idx on browser_sessions(expires_at);

    create table if not exists invitations (
      id uuid primary key default gen_random_uuid(),
      organization_id uuid not null references organizations(id) on delete cascade,
      email text not null,
      role text not null check (role in ('viewer','operator','admin','owner')),
      token_hash text not null unique,
      created_by text not null,
      expires_at timestamptz not null,
      accepted_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz not null default now()
    );
    create index if not exists invitations_org_idx on invitations(organization_id,created_at desc);
    create index if not exists invitations_email_idx on invitations(lower(email));
    create index if not exists invitations_expiry_idx on invitations(expires_at);

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

    alter table devices add column if not exists assigned_relay_id text;
    alter table devices add column if not exists connected_relay_id text;
    alter table devices add column if not exists relay_last_seen_at timestamptz;

    create index if not exists devices_assigned_relay_idx
      on devices(assigned_relay_id)
      where assigned_relay_id is not null and revoked_at is null;
    create index if not exists devices_connected_relay_idx
      on devices(connected_relay_id,relay_last_seen_at)
      where connected_relay_id is not null and revoked_at is null;

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

    create table if not exists billing_plans (
      key text primary key,
      name text not null,
      max_devices integer check (max_devices is null or max_devices>=0),
      max_members integer check (max_members is null or max_members>=0),
      max_api_tokens integer check (max_api_tokens is null or max_api_tokens>=0),
      metadata jsonb not null default '{}'::jsonb,
      active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists organization_subscriptions (
      organization_id uuid primary key references organizations(id) on delete cascade,
      plan_key text not null references billing_plans(key),
      status text not null
        check (status in ('trialing','active','past_due','paused','canceled')),
      provider text,
      external_customer_id text,
      external_subscription_id text,
      current_period_end timestamptz,
      cancel_at_period_end boolean not null default false,
      provider_event_at timestamptz,
      provider_event_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index if not exists organization_subscriptions_provider_uidx
      on organization_subscriptions(provider,external_subscription_id)
      where provider is not null and external_subscription_id is not null;

    alter table organization_subscriptions
      add column if not exists provider_event_at timestamptz;
    alter table organization_subscriptions
      add column if not exists provider_event_id text;

    -- Checkout intents bind Paddle-created transaction IDs to authenticated
    -- workspaces. Webhooks may never provision from untrusted browser metadata.
    create table if not exists paddle_checkout_intents (
      transaction_id text primary key,
      organization_id uuid not null references organizations(id) on delete cascade,
      plan_key text not null references billing_plans(key),
      price_id text not null,
      created_at timestamptz not null default now()
    );
    create index if not exists paddle_checkout_intents_org_idx
      on paddle_checkout_intents(organization_id,created_at desc);

    alter table organization_subscriptions drop constraint if exists organization_subscriptions_status_check;
    alter table organization_subscriptions add constraint organization_subscriptions_status_check
      check (status in ('trialing','active','past_due','paused','canceled'));

    create table if not exists billing_events (
      id bigserial primary key,
      provider text not null,
      event_id text not null,
      event_type text not null,
      organization_id uuid not null references organizations(id) on delete cascade,
      payload_hash text not null,
      normalized_event jsonb not null,
      disposition text not null default 'received'
        check (disposition in ('received','applied','stale','provider_mismatch','order_conflict')),
      created_at timestamptz not null default now(),
      unique(provider,event_id)
    );
    create index if not exists billing_events_org_idx
      on billing_events(organization_id,created_at desc);

    alter table billing_events
      add column if not exists disposition text not null default 'received';

    alter table billing_events
      drop constraint if exists billing_events_disposition_check;
    alter table billing_events
      add constraint billing_events_disposition_check
      check (disposition in ('received','applied','stale','provider_mismatch','order_conflict'));

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

    const constraints = [
      ["devices_assigned_relay_fk", "assigned_relay_id"],
      ["devices_connected_relay_fk", "connected_relay_id"],
    ] as const;

    for (const [constraintName, columnName] of constraints) {
      const exists = await client.query(
        `select 1
           from pg_constraint
          where conname=$1
            and conrelid='devices'::regclass`,
        [constraintName],
      );
      if (!exists.rowCount) {
        await client.query(
          `alter table devices
             add constraint ${constraintName}
             foreign key (${columnName})
             references relay_nodes(id)
             on delete set null`,
        );
      }
    }

    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
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
    "delete from browser_sessions where expires_at < now() - interval '1 day' or revoked_at < now() - interval '1 day'",
  );
  await db.query(
    "delete from invitations where (expires_at < now() - interval '7 days') or (accepted_at < now() - interval '30 days') or (revoked_at < now() - interval '30 days')",
  );
  await db.query(
    "delete from pending_signups where expires_at < now() - interval '7 days' or consumed_at < now() - interval '7 days'",
  );
  await db.query(
    "delete from auth_tokens where expires_at < now() - interval '7 days' or consumed_at < now() - interval '7 days'",
  );
  await db.query(
    "update mail_outbox set locked_at=null,locked_by=null where sent_at is null and failed_at is null and locked_at < now() - interval '10 minutes'",
  );
  await db.query(
    "delete from mail_outbox where sent_at < now() - interval '30 days' or failed_at < now() - interval '30 days'",
  );
  await db.query(
    `update approval_requests
        set status='expired',
            action=jsonb_build_object('kind',action_kind,'redacted',true)
      where status in ('pending','approved')
        and expires_at<=now()`,
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
