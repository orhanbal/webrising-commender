// Scoped Coolify operations proxy (WECOMMANDER-only, first version).
//
// Coolify 4.5.3 API tokens are TEAM scoped: a token can read or change every
// application of its team, and its abilities (read, write, deploy,
// read:sensitive, write:sensitive, root) are not per application. AI clients
// therefore never receive a Coolify token. This module is the trusted
// server-side boundary:
//
//   AI client -> WECOMMANDER MCP (platform administrator only)
//             -> this module (application allowlist, field whitelist,
//                human approval bound to an exact diff, audit)
//             -> Coolify REST API (/api/v1) with a read+write token
//
// Verified against Coolify v4.5.3 source (ApplicationsController,
// DeployController, Application::deployments, ApplicationSetting):
//   GET   /api/v1/applications/{uuid}              ability read
//         -> application JSON with nested `settings` (ApplicationSetting)
//   PATCH /api/v1/applications/{uuid}              ability write
//         git_branch (top level); is_auto_deploy_enabled,
//         include_source_commit_in_build, use_build_secrets (saved to settings)
//         instant_deploy additionally needs deploy/root and queues a deploy:
//         this proxy never sends it.
//   GET   /api/v1/deployments/applications/{uuid}?skip=&take=  ability read
//         -> { count, deployments: [ApplicationDeploymentQueue] }
// Deploy (POST /deploy) and rollback (POST /applications/{uuid}/rollback)
// need the deploy ability, which the proxy token must not have. Production
// releases go only through the GitHub promote-production workflow.

import { createHash } from "node:crypto";
const UUID_RE = /^[a-z0-9]{16,40}$/;
// First version: the only application this proxy may ever touch. The
// environment must name exactly this UUID; anything else disables the proxy.
export const WECOMMANDER_APPLICATION_UUID = "u5mlu98kqroo7w68zoa0syac";
export const RELEASE_BRANCH = "production";
const GIT_BRANCH_RE = /^(?!-)(?!.*\.\.)(?!\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,100}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export const COOLIFY_CONFIG_FIELDS = [
  "git_branch",
  "is_auto_deploy_enabled",
  "include_source_commit_in_build",
  "use_build_secrets",
] as const;
export type CoolifyConfigField = (typeof COOLIFY_CONFIG_FIELDS)[number];
export type CoolifyConfig = { [K in CoolifyConfigField]: K extends "git_branch" ? string : boolean };
export type ConfigChange = Partial<CoolifyConfig>;

// Release policy for the WECOMMANDER application (docs/RELEASE_POLICY.md).
export const RELEASE_POLICY: CoolifyConfig = {
  git_branch: "production",
  is_auto_deploy_enabled: true,
  include_source_commit_in_build: true,
  use_build_secrets: false,
};

export const FIELD_IMPACT: Record<CoolifyConfigField, string> = {
  git_branch:
    "Coolify builds this branch on the next deployment. With Auto Deploy on, a push to this branch triggers a deployment; only promote-production may move `production`.",
  is_auto_deploy_enabled:
    "When on, a GitHub push to the configured branch queues a Coolify deployment. When off, nothing deploys until someone deploys manually in Coolify.",
  include_source_commit_in_build:
    "When on, Coolify passes SOURCE_COMMIT to the build so /health reports build.commit, which verify-release.mjs requires.",
  use_build_secrets:
    "When on, Coolify passes build variables as Docker BuildKit secrets instead of build args; the WECOMMANDER Dockerfile expects SOURCE_COMMIT as a build arg.",
};

export class CoolifyError extends Error {
  constructor(readonly code: string, readonly status = 0) {
    super(code);
  }
}

export type CoolifySettings = {
  baseUrl: string;
  token: string;
  allowedApplications: string[];
};

export function coolifySettingsFromEnv(env: NodeJS.ProcessEnv = process.env): CoolifySettings | null {
  const rawUrl = (env.COOLIFY_API_URL || "").trim();
  const token = (env.COOLIFY_API_TOKEN || "").trim();
  const allowed = (env.COOLIFY_ALLOWED_APPLICATIONS || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (!rawUrl || !token || !allowed.length) return null;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  // First version: WECOMMANDER only. Widening the scope is a deliberate code
  // change, not an environment edit; a different or extra UUID fails closed.
  if (allowed.length !== 1 || allowed[0] !== WECOMMANDER_APPLICATION_UUID) return null;
  const base = url.toString().replace(/\/+$/, "");
  return {
    baseUrl: base.endsWith("/api/v1") ? base : base + "/api/v1",
    token,
    allowedApplications: allowed,
  };
}

export class CoolifyClient {
  constructor(private readonly settings: CoolifySettings, private readonly fetchImpl: typeof fetch = fetch) {}

  isAllowed(uuid: string) {
    return uuid === WECOMMANDER_APPLICATION_UUID && this.settings.allowedApplications.includes(uuid);
  }

  private async request(method: "GET" | "PATCH", path: string, body?: unknown): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(this.settings.baseUrl + path, {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          authorization: "Bearer " + this.settings.token,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CoolifyError("coolify_unreachable");
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) throw new CoolifyError("coolify_redirect_refused", response.status);
    const text = await readLimited(response);
    if (response.status === 401) throw new CoolifyError("coolify_token_rejected", 401);
    if (response.status === 403) throw new CoolifyError("coolify_permission_denied", 403);
    if (response.status === 404) throw new CoolifyError("coolify_not_found", 404);
    if (response.status === 422) throw new CoolifyError("coolify_validation_failed", 422);
    if (!response.ok) throw new CoolifyError("coolify_http_error", response.status);
    try { return text ? JSON.parse(text) : {}; } catch { throw new CoolifyError("coolify_invalid_json", response.status); }
  }

  async getApplication(uuid: string) {
    this.assertAllowed(uuid);
    const app = await this.request("GET", "/applications/" + encodeURIComponent(uuid));
    if (!app || typeof app !== "object" || app.uuid !== uuid) throw new CoolifyError("coolify_unexpected_response");
    return app;
  }

  async listDeployments(uuid: string, skip: number, take: number) {
    this.assertAllowed(uuid);
    const result = await this.request(
      "GET", `/deployments/applications/${encodeURIComponent(uuid)}?skip=${skip}&take=${take}`,
    );
    if (!result || !Array.isArray(result.deployments)) throw new CoolifyError("coolify_unexpected_response");
    return { count: Number(result.count) || 0, deployments: result.deployments.map(projectDeployment) };
  }

  async patchConfiguration(uuid: string, change: ConfigChange) {
    this.assertAllowed(uuid);
    const body = validateChange(change);
    await this.request("PATCH", "/applications/" + encodeURIComponent(uuid), body);
  }

  private assertAllowed(uuid: string) {
    if (!this.isAllowed(uuid)) throw new CoolifyError("application_not_allowed", 403);
  }
}

async function readLimited(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new CoolifyError("coolify_response_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function validateChange(change: unknown): ConfigChange {
  if (!change || typeof change !== "object" || Array.isArray(change)) throw new CoolifyError("invalid_change");
  const out: ConfigChange = {};
  for (const [key, value] of Object.entries(change as Record<string, unknown>)) {
    if (!(COOLIFY_CONFIG_FIELDS as readonly string[]).includes(key)) throw new CoolifyError("field_not_allowed");
    if (key === "git_branch") {
      if (typeof value !== "string" || !GIT_BRANCH_RE.test(value)) throw new CoolifyError("invalid_git_branch");
      out.git_branch = value;
    } else {
      if (typeof value !== "boolean") throw new CoolifyError("invalid_boolean");
      (out as Record<string, boolean>)[key] = value;
    }
  }
  if (!Object.keys(out).length) throw new CoolifyError("empty_change");
  return out;
}

export function extractConfiguration(app: any): { config: CoolifyConfig; unverifiable: CoolifyConfigField[] } {
  const settings = app?.settings && typeof app.settings === "object" ? app.settings : {};
  const unverifiable: CoolifyConfigField[] = [];
  const bool = (field: Exclude<CoolifyConfigField, "git_branch">) => {
    const value = settings[field];
    if (typeof value === "boolean") return value;
    if (value === 0 || value === 1) return value === 1;
    unverifiable.push(field);
    return false;
  };
  const branch = typeof app?.git_branch === "string" ? app.git_branch : "";
  if (!branch) unverifiable.push("git_branch");
  return {
    config: {
      git_branch: branch,
      is_auto_deploy_enabled: bool("is_auto_deploy_enabled"),
      include_source_commit_in_build: bool("include_source_commit_in_build"),
      use_build_secrets: bool("use_build_secrets"),
    },
    unverifiable,
  };
}

export function projectApplication(app: any) {
  const { config, unverifiable } = extractConfiguration(app);
  return {
    uuid: app.uuid,
    name: typeof app.name === "string" ? app.name : null,
    status: typeof app.status === "string" ? app.status : null,
    build_pack: typeof app.build_pack === "string" ? app.build_pack : null,
    git_repository: typeof app.git_repository === "string" ? app.git_repository : null,
    git_commit_sha: typeof app.git_commit_sha === "string" ? app.git_commit_sha : null,
    last_online_at: app.last_online_at ?? null,
    updated_at: app.updated_at ?? null,
    configuration: config,
    unverifiable_fields: unverifiable,
  };
}

function projectDeployment(row: any) {
  const pick = (key: string) => (typeof row?.[key] === "string" || typeof row?.[key] === "boolean" || typeof row?.[key] === "number") ? row[key] : null;
  // logs, configuration_snapshot/diff and server details are never forwarded.
  return {
    deployment_uuid: pick("deployment_uuid"),
    status: pick("status"),
    commit: pick("commit"),
    is_webhook: pick("is_webhook"),
    is_api: pick("is_api"),
    force_rebuild: pick("force_rebuild"),
    rollback: pick("rollback"),
    created_at: pick("created_at"),
    updated_at: pick("updated_at"),
    finished_at: pick("finished_at"),
  };
}

// Issue #30 safety invariant: while Auto Deploy is on, Coolify may only track
// the `production` branch (moved exclusively by promote-production).
// Otherwise a push to main or any other branch would deploy to production.
export function releaseInvariantViolation(config: Pick<CoolifyConfig, "git_branch" | "is_auto_deploy_enabled">) {
  return config.is_auto_deploy_enabled && config.git_branch !== RELEASE_BRANCH;
}

// Splits a change into PATCH steps so every intermediate Coolify state also
// satisfies the invariant: Auto Deploy is turned off first and turned on last.
export function safePatchSteps(after: ConfigChange): ConfigChange[] {
  const rest: ConfigChange = { ...after };
  delete rest.is_auto_deploy_enabled;
  const steps: ConfigChange[] = [];
  if (after.is_auto_deploy_enabled === false) steps.push({ is_auto_deploy_enabled: false });
  if (Object.keys(rest).length) steps.push(rest);
  if (after.is_auto_deploy_enabled === true) steps.push({ is_auto_deploy_enabled: true });
  return steps;
}

export function policyAudit(config: CoolifyConfig, unverifiable: CoolifyConfigField[]) {
  return COOLIFY_CONFIG_FIELDS.map((field) => ({
    field,
    expected: RELEASE_POLICY[field],
    actual: unverifiable.includes(field) ? null : config[field],
    compliant: !unverifiable.includes(field) && config[field] === RELEASE_POLICY[field],
  }));
}

export function changeDigest(applicationUuid: string, before: ConfigChange, after: ConfigChange) {
  const ordered = (value: ConfigChange) => Object.fromEntries(COOLIFY_CONFIG_FIELDS.filter((f) => f in value).map((f) => [f, value[f]]));
  return createHash("sha256")
    .update(JSON.stringify({ applicationUuid, before: ordered(before), after: ordered(after) }))
    .digest("hex");
}
