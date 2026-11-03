// Coolify MCP tools and console decisions. See coolify-client.ts for the
// verified Coolify 4.5.3 API contract and the trust boundary.

import { db } from "./db.js";
import type { Principal } from "./auth.js";
import {
  COOLIFY_CONFIG_FIELDS, CoolifyClient, CoolifyError, FIELD_IMPACT, RELEASE_POLICY,
  changeDigest, coolifySettingsFromEnv, releaseInvariantViolation, safePatchSteps, extractConfiguration, policyAudit, projectApplication, validateChange,
  type CoolifyConfigField, type ConfigChange,
} from "./coolify-client.js";

export { coolifySettingsFromEnv, CoolifyClient };
const CHANGE_REQUEST_TTL_MINUTES = 30;

// ---------------------------------------------------------------------------
// MCP tools

export const COOLIFY_TOOL_NAMES = [
  "coolify_get_application",
  "coolify_get_configuration",
  "coolify_list_deployments",
  "coolify_get_deployment",
  "coolify_get_health",
  "coolify_propose_configuration_change",
  "coolify_apply_configuration_change",
  "coolify_get_change_request",
  "coolify_deploy",
  "coolify_rollback",
] as const;

const appProp = { application_uuid: { type: "string", pattern: "^[a-z0-9]{16,40}$" } };
function def(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    ...(process.env.MCP_OAUTH_ENABLED === "true" ? { securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }] } : {}),
  };
}

export function coolifyToolDefinitions() {
  return [
    def("coolify_get_application", "Platform administrators only. Read a safe projection of an allowlisted Coolify application (status, branch, release settings). Read-only.", appProp, ["application_uuid"]),
    def("coolify_get_configuration", "Platform administrators only. Read the four release settings (git_branch, is_auto_deploy_enabled, include_source_commit_in_build, use_build_secrets) and compare them with the WECOMMANDER release policy. Read-only.", appProp, ["application_uuid"]),
    def("coolify_list_deployments", "Platform administrators only. List recent deployments (uuid, status, commit, timestamps; never logs). Read-only.", { ...appProp, skip: { type: "integer", minimum: 0, maximum: 1000 }, take: { type: "integer", minimum: 1, maximum: 50 } }, ["application_uuid"]),
    def("coolify_get_deployment", "Platform administrators only. Read one deployment's status, scoped to the allowlisted application. Read-only.", { ...appProp, deployment_uuid: { type: "string", pattern: "^[A-Za-z0-9-]{8,64}$" } }, ["application_uuid", "deployment_uuid"]),
    def("coolify_get_health", "Platform administrators only. Read Coolify container status and the newest deployment, plus the commit this gateway was built from. Read-only.", appProp, ["application_uuid"]),
    def("coolify_propose_configuration_change", "Platform administrators only. Create a pending change request for release settings. Shows the exact diff, impact and rollback. Changes nothing until a platform administrator approves it in the console with their password.", {
      ...appProp,
      changes: {
        type: "object",
        additionalProperties: false,
        properties: {
          git_branch: { type: "string" },
          is_auto_deploy_enabled: { type: "boolean" },
          include_source_commit_in_build: { type: "boolean" },
          use_build_secrets: { type: "boolean" },
        },
      },
      reason: { type: "string", minLength: 3, maxLength: 500 },
    }, ["application_uuid", "changes", "reason"]),
    def("coolify_apply_configuration_change", "Platform administrators only. Apply an approved change request exactly once: re-checks current values, sends only the approved fields (never deploys), then re-reads Coolify to verify.", { request_id: { type: "string", format: "uuid" } }, ["request_id"]),
    def("coolify_get_change_request", "Platform administrators only. Read a Coolify change request and its status.", { request_id: { type: "string", format: "uuid" } }, ["request_id"]),
    def("coolify_deploy", "Always refused: production deployments go through the GitHub promote-production workflow.", appProp, ["application_uuid"]),
    def("coolify_rollback", "Always refused: production rollbacks go through promote-production in rollback mode.", appProp, ["application_uuid"]),
  ];
}

export function isCoolifyTool(name: string) {
  return (COOLIFY_TOOL_NAMES as readonly string[]).includes(name);
}

export async function isPlatformAdministrator(principal: Principal) {
  if (!principal.userId) return false;
  const result = await db.query(
    `select 1 from platform_administrators p join users u on u.id=p.user_id
      where p.user_id=$1 and p.revoked_at is null and u.disabled_at is null limit 1`,
    [principal.userId],
  );
  return Boolean(result.rowCount);
}

async function audit(principal: Principal, tool: string, risk: string, outcome: string, detail: Record<string, unknown>) {
  await db.query(
    "insert into audit_logs(organization_id,actor,device_id,tool,risk,outcome,detail) values($1,$2,null,$3,$4,$5,$6)",
    [principal.organizationId, principal.actor, tool, risk, outcome, JSON.stringify(detail).slice(0, 4000)],
  );
}

type ToolOutcome = { data: unknown; isError?: boolean };

let clientOverride: CoolifyClient | null = null;
export function setCoolifyClientForTests(client: CoolifyClient | null) { clientOverride = client; }
function currentClient(): CoolifyClient | null {
  if (clientOverride) return clientOverride;
  const settings = coolifySettingsFromEnv();
  return settings ? new CoolifyClient(settings) : null;
}

const RISK: Record<string, string> = {
  coolify_propose_configuration_change: "medium",
  coolify_apply_configuration_change: "high",
  coolify_deploy: "high",
  coolify_rollback: "high",
};

export async function handleCoolifyTool(name: string, args: any, principal: Principal): Promise<ToolOutcome> {
  const risk = RISK[name] ?? "low";
  const appUuid = typeof args?.application_uuid === "string" ? args.application_uuid : undefined;
  if (!(await isPlatformAdministrator(principal))) {
    await audit(principal, name, risk, "denied", { reason: "platform_admin_required", applicationUuid: appUuid });
    return { data: { error: "platform_admin_required" }, isError: true };
  }
  if (name === "coolify_deploy" || name === "coolify_rollback") {
    await audit(principal, name, risk, "denied", { reason: "use_promote_production", applicationUuid: appUuid });
    return {
      isError: true,
      data: {
        error: "production_release_requires_promote_production",
        message: "Coolify deploy and rollback are not available to AI clients. Run the GitHub workflow promote-production (mode promote or rollback); it requires the production environment approval and verifies /health build.commit.",
        workflow: ".github/workflows/promote-production.yml",
      },
    };
  }
  const client = currentClient();
  if (!client) {
    await audit(principal, name, risk, "error", { reason: "coolify_not_configured" });
    return { data: { error: "coolify_not_configured" }, isError: true };
  }
  try {
    if (name === "coolify_get_change_request") return await getChangeRequest(args, principal);
    if (name === "coolify_apply_configuration_change") return await applyChange(client, args, principal);

    if (!appUuid || !client.isAllowed(appUuid)) {
      await audit(principal, name, risk, "denied", { reason: "application_not_allowed", applicationUuid: String(appUuid ?? "").slice(0, 64) });
      return { data: { error: "application_not_allowed" }, isError: true };
    }
    let data: unknown;
    if (name === "coolify_get_application") {
      data = projectApplication(await client.getApplication(appUuid));
    } else if (name === "coolify_get_configuration") {
      const { config, unverifiable } = extractConfiguration(await client.getApplication(appUuid));
      const checks = policyAudit(config, unverifiable);
      const invariantOk = !unverifiable.includes("git_branch") && !unverifiable.includes("is_auto_deploy_enabled") && !releaseInvariantViolation(config);
      data = { application_uuid: appUuid, configuration: config, unverifiable_fields: unverifiable, policy: RELEASE_POLICY, checks, compliant: checks.every((c) => c.compliant), release_invariant: { rule: "Auto Deploy only with git_branch=production", ok: invariantOk } };
    } else if (name === "coolify_list_deployments") {
      const skip = args.skip ?? 0;
      const take = args.take ?? 10;
      if (!Number.isInteger(skip) || skip < 0 || skip > 1000 || !Number.isInteger(take) || take < 1 || take > 50) {
        return { data: { error: "invalid_page" }, isError: true };
      }
      data = await client.listDeployments(appUuid, skip, take);
    } else if (name === "coolify_get_deployment") {
      const deploymentUuid = String(args.deployment_uuid || "");
      if (!/^[A-Za-z0-9-]{8,64}$/.test(deploymentUuid)) return { data: { error: "invalid_deployment_uuid" }, isError: true };
      // Scope by listing the allowlisted application's own deployments, so a
      // deployment uuid from another application is never resolved.
      const page = await client.listDeployments(appUuid, 0, 50);
      const found = page.deployments.find((d: any) => d.deployment_uuid === deploymentUuid);
      if (!found) {
        await audit(principal, name, risk, "denied", { reason: "deployment_not_found_for_application", applicationUuid: appUuid });
        return { data: { error: "deployment_not_found" }, isError: true };
      }
      data = found;
    } else if (name === "coolify_get_health") {
      const app = await client.getApplication(appUuid);
      const page = await client.listDeployments(appUuid, 0, 1);
      const status = typeof app.status === "string" ? app.status : null;
      data = {
        application_uuid: appUuid,
        coolify_status: status,
        healthy: status === "running:healthy",
        latest_deployment: page.deployments[0] ?? null,
        gateway_build_commit: /^[0-9a-f]{40}$/.test(process.env.WECOMMANDER_BUILD_COMMIT || "") ? process.env.WECOMMANDER_BUILD_COMMIT : "unknown",
      };
    } else if (name === "coolify_propose_configuration_change") {
      return await proposeChange(client, appUuid, args, principal);
    } else {
      return { data: { error: "unknown_tool" }, isError: true };
    }
    await audit(principal, name, risk, "success", { applicationUuid: appUuid });
    return { data };
  } catch (error) {
    const code = error instanceof CoolifyError ? error.code : "coolify_internal_error";
    await audit(principal, name, risk, "error", { applicationUuid: appUuid, error: code });
    return { data: { error: code }, isError: true };
  }
}

async function proposeChange(client: CoolifyClient, appUuid: string, args: any, principal: Principal): Promise<ToolOutcome> {
  const requested = validateChange(args.changes);
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (reason.length < 3 || reason.length > 500) throw new CoolifyError("invalid_reason");
  const { config, unverifiable } = extractConfiguration(await client.getApplication(appUuid));
  const touched = Object.keys(requested) as CoolifyConfigField[];
  if (touched.some((field) => unverifiable.includes(field))) throw new CoolifyError("current_value_unverifiable");
  const before: ConfigChange = {};
  const after: ConfigChange = {};
  for (const field of touched) {
    if (config[field] === requested[field]) continue;
    (before as any)[field] = config[field];
    (after as any)[field] = requested[field];
  }
  if (!Object.keys(after).length) {
    await audit(principal, "coolify_propose_configuration_change", "medium", "success", { applicationUuid: appUuid, noChange: true });
    return { data: { status: "no_change", configuration: config } };
  }
  // The resulting state must keep the release invariant. Both fields must be
  // readable to decide; otherwise fail closed.
  if (unverifiable.includes("git_branch") || unverifiable.includes("is_auto_deploy_enabled")) {
    throw new CoolifyError("current_value_unverifiable");
  }
  const resulting = { ...config, ...after };
  if (releaseInvariantViolation(resulting)) {
    await audit(principal, "coolify_propose_configuration_change", "medium", "denied", { applicationUuid: appUuid, reason: "release_invariant_violation", resulting: { git_branch: resulting.git_branch, is_auto_deploy_enabled: resulting.is_auto_deploy_enabled } });
    return { isError: true, data: { error: "release_invariant_violation", message: "Auto Deploy may only be on while Git Branch is `production`.", resulting: { git_branch: resulting.git_branch, is_auto_deploy_enabled: resulting.is_auto_deploy_enabled } } };
  }
  const digest = changeDigest(appUuid, before, after);
  const inserted = await db.query<{ id: string; expires_at: Date }>(
    `insert into coolify_change_requests(application_uuid,requested_by_user,requested_by_actor,before_values,after_values,digest,reason,expires_at)
     values($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,now()+($8::int*interval '1 minute')) returning id,expires_at`,
    [appUuid, principal.userId, principal.actor, JSON.stringify(before), JSON.stringify(after), digest, reason, CHANGE_REQUEST_TTL_MINUTES],
  );
  const row = inserted.rows[0]!;
  await audit(principal, "coolify_propose_configuration_change", "medium", "pending_approval", { applicationUuid: appUuid, requestId: row.id, digest, fields: Object.keys(after) });
  return {
    data: {
      status: "pending_approval",
      request_id: row.id,
      expires_at: row.expires_at,
      digest,
      application_uuid: appUuid,
      diff: Object.keys(after).map((field) => ({
        field,
        from: (before as any)[field],
        to: (after as any)[field],
        impact: FIELD_IMPACT[field as CoolifyConfigField],
      })),
      rollback: { changes: before, how: "Propose the 'changes' above as a new change request and approve it; nothing is reverted automatically." },
      deploys: false,
      approval: "A platform administrator must approve this exact request in Console → System → Coolify change requests (password required). Then call coolify_apply_configuration_change with request_id.",
    },
  };
}

async function getChangeRequest(args: any, principal: Principal): Promise<ToolOutcome> {
  const id = String(args?.request_id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { data: { error: "invalid_request_id" }, isError: true };
  const result = await db.query(
    `select id,application_uuid,requested_by_actor,before_values,after_values,digest,reason,status,expires_at,
            decided_at,applied_at,verification from coolify_change_requests where id=$1`, [id],
  );
  if (!result.rowCount) return { data: { error: "change_request_not_found" }, isError: true };
  await audit(principal, "coolify_get_change_request", "low", "success", { requestId: id });
  return { data: result.rows[0] };
}

async function applyChange(client: CoolifyClient, args: any, principal: Principal): Promise<ToolOutcome> {
  const id = String(args?.request_id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { data: { error: "invalid_request_id" }, isError: true };
  // Single use: claim the approved request atomically before talking to Coolify.
  const claimed = await db.query<{ application_uuid: string; before_values: ConfigChange; after_values: ConfigChange; digest: string }>(
    `update coolify_change_requests set status='applying', consumed_at=now()
      where id=$1 and status='approved' and consumed_at is null and expires_at>now()
      returning application_uuid,before_values,after_values,digest`, [id],
  );
  const row = claimed.rows[0];
  if (!row) {
    const existing = await db.query("select status,expires_at from coolify_change_requests where id=$1", [id]);
    const reason = existing.rowCount ? "change_request_not_approved_or_used" : "change_request_not_found";
    await audit(principal, "coolify_apply_configuration_change", "high", "denied", { requestId: id, reason, status: existing.rows[0]?.status });
    return { data: { error: reason, status: existing.rows[0]?.status ?? null }, isError: true };
  }
  const finish = async (status: string, verification: unknown, outcome: string) => {
    await db.query(
      "update coolify_change_requests set status=$2, applied_at=now(), verification=$3::jsonb where id=$1",
      [id, status, JSON.stringify(verification)],
    );
    await audit(principal, "coolify_apply_configuration_change", "high", outcome, { requestId: id, applicationUuid: row.application_uuid, digest: row.digest, status });
  };
  try {
    if (!client.isAllowed(row.application_uuid)) {
      await finish("failed", { error: "application_not_allowed" }, "denied");
      return { data: { error: "application_not_allowed" }, isError: true };
    }
    if (changeDigest(row.application_uuid, row.before_values, row.after_values) !== row.digest) {
      await finish("failed", { error: "digest_mismatch" }, "denied");
      return { data: { error: "digest_mismatch" }, isError: true };
    }
    const fields = Object.keys(row.after_values) as CoolifyConfigField[];
    const current = extractConfiguration(await client.getApplication(row.application_uuid));
    const drift = fields.filter((f) => current.unverifiable.includes(f) || current.config[f] !== row.before_values[f]);
    if (drift.length) {
      await finish("conflict", { drift, current: current.config }, "denied");
      return { data: { error: "configuration_changed_since_approval", drift, current: current.config }, isError: true };
    }
    // Re-check the invariant against the live state: two separately approved
    // requests (e.g. "Auto Deploy on" and "branch main") must not combine.
    if (current.unverifiable.includes("git_branch") || current.unverifiable.includes("is_auto_deploy_enabled") ||
        releaseInvariantViolation({ ...current.config, ...row.after_values })) {
      await finish("conflict", { error: "release_invariant_violation", current: current.config }, "denied");
      return { data: { error: "release_invariant_violation", message: "Auto Deploy may only be on while Git Branch is `production`.", current: current.config }, isError: true };
    }
    for (const step of safePatchSteps(row.after_values)) {
      if (step.is_auto_deploy_enabled === true) {
        // Enable Auto Deploy only after Coolify confirms it tracks `production`.
        const gate = extractConfiguration(await client.getApplication(row.application_uuid));
        if (gate.unverifiable.includes("git_branch") || releaseInvariantViolation({ ...gate.config, is_auto_deploy_enabled: true })) {
          await finish("verification_failed", { error: "release_invariant_violation", configuration: gate.config }, "error");
          return { data: { error: "release_invariant_violation", status: "verification_failed", message: "Auto Deploy was not enabled because Coolify does not report git_branch=production.", configuration: gate.config }, isError: true };
        }
      }
      await client.patchConfiguration(row.application_uuid, step);
    }
    const reread = extractConfiguration(await client.getApplication(row.application_uuid));
    const checks = fields.map((field) => ({ field, expected: row.after_values[field], actual: reread.unverifiable.includes(field) ? null : reread.config[field] }));
    const verified = checks.every((c) => c.expected === c.actual);
    await finish(verified ? "applied" : "verification_failed", { checks, configuration: reread.config }, verified ? "success" : "error");
    return { data: { status: verified ? "applied" : "verification_failed", verified, checks, configuration: reread.config, deployed: false }, isError: !verified };
  } catch (error) {
    const code = error instanceof CoolifyError ? error.code : "coolify_internal_error";
    await finish("failed", { error: code }, "error");
    return { data: { error: code, note: "The approval was consumed; re-read the configuration and propose again if needed." }, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Console (human) decisions. Callers must already have verified a platform
// administrator browser session, CSRF and the current password.

export async function listChangeRequests(status: string, limit: number) {
  await db.query("update coolify_change_requests set status='expired' where status in ('pending','approved') and expires_at<=now()");
  const result = await db.query(
    `select id,application_uuid,requested_by_actor,before_values,after_values,digest,reason,status,expires_at,
            decided_by,decided_at,applied_at,verification,created_at
       from coolify_change_requests where status=$1 order by created_at desc limit $2`,
    [status, limit],
  );
  return result.rows;
}

export async function decideChangeRequest(id: string, decision: "approve" | "deny", digest: string, deciderUserId: string) {
  const result = await db.query(
    `update coolify_change_requests set status=$2, decided_by=$3, decided_at=now()
      where id=$1 and status='pending' and digest=$4 and expires_at>now()
      returning id,application_uuid,after_values,digest,status`,
    [id, decision === "approve" ? "approved" : "denied", deciderUserId, digest],
  );
  return result.rows[0] ?? null;
}
