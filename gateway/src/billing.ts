import type { PoolClient } from "pg";
import { db } from "./db.js";
import { sha256 } from "./crypto-utils.js";

export type DeploymentMode = "self_hosted" | "saas";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";
export type AllocationResource = "device" | "member" | "member_accept" | "api_token";

type Queryable = typeof db | PoolClient;

const rawMode = String(process.env.DEPLOYMENT_MODE || "self_hosted")
  .trim()
  .toLowerCase()
  .replaceAll("-", "_");

if (rawMode !== "self_hosted" && rawMode !== "saas") {
  throw new Error("DEPLOYMENT_MODE must be self_hosted or saas");
}

export const deploymentMode = rawMode as DeploymentMode;

export type BillingPlanInput = {
  key: string;
  name: string;
  maxDevices: number | null;
  maxMembers: number | null;
  maxApiTokens: number | null;
  metadata?: Record<string, unknown>;
  active?: boolean;
};

export type SubscriptionInput = {
  organizationId: string;
  planKey: string;
  status: SubscriptionStatus;
  provider?: string | null;
  externalCustomerId?: string | null;
  externalSubscriptionId?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
};

export type NormalizedBillingEvent = {
  provider: string;
  eventId: string;
  eventType: string;
  organizationId: string;
  subscription: Omit<SubscriptionInput, "organizationId" | "provider">;
};

function count(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function billingSnapshot(organizationId: string, queryable: Queryable = db) {
  const usageResult = await queryable.query<{
    devices: string;
    members: string;
    pending_invitations: string;
    api_tokens: string;
  }>(
    `select
       (select count(*)::text from devices where organization_id=$1 and revoked_at is null) as devices,
       (select count(*)::text from organization_members where organization_id=$1) as members,
       (select count(*)::text from invitations
         where organization_id=$1
           and accepted_at is null
           and revoked_at is null
           and expires_at>now()) as pending_invitations,
       (select count(*)::text from api_tokens where organization_id=$1 and revoked_at is null) as api_tokens`,
    [organizationId],
  );
  const usageRow = usageResult.rows[0];
  const usage = {
    devices: count(usageRow?.devices),
    members: count(usageRow?.members),
    pendingInvitations: count(usageRow?.pending_invitations),
    apiTokens: count(usageRow?.api_tokens),
  };

  if (deploymentMode === "self_hosted") {
    return {
      mode: deploymentMode,
      entitled: true,
      reason: null,
      plan: {
        key: "self_hosted",
        name: "Self Hosted",
        active: true,
        metadata: {},
      },
      subscription: {
        status: "active",
        provider: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      },
      limits: {
        maxDevices: null,
        maxMembers: null,
        maxApiTokens: null,
      },
      usage,
    };
  }

  const result = await queryable.query<{
    plan_key: string;
    plan_name: string;
    plan_active: boolean;
    max_devices: number | null;
    max_members: number | null;
    max_api_tokens: number | null;
    metadata: Record<string, unknown>;
    status: SubscriptionStatus;
    provider: string | null;
    external_customer_id: string | null;
    external_subscription_id: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    updated_at: string;
  }>(
    `select s.plan_key,
            p.name as plan_name,
            p.active as plan_active,
            p.max_devices,
            p.max_members,
            p.max_api_tokens,
            p.metadata,
            s.status,
            s.provider,
            s.external_customer_id,
            s.external_subscription_id,
            s.current_period_end,
            s.cancel_at_period_end,
            s.updated_at
       from organization_subscriptions s
       join billing_plans p on p.key=s.plan_key
      where s.organization_id=$1
      limit 1`,
    [organizationId],
  );

  const row = result.rows[0];
  if (!row) {
    return {
      mode: deploymentMode,
      entitled: false,
      reason: "billing_required",
      plan: null,
      subscription: null,
      limits: {
        maxDevices: 0,
        maxMembers: 0,
        maxApiTokens: 0,
      },
      usage,
    };
  }

  const periodValid =
    row.current_period_end === null || new Date(row.current_period_end).getTime() > Date.now();
  const entitled =
    row.plan_active &&
    (row.status === "active" || row.status === "trialing") &&
    periodValid;

  return {
    mode: deploymentMode,
    entitled,
    reason: entitled ? null : "billing_required",
    plan: {
      key: row.plan_key,
      name: row.plan_name,
      active: row.plan_active,
      metadata: row.metadata ?? {},
    },
    subscription: {
      status: row.status,
      provider: row.provider,
      externalCustomerId: row.external_customer_id,
      externalSubscriptionId: row.external_subscription_id,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      updatedAt: row.updated_at,
    },
    limits: {
      maxDevices: row.max_devices,
      maxMembers: row.max_members,
      maxApiTokens: row.max_api_tokens,
    },
    usage,
  };
}

export async function allocationDecision(
  organizationId: string,
  resource: AllocationResource,
  queryable: Queryable = db,
) {
  const snapshot = await billingSnapshot(organizationId, queryable);
  if (!snapshot.entitled) {
    return {
      allowed: false,
      reason: "billing_required" as const,
      resource: resource === "member_accept" ? "member" : resource,
      limit: 0,
      used: 0,
      snapshot,
    };
  }

  let limit: number | null;
  let used: number;
  if (resource === "device") {
    limit = snapshot.limits.maxDevices;
    used = snapshot.usage.devices;
  } else if (resource === "api_token") {
    limit = snapshot.limits.maxApiTokens;
    used = snapshot.usage.apiTokens;
  } else if (resource === "member_accept") {
    limit = snapshot.limits.maxMembers;
    used = snapshot.usage.members;
  } else {
    limit = snapshot.limits.maxMembers;
    used = snapshot.usage.members + snapshot.usage.pendingInvitations;
  }

  if (limit === null) {
    return {
      allowed: true,
      reason: null,
      resource: resource === "member_accept" ? "member" : resource,
      limit,
      used,
      snapshot,
    };
  }

  return {
    allowed: used < limit,
    reason: used < limit ? null : ("quota_exceeded" as const),
    resource: resource === "member_accept" ? "member" : resource,
    limit,
    used,
    snapshot,
  };
}

export async function upsertBillingPlan(input: BillingPlanInput, queryable: Queryable = db) {
  const result = await queryable.query(
    `insert into billing_plans(
         key,name,max_devices,max_members,max_api_tokens,metadata,active,updated_at
       )
       values($1,$2,$3,$4,$5,$6::jsonb,$7,now())
       on conflict(key)
       do update set
         name=excluded.name,
         max_devices=excluded.max_devices,
         max_members=excluded.max_members,
         max_api_tokens=excluded.max_api_tokens,
         metadata=excluded.metadata,
         active=excluded.active,
         updated_at=now()
       returning key,name,max_devices,max_members,max_api_tokens,metadata,active,created_at,updated_at`,
    [
      input.key,
      input.name,
      input.maxDevices,
      input.maxMembers,
      input.maxApiTokens,
      JSON.stringify(input.metadata ?? {}),
      input.active ?? true,
    ],
  );
  return result.rows[0];
}

export async function upsertSubscription(input: SubscriptionInput, queryable: Queryable = db) {
  if (
    !input.provider &&
    (input.externalCustomerId || input.externalSubscriptionId)
  ) {
    throw Object.assign(new Error("billing_provider_required"), { status: 400 });
  }

  const plan = await queryable.query<{ key: string; active: boolean }>(
    "select key,active from billing_plans where key=$1",
    [input.planKey],
  );
  if (!plan.rows[0]) throw Object.assign(new Error("billing_plan_not_found"), { status: 404 });
  if (!plan.rows[0].active) throw Object.assign(new Error("billing_plan_inactive"), { status: 409 });

  const organization = await queryable.query("select 1 from organizations where id=$1", [
    input.organizationId,
  ]);
  if (!organization.rowCount) {
    throw Object.assign(new Error("organization_not_found"), { status: 404 });
  }

  const result = await queryable.query(
    `insert into organization_subscriptions(
         organization_id,plan_key,status,provider,external_customer_id,external_subscription_id,
         current_period_end,cancel_at_period_end,updated_at
       )
       values($1,$2,$3,$4,$5,$6,$7,$8,now())
       on conflict(organization_id)
       do update set
         plan_key=excluded.plan_key,
         status=excluded.status,
         provider=excluded.provider,
         external_customer_id=excluded.external_customer_id,
         external_subscription_id=excluded.external_subscription_id,
         current_period_end=excluded.current_period_end,
         cancel_at_period_end=excluded.cancel_at_period_end,
         updated_at=now()
       returning organization_id,plan_key,status,provider,external_customer_id,
                 external_subscription_id,current_period_end,cancel_at_period_end,created_at,updated_at`,
    [
      input.organizationId,
      input.planKey,
      input.status,
      input.provider ?? null,
      input.externalCustomerId ?? null,
      input.externalSubscriptionId ?? null,
      input.currentPeriodEnd ?? null,
      input.cancelAtPeriodEnd ?? false,
    ],
  );
  return result.rows[0];
}

export async function applyNormalizedBillingEvent(event: NormalizedBillingEvent) {
  const client = await db.connect();
  const payloadHash = sha256(JSON.stringify(event));
  try {
    await client.query("begin");
    const organization = await client.query(
      "select id from organizations where id=$1 for update",
      [event.organizationId],
    );
    if (!organization.rowCount) {
      await client.query("rollback");
      throw Object.assign(new Error("organization_not_found"), { status: 404 });
    }

    const inserted = await client.query(
      `insert into billing_events(
         provider,event_id,event_type,organization_id,payload_hash,normalized_event
       )
       values($1,$2,$3,$4,$5,$6::jsonb)
       on conflict(provider,event_id) do nothing
       returning id`,
      [
        event.provider,
        event.eventId,
        event.eventType,
        event.organizationId,
        payloadHash,
        JSON.stringify(event),
      ],
    );

    if (!inserted.rows[0]) {
      const existing = await client.query<{ payload_hash: string }>(
        "select payload_hash from billing_events where provider=$1 and event_id=$2",
        [event.provider, event.eventId],
      );
      await client.query("rollback");
      if (existing.rows[0]?.payload_hash !== payloadHash) {
        throw Object.assign(new Error("billing_event_conflict"), { status: 409 });
      }
      return { applied: false, duplicate: true };
    }

    const subscription = await upsertSubscription(
      {
        organizationId: event.organizationId,
        ...event.subscription,
        provider: event.provider,
      },
      client,
    );
    await client.query("commit");
    return { applied: true, duplicate: false, subscription };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}
