import test from "node:test";
import assert from "node:assert/strict";
import { announcePages, indexNowKey, indexNowPayload, shouldAnnounce } from "./indexnow.js";

test("the IndexNow key is stable per origin and in the allowed format", () => {
  const key = indexNowKey("https://wecommander.app");
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(key, indexNowKey("https://wecommander.app"));
  assert.notEqual(key, indexNowKey("https://staging.example.com"));
});

test("the payload lists every public page of the origin with the key location", () => {
  const body = indexNowPayload("https://wecommander.app");
  assert.equal(body.host, "wecommander.app");
  assert.equal(body.keyLocation, `https://wecommander.app/${body.key}.txt`);
  assert.ok(body.urlList.includes("https://wecommander.app/"));
  assert.ok(body.urlList.includes("https://wecommander.app/pricing"));
  assert.ok(body.urlList.every((u) => u.startsWith("https://wecommander.app/")));
});

test("only the real public site announces itself", () => {
  assert.equal(shouldAnnounce("https://wecommander.app", {}), true);
  assert.equal(shouldAnnounce("https://wecommander.app", { INDEXNOW_DISABLED: "true" }), false);
  assert.equal(shouldAnnounce("http://localhost:8787", {}), false);
  assert.equal(shouldAnnounce("https://preview.example.com", {}), false);
  assert.equal(shouldAnnounce("https://preview.example.com", { INDEXNOW_ENABLED: "true" }), true);
  assert.equal(shouldAnnounce("https://127.0.0.1", { INDEXNOW_ENABLED: "true" }), false);
});

test("an announcement posts JSON to api.indexnow.org and never throws", async () => {
  let seen: { url: string; body: any } | undefined;
  const ok = await announcePages("https://wecommander.app", (async (url: any, init: any) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return new Response(null, { status: 202 });
  }) as typeof fetch);
  assert.equal(ok, 202);
  assert.equal(seen?.url, "https://api.indexnow.org/indexnow");
  assert.equal(seen?.body.host, "wecommander.app");
  const failed = await announcePages("https://wecommander.app", (async () => { throw new Error("offline"); }) as typeof fetch);
  assert.equal(failed, 0);
});
