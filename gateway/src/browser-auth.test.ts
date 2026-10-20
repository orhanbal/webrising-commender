import assert from "node:assert/strict";
import test from "node:test";
import {
  authCookies,
  clearAuthCookies,
  hashPassword,
  newBrowserSessionMaterial,
  normalizeEmail,
  sessionTokenFromCookie,
  verifyPassword,
} from "./browser-auth.js";

test("password verifiers are salted and validate only the correct password", async () => {
  const first = await hashPassword("correct-horse-battery-staple");
  const second = await hashPassword("correct-horse-battery-staple");

  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct-horse-battery-staple", first), true);
  assert.equal(await verifyPassword("wrong-password-value", first), false);
  assert.equal(await verifyPassword("correct-horse-battery-staple", "invalid"), false);
});

test("browser session material never reuses the raw token as its verifier", () => {
  const material = newBrowserSessionMaterial();
  assert.match(material.sessionToken, /^wrcs_/);
  assert.match(material.csrfToken, /^wrcc_/);
  assert.notEqual(material.sessionHash, material.sessionToken);
  assert.notEqual(material.csrfHash, material.csrfToken);
});

test("session cookies are strict and session token is HttpOnly", () => {
  const cookies = authCookies("wrcs_example", "wrcc_example", 3600, true);
  assert.equal(cookies.length, 2);
  assert.match(cookies[0]!, /HttpOnly/);
  assert.match(cookies[0]!, /SameSite=Strict/);
  assert.match(cookies[0]!, /Secure/);
  assert.doesNotMatch(cookies[1]!, /HttpOnly/);
  assert.equal(
    sessionTokenFromCookie("other=1; commender_session=wrcs_example; commender_csrf=wrcc_example"),
    "wrcs_example",
  );

  const cleared = clearAuthCookies(true);
  assert.ok(cleared.every((value) => value.includes("Max-Age=0")));
});

test("email normalization is deterministic", () => {
  assert.equal(normalizeEmail("  Owner@Example.COM "), "owner@example.com");
});
