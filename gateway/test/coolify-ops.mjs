// End-to-end acceptance for the scoped Coolify operations proxy.
// Real gateway process + real PostgreSQL + a mock Coolify 4.5.3 API that
// enforces bearer auth and records every request it receives.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { hashPassword } from "../dist/browser-auth.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const APP = "u5mlu98kqroo7w68zoa0syac";
const OTHER = "otherapp0000000000000000";
const COOLIFY_TOKEN = "3|coolify-test-token-" + crypto.randomBytes(12).toString("hex");
const PORT = Number(process.env.COOLIFY_TEST_PORT || 8797);
const base = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------- mock Coolify
const apps = {
  [APP]: { uuid: APP, name: "wecommander", status: "running:healthy", git_branch: "main", git_repository: "orhanbal/webrising-commender",
    manual_webhook_secret_github: "whsec-must-not-leak",
    settings: { is_auto_deploy_enabled: false, include_source_commit_in_build: false, use_build_secrets: true } },
  [OTHER]: { uuid: OTHER, name: "other", status: "running:healthy", git_branch: "main", settings: { is_auto_deploy_enabled: true, include_source_commit_in_build: false, use_build_secrets: false } },
};
const deployments = {
  [APP]: [{ deployment_uuid: "dep-app-0001", status: "finished", commit: "9bdcf23c52e841c6ffd551654f155edd49f347ed", is_webhook: false, logs: "SECRET_IN_LOGS", configuration_snapshot: { x: 1 } }],
  [OTHER]: [{ deployment_uuid: "dep-other-0001", status: "finished", commit: "ffff" }],
};
const requests = [];
let ignorePatchField = null;
const mock = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
  const send = (status, payload) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
  if (req.headers.authorization !== "Bearer " + COOLIFY_TOKEN) return send(401, { message: "Unauthenticated." });
  const url = new URL(req.url, "http://mock");
  let m;
  if ((m = url.pathname.match(/^\/api\/v1\/applications\/([a-z0-9]+)$/))) {
    const app = apps[m[1]];
    if (!app) return send(404, { message: "Application not found." });
    if (req.method === "GET") return send(200, app);
    if (req.method === "PATCH") {
      const patch = JSON.parse(body);
      if ("instant_deploy" in patch) return send(403, { message: "Missing required permissions: deploy" });
      for (const [key, value] of Object.entries(patch)) {
        if (key === ignorePatchField) continue;
        if (key === "git_branch") app.git_branch = value; else app.settings[key] = value;
      }
      return send(200, { uuid: app.uuid });
    }
  }
  if ((m = url.pathname.match(/^\/api\/v1\/deployments\/applications\/([a-z0-9]+)$/)) && req.method === "GET") {
    const list = deployments[m[1]] || [];
    return send(200, { count: list.length, deployments: list });
  }
  send(404, { message: "Not found" });
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;

// ---------------------------------------------------------------- fixtures
const dbc = new pg.Client({ connectionString: databaseUrl });
await dbc.connect();
const suffix = crypto.randomBytes(4).toString("hex");
const adminEmail = `coolify-admin-${suffix}@example.test`;
const userEmail = `coolify-user-${suffix}@example.test`;
const password = "coolify-acceptance-password-" + suffix;

// ---------------------------------------------------------------- gateway
const gatewayLog = [];
const gateway = spawn(process.execPath, ["dist/index.js"], {
  env: {
    ...process.env,
    PORT: String(PORT), HOST: "127.0.0.1", PUBLIC_BASE_URL: base,
    COOLIFY_API_URL: mockUrl, COOLIFY_API_TOKEN: COOLIFY_TOKEN, COOLIFY_ALLOWED_APPLICATIONS: APP,
    SMTP_HOST: "", MAIL_DELIVERY_INTERVAL_MS: "3600000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
gateway.stdout.on("data", (d) => gatewayLog.push(String(d)));
gateway.stderr.on("data", (d) => gatewayLog.push(String(d)));
let failed = true;
process.on("exit", () => { gateway.kill("SIGTERM"); if (failed) console.error(gatewayLog.join("")); });
for (let i = 0; ; i++) {
  try { if ((await fetch(base + "/health")).ok) break; } catch {}
  if (i > 60) throw new Error("gateway did not start");
  await new Promise((r) => setTimeout(r, 250));
}

// Users are created after the gateway ran its migrations.
const org = (await dbc.query("insert into organizations(name) values($1) returning id", ["Coolify ops " + suffix])).rows[0].id;
async function createUser(email, role) {
  const id = (await dbc.query(
    "insert into users(email,password_hash,email_verified_at) values($1,$2,now()) returning id", [email, await hashPassword(password)],
  )).rows[0].id;
  await dbc.query("insert into organization_members(organization_id,user_id,role) values($1,$2,$3)", [org, id, role]);
  return id;
}
const adminId = await createUser(adminEmail, "owner");
await createUser(userEmail, "owner");
await dbc.query("insert into platform_administrators(user_id,granted_by) values($1,'coolify-acceptance')", [adminId]);
const apiToken = "wrc_" + crypto.randomBytes(30).toString("base64url");
await dbc.query("insert into api_tokens(organization_id,name,role,token_hash,created_by) values($1,'coolify-test','owner',$2,'test')",
  [org, crypto.createHash("sha256").update(apiToken).digest("hex")]);

async function login(email) {
  const response = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, organizationId: org }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  const cookie = response.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
  return { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "content-type": "application/json" };
}
const admin = await login(adminEmail);
const user = await login(userEmail);
const tokenHeaders = { authorization: "Bearer " + apiToken, "content-type": "application/json" };

let rpcId = 0;
async function rpc(headers, method, params) {
  const response = await fetch(base + "/mcp", {
    method: "POST", headers: { ...headers, accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function call(headers, name, args = {}) {
  const result = (await rpc(headers, "tools/call", { name, arguments: args })).result;
  return { error: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}
const patches = () => requests.filter((r) => r.method === "PATCH");
const nonGet = () => requests.filter((r) => r.method !== "GET" && r.method !== "PATCH");

// 1. Visibility and authorization: only platform administrators.
const userTools = (await rpc(user, "tools/list")).result.tools.map((t) => t.name);
assert.ok(!userTools.some((n) => n.startsWith("coolify_")), "non-admins do not see Coolify tools");
const adminTools = (await rpc(admin, "tools/list")).result.tools.map((t) => t.name);
for (const name of ["coolify_get_application", "coolify_get_configuration", "coolify_list_deployments", "coolify_get_deployment",
  "coolify_get_health", "coolify_propose_configuration_change", "coolify_apply_configuration_change", "coolify_deploy", "coolify_rollback"]) {
  assert.ok(adminTools.includes(name), name);
}
const before = requests.length;
for (const headers of [user, tokenHeaders]) {
  const denied = await call(headers, "coolify_get_configuration", { application_uuid: APP });
  assert.equal(denied.error, true);
  assert.equal(denied.data.error, "platform_admin_required");
}
assert.equal(requests.length, before, "denied callers never reach Coolify");

// 2. Application allowlist.
const other = await call(admin, "coolify_get_application", { application_uuid: OTHER });
assert.equal(other.data.error, "application_not_allowed");
assert.equal(requests.filter((r) => r.url.includes(OTHER)).length, 0, "non-allowlisted app never requested");

// 3. Read-only audit.
const app = await call(admin, "coolify_get_application", { application_uuid: APP });
assert.equal(app.error, false);
assert.equal(app.data.configuration.git_branch, "main");
assert.ok(!JSON.stringify(app.data).includes("whsec-must-not-leak"));
const audit1 = await call(admin, "coolify_get_configuration", { application_uuid: APP });
assert.equal(audit1.data.compliant, false);
assert.deepEqual(audit1.data.checks.filter((c) => !c.compliant).map((c) => c.field).sort(),
  ["git_branch", "include_source_commit_in_build", "is_auto_deploy_enabled", "use_build_secrets"]);
const deps = await call(admin, "coolify_list_deployments", { application_uuid: APP, take: 5 });
assert.equal(deps.data.count, 1);
assert.ok(!JSON.stringify(deps.data).includes("SECRET_IN_LOGS"));
const foreignDep = await call(admin, "coolify_get_deployment", { application_uuid: APP, deployment_uuid: "dep-other-0001" });
assert.equal(foreignDep.data.error, "deployment_not_found");
const ownDep = await call(admin, "coolify_get_deployment", { application_uuid: APP, deployment_uuid: "dep-app-0001" });
assert.equal(ownDep.data.status, "finished");
const health = await call(admin, "coolify_get_health", { application_uuid: APP });
assert.equal(health.data.healthy, true);

// 4. Deploy / rollback are refused and never reach Coolify.
for (const name of ["coolify_deploy", "coolify_rollback"]) {
  const refused = await call(admin, name, { application_uuid: APP });
  assert.equal(refused.data.error, "production_release_requires_promote_production");
}
assert.equal(nonGet().length, 0);

// 5. Proposals: whitelist only, exact diff, no write.
const forbidden = await call(admin, "coolify_propose_configuration_change", { application_uuid: APP, changes: { instant_deploy: true }, reason: "try deploy" });
assert.equal(forbidden.data.error, "field_not_allowed");
const commitPin = await call(admin, "coolify_propose_configuration_change", { application_uuid: APP, changes: { git_commit_sha: "abc" }, reason: "pin" });
assert.equal(commitPin.data.error, "field_not_allowed");
const policy = { git_branch: "production", is_auto_deploy_enabled: true, include_source_commit_in_build: true, use_build_secrets: false };
const proposal = await call(admin, "coolify_propose_configuration_change", { application_uuid: APP, changes: policy, reason: "Issue #30 release policy" });
assert.equal(proposal.data.status, "pending_approval");
assert.equal(proposal.data.diff.length, 4);
assert.equal(proposal.data.deploys, false);
assert.deepEqual(proposal.data.rollback.changes, { git_branch: "main", is_auto_deploy_enabled: false, include_source_commit_in_build: false, use_build_secrets: true });
assert.equal(patches().length, 0, "proposal changes nothing");
const requestId = proposal.data.request_id;

// 6. Apply before approval is refused.
const early = await call(admin, "coolify_apply_configuration_change", { request_id: requestId });
assert.equal(early.data.error, "change_request_not_approved_or_used");
assert.equal(patches().length, 0);

// 7. Approval: human console session + CSRF + password + exact digest.
const decide = (headers, id, body, decision = "approve") => fetch(`${base}/api/console/coolify/change-requests/${id}/${decision}`, { method: "POST", headers, body: JSON.stringify(body) });
assert.equal((await decide(tokenHeaders, requestId, { digest: proposal.data.digest, currentPassword: password })).status, 403, "API token cannot approve");
assert.equal((await decide(user, requestId, { digest: proposal.data.digest, currentPassword: password })).status, 403, "non-admin cannot approve");
assert.equal((await decide({ Cookie: admin.Cookie, "content-type": "application/json" }, requestId, { digest: proposal.data.digest, currentPassword: password })).status, 403, "CSRF required");
assert.equal((await decide(admin, requestId, { digest: proposal.data.digest, currentPassword: "wrong-password-value-1" })).status, 403, "password required");
assert.equal((await decide(admin, requestId, { digest: "0".repeat(64), currentPassword: password })).status, 409, "digest must match");
const listed = await (await fetch(base + "/api/console/coolify/change-requests", { headers: admin })).json();
assert.equal(listed.configured, true);
assert.ok(listed.items.some((item) => item.id === requestId));
const approved = await decide(admin, requestId, { digest: proposal.data.digest, currentPassword: password });
assert.equal(approved.status, 200);
assert.equal((await decide(admin, requestId, { digest: proposal.data.digest, currentPassword: password })).status, 409, "decision is single-use");

// 8. Drift after approval is refused without writing.
const driftProposal = await call(admin, "coolify_propose_configuration_change", { application_uuid: APP, changes: { use_build_secrets: false }, reason: "drift test" });
assert.equal((await decide(admin, driftProposal.data.request_id, { digest: driftProposal.data.digest, currentPassword: password })).status, 200);
apps[APP].settings.use_build_secrets = false; // someone changed it in the Coolify UI meanwhile
const drift = await call(admin, "coolify_apply_configuration_change", { request_id: driftProposal.data.request_id });
assert.equal(drift.data.error, "configuration_changed_since_approval");
assert.equal(patches().length, 0);
apps[APP].settings.use_build_secrets = true;

// 9. Apply exactly once, only approved fields, verified by re-read.
const applied = await call(admin, "coolify_apply_configuration_change", { request_id: requestId });
assert.equal(applied.error, false, JSON.stringify(applied.data));
assert.equal(applied.data.status, "applied");
assert.equal(applied.data.verified, true);
assert.equal(applied.data.deployed, false);
assert.deepEqual(applied.data.configuration, policy);
// Auto Deploy is enabled in its own, final PATCH after Coolify confirms the branch.
assert.equal(patches().length, 2);
assert.deepEqual(patches()[0].body, { git_branch: "production", include_source_commit_in_build: true, use_build_secrets: false });
assert.deepEqual(patches()[1].body, { is_auto_deploy_enabled: true });
assert.ok(patches().every((p) => !("instant_deploy" in p.body)));
const again = await call(admin, "coolify_apply_configuration_change", { request_id: requestId });
assert.equal(again.data.error, "change_request_not_approved_or_used");
assert.equal(patches().length, 2, "approval cannot be reused");
const audit2 = await call(admin, "coolify_get_configuration", { application_uuid: APP });
assert.equal(audit2.data.compliant, true);
assert.equal(audit2.data.release_invariant.ok, true);

// 9b. Release invariant (Issue #30): Auto Deploy only while git_branch=production.
const approve = async (proposalResult) => {
  assert.equal(proposalResult.data.status, "pending_approval", JSON.stringify(proposalResult.data));
  assert.equal((await decide(admin, proposalResult.data.request_id, { digest: proposalResult.data.digest, currentPassword: password })).status, 200);
  return proposalResult.data.request_id;
};
const setState = (branch, auto) => { apps[APP].git_branch = branch; apps[APP].settings.is_auto_deploy_enabled = auto; };
const requestCount = async () => Number((await dbc.query("select count(*) from coolify_change_requests")).rows[0].count);
// Proposal stage: a single request that would create main + Auto Deploy is refused and not stored.
let stored = await requestCount();
const mainWhileAuto = await call(admin, "coolify_propose_configuration_change", { application_uuid: APP, changes: { git_branch: "main" }, reason: "invariant: branch main while auto on" });
assert.equal(mainWhileAuto.data.error, "release_invariant_violation");
setState("production", false);
const bothAtOnce = await call(admin, "coolify_propose_configuration_change", { application_uuid: APP, changes: { git_branch: "main", is_auto_deploy_enabled: true }, reason: "invariant: both at once" });
assert.equal(bothAtOnce.data.error, "release_invariant_violation");
setState("main", false);
const autoOnMain = await call(admin, "coolify_propose_configuration_change", { application_uuid: APP, changes: { is_auto_deploy_enabled: true }, reason: "invariant: auto on main" });
assert.equal(autoOnMain.data.error, "release_invariant_violation");
assert.equal(await requestCount(), stored, "refused proposals are not stored");
let patchCount = patches().length;

// Apply stage, order A then B: "Auto Deploy on" then "branch main", each valid alone.
setState("production", false);
const reqAutoOn = await approve(await call(admin, "coolify_propose_configuration_change", { application_uuid: APP, changes: { is_auto_deploy_enabled: true }, reason: "split A: auto on" }));
const reqMain = await approve(await call(admin, "coolify_propose_configuration_change", { application_uuid: APP, changes: { git_branch: "main" }, reason: "split B: branch main" }));
assert.equal((await call(admin, "coolify_apply_configuration_change", { request_id: reqAutoOn })).data.status, "applied");
patchCount = patches().length;
const splitB = await call(admin, "coolify_apply_configuration_change", { request_id: reqMain });
assert.equal(splitB.data.error, "release_invariant_violation");
assert.equal(patches().length, patchCount, "no PATCH for the combining request");
assert.deepEqual([apps[APP].git_branch, apps[APP].settings.is_auto_deploy_enabled], ["production", true]);

// Apply stage, order B then A: "branch main" then "Auto Deploy on".
setState("production", false);
const reqMain2 = await approve(await call(admin, "coolify_propose_configuration_change", { application_uuid: APP, changes: { git_branch: "main" }, reason: "split B2: branch main" }));
const reqAutoOn2 = await approve(await call(admin, "coolify_propose_configuration_change", { application_uuid: APP, changes: { is_auto_deploy_enabled: true }, reason: "split A2: auto on" }));
assert.equal((await call(admin, "coolify_apply_configuration_change", { request_id: reqMain2 })).data.status, "applied");
patchCount = patches().length;
const splitA = await call(admin, "coolify_apply_configuration_change", { request_id: reqAutoOn2 });
assert.equal(splitA.data.error, "release_invariant_violation");
assert.equal(patches().length, patchCount);
assert.deepEqual([apps[APP].git_branch, apps[APP].settings.is_auto_deploy_enabled], ["main", false]);
// The consumed request cannot be retried after the state is fixed.
setState("production", false);
assert.equal((await call(admin, "coolify_apply_configuration_change", { request_id: reqAutoOn2 })).data.error, "change_request_not_approved_or_used");

// If Coolify silently ignores the branch change, Auto Deploy is never enabled.
setState("main", false);
const reqFix = await approve(await call(admin, "coolify_propose_configuration_change", { application_uuid: APP, changes: { git_branch: "production", is_auto_deploy_enabled: true }, reason: "gate: branch ignored" }));
ignorePatchField = "git_branch";
const gated = await call(admin, "coolify_apply_configuration_change", { request_id: reqFix });
ignorePatchField = null;
assert.equal(gated.data.error, "release_invariant_violation");
assert.equal(gated.data.status, "verification_failed");
assert.deepEqual([apps[APP].git_branch, apps[APP].settings.is_auto_deploy_enabled], ["main", false]);
assert.ok(patches().slice(-1)[0].body.git_branch === "production" && !patches().some((p, i) => i >= patchCount && p.body.is_auto_deploy_enabled === true));
setState("production", true);

// 10. Coolify silently ignoring a field is reported as verification failure.
const revert = await call(admin, "coolify_propose_configuration_change", { application_uuid: APP, changes: { is_auto_deploy_enabled: false }, reason: "verification test" });
assert.equal((await decide(admin, revert.data.request_id, { digest: revert.data.digest, currentPassword: password })).status, 200);
ignorePatchField = "is_auto_deploy_enabled";
const unverified = await call(admin, "coolify_apply_configuration_change", { request_id: revert.data.request_id });
assert.equal(unverified.error, true);
assert.equal(unverified.data.status, "verification_failed");
ignorePatchField = null;

// 11. Denied requests stay denied.
const denyMe = await call(admin, "coolify_propose_configuration_change", { application_uuid: APP, changes: { use_build_secrets: true }, reason: "deny test" });
assert.equal((await decide(admin, denyMe.data.request_id, { digest: denyMe.data.digest, currentPassword: password }, "deny")).status, 200);
assert.equal((await call(admin, "coolify_apply_configuration_change", { request_id: denyMe.data.request_id })).data.error, "change_request_not_approved_or_used");
assert.equal(apps[APP].settings.use_build_secrets, false);

// 12. Audit trail exists and secrets never appear in audit, responses or logs.
const auditRows = (await dbc.query("select tool,outcome,detail from audit_logs where organization_id=$1 and tool like 'coolify_%'", [org])).rows;
for (const [tool, outcome] of [["coolify_get_configuration", "denied"], ["coolify_get_application", "denied"], ["coolify_deploy", "denied"],
  ["coolify_propose_configuration_change", "pending_approval"], ["coolify_apply_configuration_change", "success"], ["coolify_apply_configuration_change", "denied"]]) {
  assert.ok(auditRows.some((r) => r.tool === tool && r.outcome === outcome), `${tool}/${outcome} audited`);
}
const decisions = (await dbc.query("select action from platform_admin_audit where actor_user_id=$1", [adminId])).rows.map((r) => r.action);
assert.ok(decisions.includes("coolify.change_request.approve") && decisions.includes("coolify.change_request.deny"));
const everything = JSON.stringify(auditRows) + JSON.stringify(decisions) + gatewayLog.join("");
assert.ok(!everything.includes(COOLIFY_TOKEN), "Coolify token never logged or audited");

failed = false;
console.log(`coolify ops acceptance passed (${requests.length} Coolify requests, ${patches().length} PATCH, ${nonGet().length} deploy/rollback)`);
await dbc.end();
mock.close();
gateway.kill("SIGTERM");
process.exit(0);
