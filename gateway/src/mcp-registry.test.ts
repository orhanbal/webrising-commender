import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { llmsTxt } from "./site-content.js";
import { namespaceFor, publishToRegistry, registryAuthRecord, registryKey, registryServerJson, serverJsonText, signedLogin, REGISTRY_URL, SERVER_JSON_PATH } from "./mcp-registry.js";

const secret = "z".repeat(40);

test("the key pair comes from the server secret: stable, and different for another secret", () => {
  assert.equal(registryKey(secret).publicKeyBase64, registryKey(secret).publicKeyBase64);
  assert.notEqual(registryKey(secret).publicKeyBase64, registryKey("q".repeat(40)).publicKeyBase64);
  assert.equal(Buffer.from(registryKey(secret).publicKeyBase64, "base64").length, 32);
});

test("the well-known record has the registry's format", () => {
  assert.match(registryAuthRecord(secret), /^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/]{43}=\n$/);
});

test("the login signature verifies with the published public key", () => {
  const body = signedLogin("https://wecommander.app", secret, new Date("2026-11-16T09:30:00.123Z"));
  assert.equal(body.domain, "wecommander.app");
  assert.equal(body.timestamp, "2026-11-16T09:30:00Z");
  assert.match(body.signed_timestamp, /^[0-9a-f]{128}$/);
  const raw = Buffer.from(registryKey(secret).publicKeyBase64, "base64");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  assert.equal(verify(null, Buffer.from(body.timestamp), key, Buffer.from(body.signed_timestamp, "hex")), true);
});

test("the listing is under our own domain and points at the remote MCP URL", () => {
  assert.equal(namespaceFor("https://wecommander.app"), "app.wecommander");
  const json = registryServerJson("https://wecommander.app");
  assert.equal(json.name, "app.wecommander/wecommander");
  assert.deepEqual(json.remotes, [{ type: "streamable-http", url: "https://wecommander.app/mcp" }]);
  assert.ok(json.description.length > 10 && json.description.length <= 100, `description is ${json.description.length} characters`);
  assert.match(json.version, /^\d+\.\d+\.\d+$/);
});

test("publishing logs in, then posts the listing with the token; failures never throw", async () => {
  const calls: { url: string; init: any }[] = [];
  const fake = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v0/auth/http")) return new Response(JSON.stringify({ registry_token: "tok" }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const ok = await publishToRegistry("https://wecommander.app", secret, fake);
  assert.equal(ok.ok, true);
  const [loginCall, publishCall] = calls as [{ url: string; init: any }, { url: string; init: any }];
  assert.equal(loginCall.url, `${REGISTRY_URL}/v0/auth/http`);
  assert.equal(JSON.parse(loginCall.init.body).domain, "wecommander.app");
  assert.equal(publishCall.url, `${REGISTRY_URL}/v0/publish`);
  assert.equal(publishCall.init.headers.authorization, "Bearer tok");
  assert.equal(JSON.parse(publishCall.init.body).name, "app.wecommander/wecommander");

  const refused = await publishToRegistry("https://wecommander.app", secret, (async () => new Response("{\"error\":\"no\"}", { status: 403 })) as typeof fetch);
  assert.equal(refused.ok, false);
  const offline = await publishToRegistry("https://wecommander.app", secret, (async () => { throw new Error("offline"); }) as typeof fetch);
  assert.deepEqual([offline.ok, offline.detail], [false, "offline"]);
});

test("/server.json serves the listing, and the committed server.json matches it", () => {
  assert.equal(SERVER_JSON_PATH, "/server.json");
  const text = serverJsonText("https://wecommander.app");
  const json = JSON.parse(text);
  assert.deepEqual(json, registryServerJson("https://wecommander.app"));
  assert.equal(json.version, "1.0.0");
  assert.match(json.$schema, /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
  // The repository root copy is what `mcp-publisher publish` reads for a manual publish.
  const committed = readFileSync(new URL("../../server.json", import.meta.url), "utf8");
  assert.equal(committed, text, "regenerate server.json at the repository root from registryServerJson()");
});

test("llms.txt names the MCP URL, the registry listing and the 1.0 release", () => {
  const text = llmsTxt("https://wecommander.app");
  assert.ok(text.includes("Remote MCP server: https://wecommander.app/mcp"));
  assert.ok(text.includes(`MCP Registry name: ${registryServerJson("https://wecommander.app").name}`));
  assert.ok(text.includes("https://wecommander.app/server.json"));
  assert.match(text, /WECOMMANDER 1\.0/);
});
