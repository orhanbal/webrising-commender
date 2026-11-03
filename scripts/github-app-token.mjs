#!/usr/bin/env node
// Mints a short-lived, repository-scoped installation token for the dedicated
// release GitHub App (Issue #30). The default GITHUB_TOKEN cannot be put on a
// ruleset bypass list, so the protected `production` branch can only be moved
// by this App. Its private key lives only in the `production` environment
// secrets, which GitHub releases to a job after a required reviewer approves.
//
// Fails closed: no secrets -> no token -> no push. No third-party action.

import { createSign } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const b64url = input => Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export function createAppJwt(appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!/^\d+$/.test(String(appId || ""))) throw new Error("RELEASE_APP_ID must be the numeric GitHub App id");
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKeyPem || "")) throw new Error("RELEASE_APP_PRIVATE_KEY is not a PEM private key");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // GitHub allows at most 10 minutes; backdate iat for clock drift.
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`;
}

async function call(method, path, auth, body) {
  const base = process.env.GITHUB_API_URL || "https://api.github.com";
  const response = await fetch(`${base}/${path}`, {
    method,
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "wecommander-release", authorization: `Bearer ${auth}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`GitHub API ${method} ${path} returned HTTP ${response.status}`);
  return response.json();
}

export async function mintInstallationToken(env) {
  const repo = env.GITHUB_REPOSITORY || "";
  const [, name] = repo.split("/");
  if (!name) throw new Error("GITHUB_REPOSITORY is required");
  const jwt = createAppJwt(env.RELEASE_APP_ID, env.RELEASE_APP_PRIVATE_KEY);
  const installation = await call("GET", `repos/${repo}/installation`, jwt);
  const token = await call("POST", `app/installations/${installation.id}/access_tokens`, jwt, {
    repositories: [name],
    permissions: { contents: "write" },
  });
  if (!token.token) throw new Error("GitHub did not return an installation token");
  return token.token;
}

async function main() {
  const token = await mintInstallationToken(process.env);
  process.stdout.write(`::add-mask::${token}\n`);
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT, `token=${token}\n`);
  console.log("release app token minted (contents:write, this repository only, expires in 1h)");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(error => { console.error(`release app token error: ${error.message}`); process.exitCode = 1; });
}
