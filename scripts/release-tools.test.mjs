import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { createAppJwt } from "./github-app-token.mjs";
import { classifyHealth, parseBaseUrl, verifyRelease } from "./verify-release.mjs";

const SHA = "9bdcf23c52e841c6ffd551654f155edd49f347ed";
const OTHER = "7a87701b99eed9f9761ed645d84492898382887c";

test("app JWT is RS256-signed, short-lived and issued by the app id", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const jwt = createAppJwt("123456", pem, 1_800_000_000);
  const [h, p, s] = jwt.split(".");
  const dec = x => JSON.parse(Buffer.from(x, "base64url").toString());
  assert.deepEqual(dec(h), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(dec(p), { iat: 1_799_999_940, exp: 1_800_000_540, iss: "123456" });
  const v = createVerify("RSA-SHA256"); v.update(`${h}.${p}`);
  assert.ok(v.verify(publicKey, Buffer.from(s, "base64url")));
});
test("app JWT fails closed without valid secrets", () => {
  assert.throws(() => createAppJwt("", "x"), /RELEASE_APP_ID/);
  assert.throws(() => createAppJwt("12", ""), /PEM/);
  assert.throws(() => createAppJwt("abc", "-----BEGIN PRIVATE KEY-----"), /numeric/);
});

test("health classification never accepts unknown or a different commit", () => {
  assert.equal(classifyHealth(200, { status: "ok", build: { commit: SHA } }, SHA).match, true);
  assert.match(classifyHealth(200, { status: "ok", build: { commit: "unknown" } }, SHA).detail, /unknown/);
  assert.equal(classifyHealth(200, { status: "ok", build: { commit: "unknown" } }, SHA).match, false);
  assert.equal(classifyHealth(200, { status: "ok" }, SHA).match, false);
  assert.equal(classifyHealth(200, { status: "ok", build: { commit: OTHER } }, SHA).match, false);
  assert.equal(classifyHealth(503, { status: "error", build: { commit: SHA } }, SHA).match, false);
  assert.equal(classifyHealth(200, null, SHA).match, false);
});
test("production URL must be https (http only for loopback tests)", () => {
  assert.throws(() => parseBaseUrl("http://wecommander.app"), /https/);
  assert.throws(() => parseBaseUrl(""), /valid URL/);
  assert.equal(parseBaseUrl("https://wecommander.app").host, "wecommander.app");
  assert.equal(parseBaseUrl("http://127.0.0.1:1").hostname, "127.0.0.1");
});

async function withHealth(sequence, fn) {
  let i = 0;
  const server = createServer((req, res) => {
    const body = sequence[Math.min(i++, sequence.length - 1)];
    res.writeHead(body.http || 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const opts = { intervalMs: 20, timeoutMs: 1500 };

test("verification waits through the old build and needs two consecutive matches", async () => {
  const seq = [{ status: "ok", build: { commit: OTHER } }, { http: 503, status: "error" }, { status: "ok", build: { commit: SHA } }, { status: "ok", build: { commit: SHA } }];
  const r = await withHealth(seq, baseUrl => verifyRelease({ baseUrl, sha: SHA, ...opts }));
  assert.equal(r.ok, true);
});
test("verification fails when the build reports unknown", async () => {
  const r = await withHealth([{ status: "ok", build: { commit: "unknown" } }], baseUrl => verifyRelease({ baseUrl, sha: SHA, ...opts, timeoutMs: 300 }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /unknown/);
});
test("a single flapping match is not enough", async () => {
  const seq = [{ status: "ok", build: { commit: SHA } }, { status: "ok", build: { commit: OTHER } }];
  const r = await withHealth(seq, baseUrl => verifyRelease({ baseUrl, sha: SHA, ...opts, timeoutMs: 300 }));
  assert.equal(r.ok, false);
});
test("verification rejects an invalid sha before any request", async () => {
  await assert.rejects(verifyRelease({ baseUrl: "https://example.test", sha: "main" }), /40-character/);
});
