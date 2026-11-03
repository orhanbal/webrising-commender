import assert from "node:assert/strict";
import test from "node:test";
import {
  CoolifyClient,
  CoolifyError,
  changeDigest,
  coolifySettingsFromEnv,
  extractConfiguration,
  policyAudit,
  projectApplication,
  validateChange,
} from "./coolify-client.js";

const APP = "u5mlu98kqroo7w68zoa0syac";
const OTHER = "zzzzzzzzzzzzzzzzzzzzzzzz";

test("settings require https (or loopback http), a token and exactly one allowlisted app", () => {
  assert.equal(coolifySettingsFromEnv({}), null);
  assert.equal(coolifySettingsFromEnv({ COOLIFY_API_URL: "http://coolify.example", COOLIFY_API_TOKEN: "t", COOLIFY_ALLOWED_APPLICATIONS: APP }), null);
  assert.equal(coolifySettingsFromEnv({ COOLIFY_API_URL: "https://u:p@coolify.example", COOLIFY_API_TOKEN: "t", COOLIFY_ALLOWED_APPLICATIONS: APP }), null);
  assert.equal(coolifySettingsFromEnv({ COOLIFY_API_URL: "https://coolify.example", COOLIFY_API_TOKEN: "t", COOLIFY_ALLOWED_APPLICATIONS: APP + "," + OTHER }), null);
  assert.equal(coolifySettingsFromEnv({ COOLIFY_API_URL: "https://coolify.example", COOLIFY_API_TOKEN: "t", COOLIFY_ALLOWED_APPLICATIONS: "../x" }), null);
  assert.equal(coolifySettingsFromEnv({ COOLIFY_API_URL: "https://coolify.example", COOLIFY_API_TOKEN: "", COOLIFY_ALLOWED_APPLICATIONS: APP }), null);
  assert.deepEqual(
    coolifySettingsFromEnv({ COOLIFY_API_URL: "https://coolify.example/", COOLIFY_API_TOKEN: "t", COOLIFY_ALLOWED_APPLICATIONS: APP }),
    { baseUrl: "https://coolify.example/api/v1", token: "t", allowedApplications: [APP] },
  );
  assert.equal(
    coolifySettingsFromEnv({ COOLIFY_API_URL: "http://127.0.0.1:9/api/v1", COOLIFY_API_TOKEN: "t", COOLIFY_ALLOWED_APPLICATIONS: APP })?.baseUrl,
    "http://127.0.0.1:9/api/v1",
  );
});

test("change whitelist rejects deploy triggers and unknown fields", () => {
  assert.deepEqual(validateChange({ git_branch: "production", is_auto_deploy_enabled: true }), { git_branch: "production", is_auto_deploy_enabled: true });
  for (const bad of [
    { instant_deploy: true },
    { git_commit_sha: "abc" },
    { domains: "x" },
    { git_branch: "../main" },
    { git_branch: "a b" },
    { git_branch: "x..y" },
    { git_branch: "release.lock" },
    { git_branch: "" },
    { is_auto_deploy_enabled: "true" },
    {},
    [],
    null,
  ]) {
    assert.throws(() => validateChange(bad), CoolifyError, JSON.stringify(bad));
  }
});

test("configuration is read from Coolify's nested settings and missing values are unverifiable", () => {
  const app = { uuid: APP, git_branch: "production", settings: { is_auto_deploy_enabled: true, include_source_commit_in_build: 1, use_build_secrets: false } };
  const { config, unverifiable } = extractConfiguration(app);
  assert.deepEqual(config, { git_branch: "production", is_auto_deploy_enabled: true, include_source_commit_in_build: true, use_build_secrets: false });
  assert.deepEqual(unverifiable, []);
  assert.ok(policyAudit(config, unverifiable).every((check) => check.compliant));
  const partial = extractConfiguration({ uuid: APP, git_branch: "main", settings: {} });
  assert.deepEqual(partial.unverifiable.sort(), ["include_source_commit_in_build", "is_auto_deploy_enabled", "use_build_secrets"]);
  const checks = policyAudit(partial.config, partial.unverifiable);
  assert.ok(checks.every((check) => !check.compliant));
  assert.equal(checks.find((c) => c.field === "use_build_secrets")!.actual, null);
});

test("application projection never forwards secrets", () => {
  const projected = projectApplication({
    uuid: APP, name: "wecommander", status: "running:healthy", git_branch: "production",
    manual_webhook_secret_github: "s3cret", http_basic_auth_password: "pw", docker_compose_raw: "env: SECRET",
    settings: { is_auto_deploy_enabled: true, include_source_commit_in_build: true, use_build_secrets: false },
  });
  const text = JSON.stringify(projected);
  assert.ok(!text.includes("s3cret") && !text.includes("pw\"") && !text.includes("SECRET"));
});

test("digest binds application and exact before/after values", () => {
  const a = changeDigest(APP, { is_auto_deploy_enabled: false }, { is_auto_deploy_enabled: true });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, changeDigest(OTHER, { is_auto_deploy_enabled: false }, { is_auto_deploy_enabled: true }));
  assert.notEqual(a, changeDigest(APP, { use_build_secrets: false }, { use_build_secrets: true }));
  assert.equal(
    changeDigest(APP, { git_branch: "main", use_build_secrets: true }, { git_branch: "production", use_build_secrets: false }),
    changeDigest(APP, { use_build_secrets: true, git_branch: "main" }, { use_build_secrets: false, git_branch: "production" }),
  );
});

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("client refuses non-allowlisted applications without any network call", async () => {
  const { impl, calls } = mockFetch(() => new Response("{}"));
  const client = new CoolifyClient({ baseUrl: "https://c/api/v1", token: "tok", allowedApplications: [APP] }, impl);
  await assert.rejects(client.getApplication(OTHER), (e: any) => e.code === "application_not_allowed");
  await assert.rejects(client.patchConfiguration(OTHER, { use_build_secrets: false }), (e: any) => e.code === "application_not_allowed");
  assert.equal(calls.length, 0);
});

test("client sends bearer token, refuses redirects and maps auth failures", async () => {
  const { impl, calls } = mockFetch((url) => {
    if (url.endsWith("/redirect")) return new Response("", { status: 302, headers: { location: "https://evil" } });
    return new Response(JSON.stringify({ uuid: APP, git_branch: "production", settings: {} }), { status: 200 });
  });
  const client = new CoolifyClient({ baseUrl: "https://c/api/v1", token: "tok", allowedApplications: [APP] }, impl);
  const app = await client.getApplication(APP);
  assert.equal(app.uuid, APP);
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer tok");
  assert.equal(calls[0]!.init.redirect, "manual");

  const denied = mockFetch(() => new Response("{\"message\":\"Missing required permissions: write\"}", { status: 403 }));
  const deniedClient = new CoolifyClient({ baseUrl: "https://c/api/v1", token: "tok", allowedApplications: [APP] }, denied.impl);
  await assert.rejects(deniedClient.patchConfiguration(APP, { use_build_secrets: false }), (e: any) => e.code === "coolify_permission_denied");
  const redirect = mockFetch(() => new Response("", { status: 302 }));
  const redirectClient = new CoolifyClient({ baseUrl: "https://c/api/v1", token: "tok", allowedApplications: [APP] }, redirect.impl);
  await assert.rejects(redirectClient.getApplication(APP), (e: any) => e.code === "coolify_redirect_refused");
});

test("PATCH body contains only whitelisted fields and never instant_deploy", async () => {
  const { impl, calls } = mockFetch(() => new Response("{\"uuid\":\"x\"}"));
  const client = new CoolifyClient({ baseUrl: "https://c/api/v1", token: "tok", allowedApplications: [APP] }, impl);
  await client.patchConfiguration(APP, { is_auto_deploy_enabled: true, include_source_commit_in_build: true });
  assert.equal(calls[0]!.init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { is_auto_deploy_enabled: true, include_source_commit_in_build: true });
  await assert.rejects(client.patchConfiguration(APP, { instant_deploy: true } as any), CoolifyError);
  assert.equal(calls.length, 1);
});

test("deployment listing strips logs and configuration snapshots", async () => {
  const { impl } = mockFetch(() => new Response(JSON.stringify({ count: 1, deployments: [{ deployment_uuid: "dep-12345678", status: "finished", commit: "abc", logs: "TOKEN=1", configuration_snapshot: { a: 1 } }] })));
  const client = new CoolifyClient({ baseUrl: "https://c/api/v1", token: "tok", allowedApplications: [APP] }, impl);
  const page = await client.listDeployments(APP, 0, 5);
  assert.equal(page.count, 1);
  assert.ok(!JSON.stringify(page).includes("TOKEN"));
  assert.ok(!JSON.stringify(page).includes("configuration_snapshot"));
});
