import test from "node:test";
import assert from "node:assert/strict";
import { redirectAllowed, validChallenge, validResource, validClientGrants } from "./oauth-validation.js";

test("OAuth registration rejects insecure, credentialed and fragment redirects", () => {
  for (const uri of ["https://chatgpt.com/connector_platform_oauth_redirect", "https://chatgpt.com/connector/oauth/test", "http://127.0.0.1:4321/callback"]) {
    assert.equal(redirectAllowed(uri), true, uri);
  }
  for (const uri of ["http://evil.example/callback", "javascript:alert(1)", "https://user:pass@a.example/cb", "https://a.example/cb#fragment", "", "https://"]) {
    assert.equal(redirectAllowed(uri), false, uri);
  }
});

test("OAuth is bound to gateway resource", () => {
  assert.equal(validResource("https://commander.example/mcp", "https://commander.example"), true);
  assert.equal(validResource("https://commander.example", "https://commander.example"), true);
  assert.equal(validResource("https://other.example/mcp", "https://commander.example"), false);
  assert.equal(validResource("https://commander.example/admin", "https://commander.example"), false);
});

test("PKCE requires S256-compatible verifier material", () => {
  assert.equal(validChallenge("a".repeat(43)), true);
  assert.equal(validChallenge("A_-".repeat(42) + "B"), true);
  assert.equal(validChallenge("a".repeat(42)), false);
  assert.equal(validChallenge("a".repeat(129)), false);
  assert.equal(validChallenge("a".repeat(42) + "="), false);
});

test("DCR accepts authorization code and optional refresh, not unrelated grants", () => {
  assert.equal(validClientGrants(undefined), true);
  assert.equal(validClientGrants(["authorization_code"]), true);
  assert.equal(validClientGrants(["refresh_token","authorization_code"]), true);
  assert.equal(validClientGrants(["password"]), false);
  assert.equal(validClientGrants(["refresh_token"]), false);
  assert.equal(validClientGrants(["authorization_code", "authorization_code"]), false);
});
