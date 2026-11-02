#!/usr/bin/env node
// WECOMMANDER production release gate (Issue #30).
//
// Production must never follow `main`. Coolify tracks the dedicated
// `production` branch, and that branch is only moved by the
// `promote-production` workflow after a named operator approves the
// `production` GitHub environment. This script is the deterministic decision
// step of that workflow: it refuses to promote any SHA that is not exactly a
// main commit with a fully green push CI run and a successful platform
// distribution run for the same SHA.
//
// The decision logic (`evaluateReleaseGate`) is pure and unit tested in
// release-gate.test.mjs. The CLI only gathers facts via `git` and `gh api`.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SHA_RE = /^[0-9a-f]{40}$/;
export const RELEASE_TAG_PREFIX = "production-release/";
const OK_JOB_CONCLUSIONS = new Set(["success", "skipped"]);

/**
 * @param {object} f facts gathered by the CLI (or a test)
 * @param {"promote"|"rollback"} f.mode
 * @param {string} f.sha            requested commit (full 40-hex)
 * @param {string} f.confirmSha     operator re-typed commit, must equal sha
 * @param {boolean} f.shaIsOnMain   sha is an ancestor of (or equal to) origin/main
 * @param {string|null} f.productionSha current production branch head, null if absent
 * @param {boolean} f.productionIsAncestor production head is an ancestor of sha (fast-forward)
 * @param {string[]} f.releasedShas  SHAs carrying a production-release/* tag
 * @param {object[]} f.ciRuns       `ci` workflow runs for head_sha=sha
 * @param {object[]} f.ciJobs       jobs of the selected ci run (latest attempt)
 * @param {object[]} f.distributionRuns `platform-distribution` runs for head_sha=sha
 * @param {number} f.minCiJobs      lower bound of jobs the ci run must contain
 */
export function evaluateReleaseGate(f) {
  const reasons = [];
  const mode = f.mode;
  if (mode !== "promote" && mode !== "rollback") reasons.push(`unknown mode "${mode}"`);
  if (typeof f.sha !== "string" || !SHA_RE.test(f.sha)) {
    reasons.push("sha must be a full lowercase 40-character commit id (no branch names, tags or short SHAs)");
    return { ok: false, reasons, ciRunId: null };
  }
  if (f.confirmSha !== f.sha) reasons.push("confirm_sha does not exactly match sha");
  if (!f.shaIsOnMain) reasons.push("sha is not reachable from origin/main; only reviewed main commits can be released");
  if (f.productionSha && f.productionSha === f.sha) reasons.push("sha is already the production head; nothing to release");

  if (mode === "promote" && f.productionSha && !f.productionIsAncestor)
    reasons.push("promotion must fast-forward production; use mode=rollback to move production backwards");
  if (mode === "rollback" && !(f.releasedShas || []).includes(f.sha))
    reasons.push("rollback target was never released to production (no production-release/* tag on this sha)");

  const pushRuns = (f.ciRuns || []).filter(r =>
    r.head_sha === f.sha && r.event === "push" && r.head_branch === "main" && r.status === "completed");
  const greenRun = pushRuns
    .filter(r => r.conclusion === "success")
    .sort((a, b) => (b.run_attempt || 1) - (a.run_attempt || 1) || b.id - a.id)[0];
  let ciRunId = null;
  if (!greenRun) {
    reasons.push("no completed successful `ci` push run on main for this exact sha");
  } else {
    ciRunId = greenRun.id;
    const jobs = f.ciJobs || [];
    const minJobs = Number.isInteger(f.minCiJobs) && f.minCiJobs > 0 ? f.minCiJobs : 1;
    if (jobs.length < minJobs) reasons.push(`ci run ${greenRun.id} has ${jobs.length} jobs, expected at least ${minJobs}`);
    const bad = jobs.filter(j => j.status !== "completed" || !OK_JOB_CONCLUSIONS.has(j.conclusion));
    for (const j of bad) reasons.push(`ci job "${j.name}" is ${j.status}/${j.conclusion}`);
    const succeeded = jobs.filter(j => j.conclusion === "success").length;
    if (jobs.length && succeeded === 0) reasons.push("ci run contains no successful job");
  }

  const dist = (f.distributionRuns || []).some(r =>
    r.head_sha === f.sha && r.status === "completed" && r.conclusion === "success");
  if (!dist) reasons.push("no successful `platform-distribution` run for this exact sha");

  return { ok: reasons.length === 0, reasons, ciRunId };
}

function sh(cmd, args, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFail) return null;
    throw new Error(`${cmd} ${args.join(" ")} failed: ${(error.stderr || error.message || "").toString().trim()}`);
  }
}
const ghJson = path => JSON.parse(sh("gh", ["api", "-H", "Accept: application/vnd.github+json", path]));

function gatherFacts(env) {
  const repo = env.GITHUB_REPOSITORY;
  const sha = (env.RELEASE_SHA || "").trim();
  const facts = {
    mode: (env.RELEASE_MODE || "promote").trim(),
    sha,
    confirmSha: (env.RELEASE_CONFIRM_SHA || "").trim(),
    minCiJobs: Number.parseInt(env.RELEASE_MIN_CI_JOBS || "17", 10),
    shaIsOnMain: false, productionSha: null, productionIsAncestor: false,
    releasedShas: [], ciRuns: [], ciJobs: [], distributionRuns: [],
  };
  if (!repo) throw new Error("GITHUB_REPOSITORY is required");
  if (!SHA_RE.test(sha)) return facts; // evaluate() rejects it before any network call
  sh("git", ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  sh("git", ["fetch", "--no-tags", "origin", "+refs/heads/production:refs/remotes/origin/production"], { allowFail: true });
  sh("git", ["fetch", "origin", `+refs/tags/${RELEASE_TAG_PREFIX}*:refs/tags/${RELEASE_TAG_PREFIX}*`], { allowFail: true });
  facts.shaIsOnMain = sh("git", ["cat-file", "-e", `${sha}^{commit}`], { allowFail: true }) !== null
    && sh("git", ["merge-base", "--is-ancestor", sha, "origin/main"], { allowFail: true }) !== null;
  facts.productionSha = sh("git", ["rev-parse", "--verify", "-q", "refs/remotes/origin/production"], { allowFail: true }) || null;
  if (facts.productionSha)
    facts.productionIsAncestor = sh("git", ["merge-base", "--is-ancestor", facts.productionSha, sha], { allowFail: true }) !== null;
  const tagged = sh("git", ["for-each-ref", "--format=%(*objectname)%(objectname)", `refs/tags/${RELEASE_TAG_PREFIX}`], { allowFail: true }) || "";
  // annotated tags print "<commit><tagobject>", lightweight print "<commit>"
  facts.releasedShas = tagged.split("\n").map(l => l.slice(0, 40)).filter(s => SHA_RE.test(s));
  facts.ciRuns = ghJson(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=50`).workflow_runs || [];
  const pre = evaluateReleaseGate({ ...facts, ciJobs: [{ name: "probe", status: "completed", conclusion: "success" }] });
  if (pre.ciRunId) facts.ciJobs = ghJson(`repos/${repo}/actions/runs/${pre.ciRunId}/jobs?filter=latest&per_page=100`).jobs || [];
  facts.distributionRuns = ghJson(`repos/${repo}/actions/workflows/ubuntu-distribution.yml/runs?head_sha=${sha}&per_page=50`).workflow_runs || [];
  return facts;
}

function main() {
  const facts = gatherFacts(process.env);
  const result = evaluateReleaseGate(facts);
  const lines = [
    `### Production release gate: ${result.ok ? "PASSED" : "REFUSED"}`,
    "",
    `- mode: \`${facts.mode}\``,
    `- requested sha: \`${facts.sha || "(empty)"}\``,
    `- current production: \`${facts.productionSha || "(branch absent)"}\``,
    `- ci run: ${result.ciRunId ? `#${result.ciRunId}` : "none"}`,
    ...result.reasons.map(r => `- refused: ${r}`),
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ci_run_id=${result.ciRunId || ""}\nprevious_production=${facts.productionSha || ""}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try { main(); } catch (error) { console.error(`release gate error: ${error.message}`); process.exit(2); }
}
