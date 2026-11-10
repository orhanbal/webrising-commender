#!/usr/bin/env node
// WECOMMANDER production release gate (Issue #30).
//
// Production never follows `main`. Coolify tracks the dedicated `production`
// branch. That branch is created once (mode=bootstrap) and afterwards moved
// (promote/rollback) only by the `promote-production` workflow, after the
// owner approves the `production` environment. `production-guard` re-runs this gate in mode=audit on every
// production/tag update and daily.
//
// The decision (`evaluateReleaseGate`) is pure and unit tested. The CLI only
// gathers facts with `git` and the public GitHub REST API (GH_TOKEN optional),
// so it needs no `gh` CLI and makes no writes.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SHA_RE = /^[0-9a-f]{40}$/;
export const RELEASE_TAG_PREFIX = "production-release/";
export const MODES = ["bootstrap", "promote", "rollback", "audit"];
export const DIST_ARTIFACT_PREFIX = "WECOMMANDER-multiplatform-preview-";
// run-name of ubuntu-distribution.yml ends with "(ci <workflow_run.id>/<run_attempt>)".
export const DIST_MARKER_RE = /\(ci (\d+)\/(\d+)\)$/;

// Every job of .github/workflows/ci.yml, matrix legs expanded. macOS checks
// live in macos.yml and are deliberately not part of the production gate:
// GitHub's macOS runner capacity must not block a Linux release, and the
// macOS installer is only published after macos.yml passes. No job in ci.yml
// is conditional, so each must be present and `success`; a skipped, cancelled,
// missing or extra job refuses the release. release-gate.test.mjs keeps this
// list in sync with ci.yml.
export const REQUIRED_CI_JOBS = Object.freeze([
  "windows-powershell-preflight",
  "rust",
  "rust-platforms (windows-latest)",
  "gateway",
  "integration",
  "agent-e2e",
  "relay-e2e",
  "tls-smoke",
  "compose-smoke",
  "installer-syntax (ubuntu-latest)",
  "installer-syntax (windows-latest)",
  "linux-acceptance-artifact",
  "windows-acceptance-artifact",
  "windows-service-smoke",
  "center-windows",
  "center-winui",
  "center-linux",
  "plan-tools",
  "desktop (ubuntu-latest)",
  "desktop (windows-latest)",
]);

/**
 * A release tag counts only if it is an annotated tag under production-release/
 * whose message records `sha: <commit>` for the commit it points at. Lightweight
 * tags or tags whose message disagrees with their target are ignored (and
 * reported), so a hand-made tag cannot whitelist a rollback target.
 */
export function releasedShasFromTags(tags = []) {
  const released = new Set(), rejected = [];
  for (const t of tags) {
    const recorded = /^sha: ([0-9a-f]{40})$/m.exec(t.message || "")?.[1];
    if (t.type === "tag" && SHA_RE.test(t.commit || "") && recorded === t.commit) released.add(t.commit);
    else rejected.push(t.ref);
  }
  return { released: [...released], rejected };
}

const runTime = r => {
  const t = Date.parse(r.run_started_at || r.created_at || "");
  return Number.isFinite(t) ? t : 0;
};
/** Newest run by latest-attempt start time, then attempt, then id. */
export function newestRun(runs) {
  return [...runs].sort((a, b) => runTime(b) - runTime(a) || (b.run_attempt || 1) - (a.run_attempt || 1) || b.id - a.id)[0] || null;
}

/**
 * @param {object} f facts gathered by the CLI (or a test)
 * @param {string} f.mode            bootstrap | promote | rollback | audit
 * @param {string} f.sha             commit to release (audit: current production head)
 * @param {string} f.confirmSha      re-typed commit, must equal sha (audit: = sha)
 * @param {boolean} f.shaIsOnMain    sha is reachable from origin/main
 * @param {string|null} f.productionSha current production head, null if absent
 * @param {boolean} f.productionIsAncestor production head is an ancestor of sha
 * @param {object[]} f.releaseTags   [{ref,type,commit,message}] under production-release/
 * @param {object[]} f.ciRuns        `ci` workflow runs for head_sha=sha
 * @param {object[]} f.ciJobs        jobs of the selected run's latest attempt
 * @param {object[]} f.distributionRuns `platform-distribution` runs for head_sha=sha
 */
export function evaluateReleaseGate(f) {
  const reasons = [];
  const mode = f.mode;
  if (!MODES.includes(mode)) reasons.push(`unknown mode "${mode}"`);
  if (typeof f.sha !== "string" || !SHA_RE.test(f.sha)) {
    reasons.push("sha must be a full lowercase 40-character commit id (no branch names, tags or short SHAs)");
    return { ok: false, reasons, ciRunId: null };
  }
  if (f.confirmSha !== f.sha) reasons.push("confirm_sha does not exactly match sha");
  if (!f.shaIsOnMain) reasons.push("sha is not reachable from origin/main; only reviewed main commits can be released");

  const { released } = releasedShasFromTags(f.releaseTags);
  const prod = f.productionSha || null;
  if (mode === "bootstrap") {
    if (prod) reasons.push("production branch already exists; bootstrap is a one-time operation");
    if (released.length || (f.releaseTags || []).length) reasons.push("production-release tags already exist; refusing to bootstrap twice");
  } else if (!prod) {
    reasons.push("production branch does not exist; run the one-time owner bootstrap first");
  } else {
    // Detect any production update that did not go through this gate.
    if (!released.includes(prod)) reasons.push(`production head ${prod} has no valid production-release tag: possible unauthorized update, investigate before releasing`);
    if (mode === "audit") {
      if (f.sha !== prod) reasons.push("audit sha must be the current production head");
    } else if (prod === f.sha) {
      reasons.push("sha is already the production head; nothing to release");
    }
    if (mode === "promote" && !f.productionIsAncestor)
      reasons.push("promotion must fast-forward production; use mode=rollback to move production backwards");
    if (mode === "rollback" && !released.includes(f.sha))
      reasons.push("rollback target was never released to production (no valid production-release tag on this sha)");
  }

  // Only the newest run decides, never an older green one. A run's
  // run_started_at moves forward on every re-run attempt, so a failed or
  // cancelled re-run of an older run also supersedes an earlier success.
  const ciRun = newestRun((f.ciRuns || []).filter(r =>
    r.head_sha === f.sha && r.event === "push" && r.head_branch === "main"));
  let ciRunId = null;
  if (!ciRun) {
    reasons.push("no `ci` push run on main for this exact sha");
  } else if (ciRun.status !== "completed" || ciRun.conclusion !== "success") {
    reasons.push(`newest \`ci\` run ${ciRun.id} (attempt ${ciRun.run_attempt || 1}) is ${ciRun.status}/${ciRun.conclusion}; an older success does not count`);
  } else {
    ciRunId = ciRun.id;
    const attempt = ciRun.run_attempt || 1;
    const jobs = f.ciJobs || [];
    const byName = new Map();
    for (const j of jobs) {
      if (byName.has(j.name)) reasons.push(`ci job "${j.name}" appears more than once`);
      byName.set(j.name, j);
      if (j.run_id !== undefined && j.run_id !== ciRun.id) reasons.push(`ci job "${j.name}" belongs to run ${j.run_id}, not ${ciRun.id}`);
      if (j.run_attempt !== undefined && j.run_attempt !== attempt) reasons.push(`ci job "${j.name}" is from attempt ${j.run_attempt}, not the latest attempt ${attempt}`);
    }
    for (const name of REQUIRED_CI_JOBS) {
      const j = byName.get(name);
      if (!j) reasons.push(`required ci job "${name}" is missing from run ${ciRun.id}`);
      else if (j.status !== "completed" || j.conclusion !== "success") reasons.push(`required ci job "${name}" is ${j.status}/${j.conclusion}`);
      else if (j.head_sha && j.head_sha !== f.sha) reasons.push(`ci job "${name}" ran on ${j.head_sha}`);
    }
    for (const name of byName.keys())
      if (!REQUIRED_CI_JOBS.includes(name)) reasons.push(`unexpected ci job "${name}"; update REQUIRED_CI_JOBS with ci.yml`);
  }

  // platform-distribution is a workflow_run workflow: GitHub lists it under
  // the default branch head at trigger time, not under the commit it built,
  // and every PR CI completion adds a skipped run. Associate it with the exact
  // ci run instead: by its run-name marker "(ci <run id>/<attempt>)", or, for
  // runs made before the marker existed, by the artifact named after the ci
  // run number. Skipped runs are ignored: a distribution is skipped only when
  // its ci run was not a successful main push, which the ci check refuses.
  if (ciRun) {
    const legacyArtifact = `${DIST_ARTIFACT_PREFIX}${ciRun.run_number}`;
    const linked = (f.distributionRuns || []).filter(r => {
      if (r.event !== "workflow_run" || r.conclusion === "skipped") return false;
      const m = DIST_MARKER_RE.exec(r.display_title || "");
      return m ? Number(m[1]) === ciRun.id : (r.artifactNames || []).includes(legacyArtifact);
    });
    const dist = newestRun(linked);
    const attempt = ciRun.run_attempt || 1;
    const distAttempt = dist && DIST_MARKER_RE.exec(dist.display_title || "");
    if (!dist) {
      reasons.push(`no \`platform-distribution\` run linked to ci run ${ciRun.id}`);
    } else if (dist.status !== "completed" || dist.conclusion !== "success") {
      reasons.push(`newest \`platform-distribution\` run ${dist.id} is ${dist.status}/${dist.conclusion}; an older success does not count`);
    } else if (distAttempt && Number(distAttempt[2]) !== attempt) {
      reasons.push(`newest \`platform-distribution\` run ${dist.id} belongs to ci attempt ${distAttempt[2]}, not the latest attempt ${attempt}`);
    } else if (runTime(dist) < runTime(ciRun)) {
      reasons.push(`newest \`platform-distribution\` run ${dist.id} predates the latest \`ci\` attempt; wait for the distribution of that attempt`);
    }
  }

  return { ok: reasons.length === 0, reasons, ciRunId };
}

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(" ")} failed: ${(error.stderr || error.message || "").toString().trim()}`);
  }
}

async function api(path, env) {
  const base = env.GITHUB_API_URL || "https://api.github.com";
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "wecommander-release-gate" };
  if (env.GH_TOKEN) headers.authorization = `Bearer ${env.GH_TOKEN}`;
  const response = await fetch(`${base}/${path}`, { headers });
  if (!response.ok) throw new Error(`GitHub API ${path} returned HTTP ${response.status}`);
  return response.json();
}

export async function gatherFacts(env) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("GITHUB_REPOSITORY (owner/name) is required");
  const remote = env.RELEASE_GIT_REMOTE || "origin";
  const mode = (env.RELEASE_MODE || "").trim();
  git(["fetch", "--no-tags", remote, "+refs/heads/main:refs/remotes/release-gate/main"]);
  git(["update-ref", "-d", "refs/remotes/release-gate/production"], { allowFail: true });
  git(["fetch", "--no-tags", remote, "+refs/heads/production:refs/remotes/release-gate/production"], { allowFail: true });
  git(["fetch", "--no-tags", remote, `+refs/tags/${RELEASE_TAG_PREFIX}*:refs/tags/${RELEASE_TAG_PREFIX}*`], { allowFail: true });
  const productionSha = git(["rev-parse", "--verify", "-q", "refs/remotes/release-gate/production^{commit}"], { allowFail: true }) || null;
  const sha = mode === "audit" ? (productionSha || "") : (env.RELEASE_SHA || "").trim();
  const facts = {
    mode, sha,
    confirmSha: mode === "audit" ? sha : (env.RELEASE_CONFIRM_SHA || "").trim(),
    shaIsOnMain: false, productionSha, productionIsAncestor: false,
    releaseTags: [], ciRuns: [], ciJobs: [], distributionRuns: [],
  };
  const refs = git(["for-each-ref", "--format=%(refname)", `refs/tags/${RELEASE_TAG_PREFIX}`], { allowFail: true }) || "";
  for (const ref of refs.split("\n").filter(Boolean)) {
    const type = git(["cat-file", "-t", ref], { allowFail: true });
    const commit = git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { allowFail: true });
    const message = type === "tag" ? (git(["for-each-ref", "--format=%(contents)", ref], { allowFail: true }) || "") : "";
    facts.releaseTags.push({ ref, type, commit, message });
  }
  if (!SHA_RE.test(sha)) return facts; // evaluate() refuses before any API call
  facts.shaIsOnMain = git(["cat-file", "-e", `${sha}^{commit}`], { allowFail: true }) !== null
    && git(["merge-base", "--is-ancestor", sha, "refs/remotes/release-gate/main"], { allowFail: true }) !== null;
  if (productionSha)
    facts.productionIsAncestor = git(["merge-base", "--is-ancestor", productionSha, sha], { allowFail: true }) !== null;
  facts.ciRuns = (await api(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`, env)).workflow_runs || [];
  const ciRun = newestRun(facts.ciRuns.filter(r => r.head_sha === sha && r.event === "push" && r.head_branch === "main"));
  if (!ciRun) return facts;
  if (ciRun.status === "completed" && ciRun.conclusion === "success")
    facts.ciJobs = (await api(`repos/${repo}/actions/runs/${ciRun.id}/jobs?filter=latest&per_page=100`, env)).jobs || [];
  // All distribution runs created since this ci run, every page (most are skipped PR runs).
  const since = encodeURIComponent(`>=${ciRun.created_at}`);
  for (let page = 1; page <= 20; page++) {
    const runs = (await api(`repos/${repo}/actions/workflows/ubuntu-distribution.yml/runs?created=${since}&per_page=100&page=${page}`, env)).workflow_runs || [];
    facts.distributionRuns.push(...runs);
    if (runs.length < 100) break;
    if (page === 20) throw new Error("too many platform-distribution runs to evaluate; refusing");
  }
  for (const r of facts.distributionRuns) {
    if (r.event === "workflow_run" && r.conclusion !== "skipped" && !DIST_MARKER_RE.test(r.display_title || ""))
      r.artifactNames = ((await api(`repos/${repo}/actions/runs/${r.id}/artifacts?per_page=100`, env)).artifacts || []).map(a => a.name);
  }
  return facts;
}

async function main() {
  const facts = await gatherFacts(process.env);
  const result = evaluateReleaseGate(facts);
  const { rejected } = releasedShasFromTags(facts.releaseTags);
  const lines = [
    `### Production release gate: ${result.ok ? "PASSED" : "REFUSED"}`,
    "",
    `- mode: \`${facts.mode || "(empty)"}\``,
    `- sha: \`${facts.sha || "(empty)"}\``,
    `- current production: \`${facts.productionSha || "(branch absent)"}\``,
    `- ci run: ${result.ciRunId ? `#${result.ciRunId}` : "none"}`,
    ...rejected.map(r => `- ignored invalid release tag: \`${r}\``),
    ...result.reasons.map(r => `- refused: ${r}`),
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  if (process.env.GITHUB_OUTPUT && result.ok)
    appendFileSync(process.env.GITHUB_OUTPUT, `ci_run_id=${result.ciRunId}\nprevious_production=${facts.productionSha || ""}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(error => { console.error(`release gate error: ${error.message}`); process.exitCode = 2; });
}
