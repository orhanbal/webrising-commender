#!/usr/bin/env node
// Scoped Coolify operations for WECOMMANDER, run only from the reviewed
// `coolify-ops` GitHub workflow on `main` (docs/COOLIFY_ACTIONS_OPS.md).
//
// Coolify 4.5.3 tokens are team scoped, so the token lives only in a GitHub
// Environment secret restricted to `main`; AI clients dispatch the workflow
// but never see the token. This script is the boundary:
//   * one application, fixed here (never an input);
//   * read-only `audit`, or `apply-release-policy`, which can only move the
//     four release settings TO the fixed policy below (no free-form values);
//   * Auto Deploy is turned off first / on last, and only after a re-read
//     shows git_branch=production;
//   * never sends instant_deploy, never deploys, restarts or rolls back;
//   * fails if a deployment appears or the app stops being running:healthy.
//
// Verified Coolify v4.5.3 endpoints: GET/PATCH /api/v1/applications/{uuid}
// (read / write), GET /api/v1/deployments/applications/{uuid} (read).

import { appendFileSync } from "node:fs";

export const APPLICATION_UUID = "u5mlu98kqroo7w68zoa0syac";
export const POLICY = Object.freeze({
  git_branch: "production",
  is_auto_deploy_enabled: true,
  include_source_commit_in_build: true,
  use_build_secrets: false,
});
export const FIELDS = Object.keys(POLICY);
const SETTINGS_FIELDS = ["is_auto_deploy_enabled", "include_source_commit_in_build", "use_build_secrets"];

export class OpsError extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; }
}

export function apiBase(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch { throw new OpsError("invalid_coolify_api_url"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new OpsError("coolify_api_url_must_be_https");
  if (url.username || url.password || url.search || url.hash) throw new OpsError("invalid_coolify_api_url");
  const base = url.toString().replace(/\/+$/, "");
  return base.endsWith("/api/v1") ? base : base + "/api/v1";
}

export function createClient({ baseUrl, token, fetchImpl = fetch }) {
  if (!token || typeof token !== "string") throw new OpsError("coolify_token_missing");
  const requests = [];
  async function request(method, path, body) {
    if (!path.startsWith(`/applications/${APPLICATION_UUID}`) && !path.startsWith(`/deployments/applications/${APPLICATION_UUID}`)) {
      throw new OpsError("application_not_allowed");
    }
    if (body && ("instant_deploy" in body || Object.keys(body).some((k) => !FIELDS.includes(k)))) throw new OpsError("field_not_allowed");
    requests.push({ method, path, fields: body ? Object.keys(body) : [] });
    let response;
    try {
      response = await fetchImpl(baseUrl + path, {
        method, redirect: "manual", signal: AbortSignal.timeout(20_000),
        headers: { authorization: "Bearer " + token, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new OpsError("coolify_unreachable"); }
    const text = await response.text();
    if (response.status >= 300 && response.status < 400) throw new OpsError("coolify_redirect_refused", { status: response.status });
    if (!response.ok) throw new OpsError("coolify_http_" + response.status, { status: response.status });
    try { return text ? JSON.parse(text) : {}; } catch { throw new OpsError("coolify_invalid_json"); }
  }
  return {
    requests,
    async getApplication(uuid = APPLICATION_UUID) {
      if (uuid !== APPLICATION_UUID) throw new OpsError("application_not_allowed");
      const app = await request("GET", `/applications/${uuid}`);
      if (app?.uuid !== uuid) throw new OpsError("coolify_unexpected_response");
      return app;
    },
    async listDeployments(take = 10) {
      const page = await request("GET", `/deployments/applications/${APPLICATION_UUID}?skip=0&take=${take}`);
      if (!Array.isArray(page?.deployments)) throw new OpsError("coolify_unexpected_response");
      return { count: Number(page.count) || 0, deployments: page.deployments.map(projectDeployment) };
    },
    async patch(uuid, body) {
      if (uuid !== APPLICATION_UUID) throw new OpsError("application_not_allowed");
      return request("PATCH", `/applications/${uuid}`, body);
    },
  };
}

function projectDeployment(d) {
  const keep = ["deployment_uuid", "status", "commit", "is_webhook", "is_api", "rollback", "created_at", "finished_at"];
  return Object.fromEntries(keep.map((k) => [k, ["string", "number", "boolean"].includes(typeof d?.[k]) ? d[k] : null]));
}

export function readConfig(app) {
  const s = app?.settings && typeof app.settings === "object" ? app.settings : {};
  const unverifiable = [];
  const config = { git_branch: typeof app?.git_branch === "string" && app.git_branch ? app.git_branch : null };
  if (config.git_branch === null) unverifiable.push("git_branch");
  for (const f of SETTINGS_FIELDS) {
    const v = s[f];
    config[f] = typeof v === "boolean" ? v : v === 0 || v === 1 ? v === 1 : null;
    if (config[f] === null) unverifiable.push(f);
  }
  return { config, unverifiable };
}

export const invariantOk = (c) => !(c.is_auto_deploy_enabled === true && c.git_branch !== "production");

export function plan(config) {
  const missing = FIELDS.filter((f) => config[f] !== POLICY[f]);
  const steps = [];
  if (config.is_auto_deploy_enabled === true && config.git_branch !== "production") steps.push({ is_auto_deploy_enabled: false });
  const middle = Object.fromEntries(missing.filter((f) => f !== "is_auto_deploy_enabled").map((f) => [f, POLICY[f]]));
  if (Object.keys(middle).length) steps.push(middle);
  if (missing.includes("is_auto_deploy_enabled") || steps.some((s) => s.is_auto_deploy_enabled === false)) steps.push({ is_auto_deploy_enabled: true });
  return { missing, steps };
}

function snapshot(app) {
  const { config, unverifiable } = readConfig(app);
  return {
    uuid: app.uuid, name: typeof app.name === "string" ? app.name : null,
    status: typeof app.status === "string" ? app.status : null,
    build_pack: typeof app.build_pack === "string" ? app.build_pack : null,
    git_repository: typeof app.git_repository === "string" ? app.git_repository : null,
    configuration: config, unverifiable, invariant_ok: invariantOk(config),
    checks: FIELDS.map((f) => ({ field: f, expected: POLICY[f], actual: config[f], ok: config[f] === POLICY[f] })),
  };
}

async function deploymentMarker(client) {
  const page = await client.listDeployments(10);
  return { count: page.count, newest: page.deployments[0] ?? null, recent: page.deployments.slice(0, 5) };
}

function assertNoNewDeployment(before, after) {
  if (after.count !== before.count || (after.newest?.deployment_uuid ?? null) !== (before.newest?.deployment_uuid ?? null)) {
    throw new OpsError("unexpected_deployment", { before: before.newest, after: after.newest, countBefore: before.count, countAfter: after.count });
  }
}

// Local negative checks: the boundary refuses before any network call.
export async function selfTest(client) {
  const results = [];
  const expectRefusal = async (name, fn, code) => {
    const before = client.requests.length;
    try { await fn(); results.push({ test: name, ok: false, error: "not_refused" }); }
    catch (e) { results.push({ test: name, ok: e.code === code && client.requests.length === before, refused_with: e.code, network_calls: client.requests.length - before }); }
  };
  await expectRefusal("other_application_read_refused", () => client.getApplication("otherapplication00000000"), "application_not_allowed");
  await expectRefusal("other_application_write_refused", () => client.patch("otherapplication00000000", { use_build_secrets: false }), "application_not_allowed");
  await expectRefusal("instant_deploy_refused", () => client.patch(APPLICATION_UUID, { instant_deploy: true }), "field_not_allowed");
  await expectRefusal("unlisted_field_refused", () => client.patch(APPLICATION_UUID, { git_commit_sha: "0".repeat(40) }), "field_not_allowed");
  return results;
}

export async function audit({ client, readOnlyProbe = false }) {
  const before = await deploymentMarker(client);
  const app = snapshot(await client.getApplication());
  const negative = await selfTest(client);
  if (readOnlyProbe) {
    // Real negative test against Coolify: the read token must not be able to
    // write. The body is a no-op (current branch), so even a wrongly scoped
    // token would change nothing.
    try {
      await client.patch(APPLICATION_UUID, { git_branch: app.configuration.git_branch });
      negative.push({ test: "read_token_cannot_write", ok: false, error: "write_accepted" });
    } catch (e) {
      negative.push({ test: "read_token_cannot_write", ok: e.code === "coolify_http_403", refused_with: e.code });
    }
  }
  const after = await deploymentMarker(client);
  assertNoNewDeployment(before, after);
  return {
    operation: "audit", application: app, deployments: before,
    unexpected_deployments: 0, healthy: app.status === "running:healthy",
    compliant: app.checks.every((c) => c.ok) && app.unverifiable.length === 0,
    negative_tests: negative,
  };
}

export async function applyReleasePolicy({ client }) {
  const before = await deploymentMarker(client);
  const initial = snapshot(await client.getApplication());
  if (initial.unverifiable.length) throw new OpsError("current_value_unverifiable", { fields: initial.unverifiable });
  if (initial.status !== "running:healthy") throw new OpsError("application_not_healthy", { status: initial.status });
  const { missing, steps } = plan(initial.configuration);
  const applied = [];
  for (const step of steps) {
    if (step.is_auto_deploy_enabled === true) {
      const gate = readConfig(await client.getApplication()).config;
      if (gate.git_branch !== "production") throw new OpsError("release_invariant_violation", { git_branch: gate.git_branch });
    }
    await client.patch(APPLICATION_UUID, step);
    applied.push(step);
  }
  const final = snapshot(await client.getApplication());
  const after = await deploymentMarker(client);
  assertNoNewDeployment(before, after);
  const verified = final.checks.every((c) => c.ok) && final.unverifiable.length === 0 && final.invariant_ok;
  return {
    operation: "apply-release-policy",
    result: missing.length ? (verified ? "APPLIED" : "VERIFICATION_FAILED") : "NO_CHANGE_REQUIRED",
    before: initial.configuration, missing, patches: applied, after: final.configuration,
    verified, status_after: final.status, healthy: final.status === "running:healthy",
    unexpected_deployments: 0, deployments: after,
  };
}

function redact(text, secrets) {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("***");
  return out;
}

async function main() {
  const operation = process.env.COOLIFY_OPERATION;
  const token = process.env.COOLIFY_TOKEN;
  let result;
  try {
    const client = createClient({ baseUrl: apiBase(process.env.COOLIFY_API_URL), token });
    if (operation === "audit") result = await audit({ client, readOnlyProbe: process.env.COOLIFY_READ_ONLY_PROBE === "true" });
    else if (operation === "apply-release-policy") result = await applyReleasePolicy({ client });
    else throw new OpsError("unknown_operation");
    result.coolify_requests = client.requests;
  } catch (e) {
    result = { operation, error: e.code || "internal_error", detail: e.detail || {} };
  }
  const text = redact(JSON.stringify(result, null, 2), [token]);
  if (token && text.includes(token)) throw new Error("refusing to print output containing the token");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### coolify-ops: ${operation}\n\n\`\`\`json\n${text}\n\`\`\`\n`);
  const failed = result.error || result.verified === false || result.unexpected_deployments !== 0 ||
    (result.negative_tests || []).some((t) => !t.ok) || result.healthy === false;
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
