import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APPLICATION_UUID, POLICY, apiBase, applyReleasePolicy, audit, createClient, invariantOk, plan, readConfig } from "./coolify-ops.mjs";

const READ = "read-token-0123456789";
const WRITE = "write-token-0123456789";

// Mock of the Coolify 4.5.3 endpoints used, enforcing api.ability:read/write.
function mockCoolify(state, { ignore = null } = {}) {
  const log = [];
  const deployments = [{ deployment_uuid: "dep-1", status: "finished", commit: "9bdcf23c", logs: "SECRET_LOG" }];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const token = init.headers.authorization.slice(7);
    const body = init.body ? JSON.parse(init.body) : null;
    log.push({ method: init.method, path: u.pathname, body });
    const reply = (status, payload) => new Response(JSON.stringify(payload), { status });
    if (![READ, WRITE].includes(token)) return reply(401, { message: "Unauthenticated." });
    if (u.pathname === `/api/v1/applications/${APPLICATION_UUID}`) {
      if (init.method === "GET") return reply(200, { uuid: APPLICATION_UUID, name: "wecommander", status: state.status ?? "running:healthy", git_branch: state.git_branch, manual_webhook_secret_github: "WHSEC", settings: { ...state.settings } });
      if (init.method === "PATCH") {
        if (token !== WRITE) return reply(403, { message: "Missing required permissions: write" });
        if ("instant_deploy" in body) deployments.unshift({ deployment_uuid: "dep-new", status: "queued" });
        for (const [k, v] of Object.entries(body)) {
          if (k === ignore) continue;
          if (k === "git_branch") state.git_branch = v; else state.settings[k] = v;
        }
        return reply(200, { uuid: APPLICATION_UUID });
      }
    }
    if (u.pathname === `/api/v1/deployments/applications/${APPLICATION_UUID}`) return reply(200, { count: deployments.length, deployments });
    return reply(404, { message: "Not found" });
  };
  return { fetchImpl, log, deployments };
}
const client = (mock, token) => createClient({ baseUrl: "https://coolify.test/api/v1", token, fetchImpl: mock.fetchImpl });
const unsafe = () => ({ git_branch: "main", settings: { is_auto_deploy_enabled: true, include_source_commit_in_build: false, use_build_secrets: true } });

test("api base requires https and normalises /api/v1", () => {
  assert.equal(apiBase("https://coolify.example.com/"), "https://coolify.example.com/api/v1");
  assert.equal(apiBase("https://coolify.example.com/api/v1"), "https://coolify.example.com/api/v1");
  for (const bad of ["http://coolify.example.com", "https://u:p@c.example", "https://c.example/?x=1", "", "not a url"]) {
    assert.throws(() => apiBase(bad), { message: /coolify_api_url/ }, bad);
  }
});

test("plan keeps the invariant at every step and only touches missing fields", () => {
  const cases = [
    [{ git_branch: "main", is_auto_deploy_enabled: true, include_source_commit_in_build: false, use_build_secrets: true },
      [{ is_auto_deploy_enabled: false }, { git_branch: "production", include_source_commit_in_build: true, use_build_secrets: false }, { is_auto_deploy_enabled: true }]],
    [{ git_branch: "main", is_auto_deploy_enabled: false, include_source_commit_in_build: true, use_build_secrets: false },
      [{ git_branch: "production" }, { is_auto_deploy_enabled: true }]],
    [{ git_branch: "production", is_auto_deploy_enabled: false, include_source_commit_in_build: true, use_build_secrets: false },
      [{ is_auto_deploy_enabled: true }]],
    [{ ...POLICY }, []],
    [{ ...POLICY, use_build_secrets: true }, [{ use_build_secrets: false }]],
  ];
  for (const [start, expected] of cases) {
    const { steps } = plan(start);
    assert.deepEqual(steps, expected, JSON.stringify(start));
    let state = { ...start };
    for (const step of steps) { state = { ...state, ...step }; assert.ok(invariantOk(state), JSON.stringify(state)); }
    if (steps.length) assert.deepEqual(state, { ...POLICY });
  }
});

test("audit is read-only, strips secrets and proves the read token cannot write", async () => {
  const state = unsafe();
  const mock = mockCoolify(state);
  const c = client(mock, READ);
  const result = await audit({ client: c, readOnlyProbe: true });
  assert.equal(result.compliant, false);
  assert.equal(result.application.invariant_ok, false);
  assert.deepEqual(result.application.checks.filter((x) => !x.ok).map((x) => x.field), ["git_branch", "include_source_commit_in_build", "use_build_secrets"]);
  assert.ok(result.negative_tests.every((t) => t.ok), JSON.stringify(result.negative_tests));
  assert.ok(result.negative_tests.some((t) => t.test === "read_token_cannot_write" && t.refused_with === "coolify_http_403"));
  assert.deepEqual(state, unsafe(), "nothing changed");
  const text = JSON.stringify(result);
  assert.ok(!text.includes("WHSEC") && !text.includes("SECRET_LOG") && !text.includes(READ));
  assert.equal(result.unexpected_deployments, 0);
});

test("other applications and forbidden fields are refused before any request", async () => {
  const mock = mockCoolify(unsafe());
  const c = client(mock, WRITE);
  await assert.rejects(c.getApplication("otherapplication00000000"), { code: "application_not_allowed" });
  await assert.rejects(c.patch("otherapplication00000000", { use_build_secrets: false }), { code: "application_not_allowed" });
  await assert.rejects(c.patch(APPLICATION_UUID, { instant_deploy: true }), { code: "field_not_allowed" });
  await assert.rejects(c.patch(APPLICATION_UUID, { git_commit_sha: "a" }), { code: "field_not_allowed" });
  await assert.rejects(c.patch(APPLICATION_UUID, { domains: "x" }), { code: "field_not_allowed" });
  assert.equal(mock.log.length, 0);
});

test("apply converges to the policy in safe order, verifies and creates no deployment", async () => {
  const state = unsafe();
  const mock = mockCoolify(state);
  const result = await applyReleasePolicy({ client: client(mock, WRITE) });
  assert.equal(result.result, "APPLIED");
  assert.equal(result.verified, true);
  assert.deepEqual(result.after, { ...POLICY });
  const patches = mock.log.filter((r) => r.method === "PATCH").map((r) => r.body);
  assert.deepEqual(patches, [
    { is_auto_deploy_enabled: false },
    { git_branch: "production", include_source_commit_in_build: true, use_build_secrets: false },
    { is_auto_deploy_enabled: true },
  ]);
  assert.ok(patches.every((p) => !("instant_deploy" in p)));
  assert.equal(mock.deployments.length, 1);
  // Second run: nothing to do, no PATCH.
  const again = await applyReleasePolicy({ client: client(mock, WRITE) });
  assert.equal(again.result, "NO_CHANGE_REQUIRED");
  assert.equal(mock.log.filter((r) => r.method === "PATCH").length, 3);
});

test("Auto Deploy is never enabled if Coolify ignores the branch change", async () => {
  const state = { git_branch: "main", settings: { is_auto_deploy_enabled: false, include_source_commit_in_build: true, use_build_secrets: false } };
  const mock = mockCoolify(state, { ignore: "git_branch" });
  await assert.rejects(applyReleasePolicy({ client: client(mock, WRITE) }), { code: "release_invariant_violation" });
  assert.equal(state.settings.is_auto_deploy_enabled, false);
});

test("apply refuses an unhealthy application and unverifiable values", async () => {
  const sick = mockCoolify({ ...unsafe(), status: "exited:unhealthy" });
  await assert.rejects(applyReleasePolicy({ client: client(sick, WRITE) }), { code: "application_not_healthy" });
  const blind = mockCoolify({ git_branch: "main", settings: {} });
  await assert.rejects(applyReleasePolicy({ client: client(blind, WRITE) }), { code: "current_value_unverifiable" });
  assert.equal(sick.log.filter((r) => r.method === "PATCH").length + blind.log.filter((r) => r.method === "PATCH").length, 0);
});

test("a deployment appearing during an operation fails it", async () => {
  const state = unsafe();
  const mock = mockCoolify(state);
  const c = client(mock, WRITE);
  const original = c.patch;
  c.patch = async (uuid, body) => { mock.deployments.unshift({ deployment_uuid: "dep-webhook" }); return original(uuid, body); };
  await assert.rejects(applyReleasePolicy({ client: c }), { code: "unexpected_deployment" });
});

test("readConfig marks missing settings unverifiable", () => {
  const { unverifiable } = readConfig({ uuid: APPLICATION_UUID, git_branch: "", settings: { use_build_secrets: 0 } });
  assert.deepEqual(unverifiable, ["git_branch", "is_auto_deploy_enabled", "include_source_commit_in_build"]);
});

test("coolify-ops workflow: dispatch on main only, tokens scoped per job and environment", () => {
  const yml = readFileSync(new URL("../.github/workflows/coolify-ops.yml", import.meta.url), "utf8");
  const on = yml.slice(yml.indexOf("\non:"), yml.indexOf("\npermissions:"));
  assert.deepEqual([...on.matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]), ["workflow_dispatch"]);
  assert.match(yml, /^permissions:\n  contents: read\n/m);
  const jobs = yml.slice(yml.indexOf("\njobs:"));
  const [auditJob, applyJob] = jobs.split(/\n  apply-release-policy:\n/);
  assert.match(auditJob, /environment: coolify-read/);
  assert.deepEqual([...auditJob.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]), ["COOLIFY_READ_TOKEN"]);
  assert.match(applyJob, /environment: coolify-write/);
  assert.deepEqual([...applyJob.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]), ["COOLIFY_WRITE_TOKEN"]);
  for (const job of [auditJob, applyJob]) {
    assert.match(job, /github\.ref != 'refs\/heads\/main'/);
    assert.match(job, /persist-credentials: false/);
    for (const u of [...job.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1])) assert.match(u, /@[0-9a-f]{40}$/, u);
  }
  assert.ok(!/instant_deploy|\/deploy|rollback/.test(yml.replace(/#.*$/gm, "").replace(/description: .*$/gm, "")), "no deploy calls");
});

test("CLI prints no token and exits non-zero on failure", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const state = unsafe();
  const mock = mockCoolify(state);
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const r = await mock.fetchImpl("http://x" + req.url, { method: req.method, headers: { authorization: req.headers.authorization }, body: body || undefined });
    res.writeHead(r.status, { "content-type": "application/json" }); res.end(await r.text());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const run = (env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL("./coolify-ops.mjs", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, COOLIFY_API_URL: `http://127.0.0.1:${server.address().port}`, ...env } });
    let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });
  const ok = await run({ COOLIFY_OPERATION: "audit", COOLIFY_READ_ONLY_PROBE: "true", COOLIFY_TOKEN: READ });
  assert.equal(ok.code, 0, ok.out);
  assert.ok(!ok.out.includes(READ));
  const bad = await run({ COOLIFY_OPERATION: "audit", COOLIFY_TOKEN: "wrong-token-000000" });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /coolify_http_401/);
  assert.ok(!bad.out.includes("wrong-token-000000"));
  const applied = await run({ COOLIFY_OPERATION: "apply-release-policy", COOLIFY_TOKEN: WRITE });
  assert.equal(applied.code, 0, applied.out);
  assert.match(applied.out, /"result": "APPLIED"/);
  server.close();
});
