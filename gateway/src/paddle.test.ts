import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

// Pool is constructed but unit tests never connect to PostgreSQL.
process.env.DATABASE_URL ||= "postgres://commender:unit-test@localhost:5432/commender";
const { checkPaddleSignature } = await import("./paddle.js");
const secret = "pdl_ntfset_signing_secret_for_unit_test";
const ts = 1792746000;
const body = Buffer.from(JSON.stringify({ event_id: "evt_test", event_type: "subscription.created" }));
const sign = (payload, stamp = ts) =>
  "ts=" + stamp + ";h1=" + createHmac("sha256", secret).update(String(stamp) + ":").update(payload).digest("hex");

test("Paddle webhook signatures authenticate the raw bytes and require fresh timestamps", () => {
  assert.equal(checkPaddleSignature(body, sign(body), secret, ts * 1000), true);
  assert.equal(checkPaddleSignature(body, sign(body), "wrong", ts * 1000), false);
  assert.equal(checkPaddleSignature(Buffer.concat([body, Buffer.from(" ")]), sign(body), secret, ts * 1000), false);
  assert.equal(checkPaddleSignature(body, sign(body), secret, ts * 1000 + 300001), false);
  assert.equal(checkPaddleSignature(body, sign(body, ts - 301), secret, ts * 1000), false);
  assert.equal(checkPaddleSignature(body, "", secret, ts * 1000), false);
  assert.equal(checkPaddleSignature(body, "ts=abc;h1=123", secret, ts * 1000), false);
  assert.equal(checkPaddleSignature(body, "ts=" + ts + ";h1=" + "0".repeat(64), secret, ts * 1000), false);
});

test("Paddle signature validation accepts rotated multi-h1 headers without accepting malformed hashes", () => {
  const genuine = sign(body);
  assert.equal(checkPaddleSignature(body, "ts=" + ts + ";h1=INVALID;h1=" + genuine.split("h1=")[1], secret, ts * 1000), true);
  assert.equal(checkPaddleSignature(body, "ts=" + ts + ";h1=INVALID", secret, ts * 1000), false);
});
