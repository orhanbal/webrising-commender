#!/usr/bin/env node
// Post-release verification (Issue #30): polls the public gateway /health until
// it reports the released commit, then requires a second consecutive match.
// `unknown`, a missing build block, another SHA, or a non-ok health response is
// never accepted; timing out fails the release.

import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const SHA_RE = /^[0-9a-f]{40}$/;

export function classifyHealth(httpStatus, body, sha) {
  if (httpStatus !== 200 || body?.status !== "ok") return { match: false, detail: `health HTTP ${httpStatus} status=${body?.status ?? "?"}` };
  const commit = body?.build?.commit;
  if (commit === undefined) return { match: false, detail: "health has no build.commit (gateway predates release identity)" };
  if (commit === "unknown") return { match: false, detail: "build.commit is unknown (SOURCE_COMMIT not passed to the build)" };
  if (commit !== sha) return { match: false, detail: `build.commit ${commit} != ${sha}` };
  return { match: true, detail: `build.commit ${commit}` };
}

export function parseBaseUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("PRODUCTION_BASE_URL is not a valid URL"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("PRODUCTION_BASE_URL must use https://");
  return url;
}

export async function verifyRelease({ baseUrl, sha, timeoutMs = 20 * 60_000, intervalMs = 15_000, requiredMatches = 2, log = () => {} }) {
  if (!SHA_RE.test(sha || "")) throw new Error("RELEASE_SHA must be a full 40-character commit id");
  const url = new URL("/health", parseBaseUrl(baseUrl));
  const started = performance.now();
  let consecutive = 0, last = "no response";
  while (performance.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(Math.min(10_000, intervalMs * 2)) });
      let body = null;
      try { body = await response.json(); } catch {}
      const r = classifyHealth(response.status, body, sha);
      last = r.detail;
      consecutive = r.match ? consecutive + 1 : 0;
      log(`${r.match ? "MATCH" : "wait "} ${r.detail}`);
      if (consecutive >= requiredMatches) return { ok: true, detail: last };
    } catch (error) {
      consecutive = 0;
      last = `request failed: ${error.name}`;
      log(`wait  ${last}`);
    }
    await sleep(intervalMs);
  }
  return { ok: false, detail: `timed out after ${Math.round(timeoutMs / 1000)}s; last: ${last}` };
}

async function main() {
  const env = process.env;
  const result = await verifyRelease({
    baseUrl: env.PRODUCTION_BASE_URL || "",
    sha: (env.RELEASE_SHA || "").trim(),
    timeoutMs: Number(env.RELEASE_VERIFY_TIMEOUT_MS || 20 * 60_000),
    intervalMs: Number(env.RELEASE_VERIFY_INTERVAL_MS || 15_000),
    log: line => console.log(line),
  });
  const summary = `### Deployed release identity: ${result.ok ? "VERIFIED" : "NOT VERIFIED"}\n\n- ${result.detail}\n`;
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  process.exitCode = result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(error => { console.error(`release verification error: ${error.message}`); process.exitCode = 2; });
}
