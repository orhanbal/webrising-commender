// Static security checks for the release workflows (Issue #30). They run in
// CI without third-party tooling and fail if a later edit weakens the release
// boundary: new triggers, broader permissions, unpinned actions, secrets
// outside the approved job, user input interpolated into shell scripts, or a
// distribution run-name the release gate can no longer parse.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DIST_MARKER_RE } from "./release-gate.mjs";

const dir = new URL("../.github/workflows/", import.meta.url);
const read = name => readFileSync(new URL(name, dir), "utf8");
const all = Object.fromEntries(readdirSync(dir).filter(f => f.endsWith(".yml")).map(f => [f, read(f)]));
const promote = all["promote-production.yml"];
const guard = all["production-guard.yml"];
const dist = all["ubuntu-distribution.yml"];

/** Top-level block (e.g. "on", "permissions") as text, without its key line. */
function block(yml, key) {
  const m = new RegExp(`^${key}:[^\\n]*\\n((?:[ \\t]+[^\\n]*\\n|\\n)*)`, "m").exec(yml);
  return m ? m[1] : null;
}
const expressions = yml => [...yml.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map(m => m[1].trim());

test("promote-production is dispatch-only", () => {
  const on = block(promote, "on");
  assert.match(on, /^  workflow_dispatch:/m);
  const triggers = [...on.matchAll(/^  ([a-z_]+):/gm)].map(m => m[1]);
  assert.deepEqual(triggers, ["workflow_dispatch"]);
});

test("no workflow uses pull_request_target or workflow_run with write tokens except distribution", () => {
  for (const [name, yml] of Object.entries(all)) assert.ok(!/pull_request_target/.test(yml), `${name} uses pull_request_target`);
  for (const [name, yml] of Object.entries(all))
    if (/^\s+workflow_run:/m.test(yml)) assert.ok(["ubuntu-distribution.yml", "macos-distribution.yml"].includes(name), `${name} uses workflow_run`);
});

test("macOS is outside the production gate but still gates the macOS installer", () => {
  const ci = all["ci.yml"], macos = all["macos.yml"], macDist = all["macos-distribution.yml"], dist = all["ubuntu-distribution.yml"];
  assert.ok(!/macos-latest|macos-acceptance-artifact:/.test(ci), "ci.yml has no macOS runner jobs");
  for (const job of ["rust-platforms:", "installer-syntax:", "macos-acceptance-artifact:"]) assert.ok(macos.includes("\n  " + job), job);
  assert.match(macos, /os: \[macos-latest\]/);
  assert.ok(!/\.pkg/.test(dist), "platform-distribution does not publish the macOS PKG");
  assert.match(macDist, /workflows: \["macos"\]/);
  assert.match(macDist, /workflow_run\.conclusion == 'success' && github\.event\.workflow_run\.event == 'push' && github\.event\.workflow_run\.head_branch == 'main'/);
  assert.ok(!/secrets\./.test(macDist), "no secrets in macOS distribution");
});

test("release and guard workflows have read-only GITHUB_TOKEN", () => {
  for (const yml of [promote, guard]) {
    const perms = block(yml, "permissions");
    assert.ok(perms, "explicit top-level permissions");
    const entries = [...perms.matchAll(/^  ([a-z-]+): ([a-z]+)/gm)].map(m => [m[1], m[2]]);
    assert.ok(entries.length > 0);
    for (const [scope, level] of entries) assert.equal(level, "read", `${scope}: ${level}`);
    assert.ok(!/^\s+permissions:/m.test(yml.slice(yml.indexOf("\njobs:"))), "no job-level permission override");
  }
});

test("every action in release-path workflows is pinned to a full commit sha", () => {
  for (const yml of [promote, guard]) {
    const uses = [...yml.matchAll(/uses:\s*([^\s#]+)/g)].map(m => m[1]);
    assert.ok(uses.length > 0);
    for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
  }
});

test("checkout never persists credentials in release-path workflows", () => {
  for (const yml of [promote, guard]) {
    const checkouts = yml.split(/\n\s+- uses: actions\/checkout@/).slice(1);
    assert.ok(checkouts.length > 0);
    for (const c of checkouts) assert.match(c.split(/\n\s+- /)[0], /persist-credentials: false/);
  }
});

test("release App secrets appear only in the approved production job", () => {
  for (const [name, yml] of Object.entries(all)) {
    const secrets = [...yml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]);
    if (name === "promote-production.yml") assert.deepEqual([...new Set(secrets)].sort(), ["RELEASE_APP_ID", "RELEASE_APP_PRIVATE_KEY"]);
    else assert.ok(!secrets.some(s => s.startsWith("RELEASE_")), `${name} references ${secrets}`);
  }
  const jobs = promote.slice(promote.indexOf("\njobs:"));
  assert.equal((jobs.match(/^  [a-z-]+:\n/gm) || []).length, 1, "a single job");
  assert.match(jobs, /^    environment: production$/m);
  assert.match(promote, /^concurrency:\n  group: production-release\n  cancel-in-progress: false$/m);
});

test("workflow inputs never reach a shell script by interpolation (script injection)", () => {
  for (const [name, yml] of Object.entries(all)) {
    const runBlocks = [...yml.matchAll(/^(\s+)run: \|\n((?:\1  [^\n]*\n|\n)*)/gm)].map(m => m[2]);
    const inline = [...yml.matchAll(/^\s+run: (?!\|)([^\n]+)$/gm)].map(m => m[1]);
    for (const script of [...runBlocks, ...inline])
      for (const e of expressions(script))
        assert.ok(!/inputs\.|github\.event\.(inputs|pull_request|issue|comment|head_commit|workflow_run\.(head_branch|display_title))/.test(e),
          `${name}: \${{ ${e} }} is interpolated into a shell script`);
  }
});

test("expressions in run-name use only allowed contexts and match the gate marker", () => {
  const runName = /^run-name: "(.*)"$/m.exec(dist)?.[1];
  assert.ok(runName, "ubuntu-distribution.yml has a run-name");
  for (const e of expressions(runName)) assert.match(e, /^github\.event\.workflow_run\.(head_sha|id|run_attempt)$/, e);
  const rendered = runName
    .replace("${{ github.event.workflow_run.head_sha }}", "9bdcf23c52e841c6ffd551654f155edd49f347ed")
    .replace("${{ github.event.workflow_run.id }}", "41113664032")
    .replace("${{ github.event.workflow_run.run_attempt }}", "2");
  assert.deepEqual([...DIST_MARKER_RE.exec(rendered)].slice(1), ["41113664032", "2"]);
});

test("release job refuses non-main dispatch and verifies deployments", () => {
  assert.match(promote, /if: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}\n\s+run: \|\n\s+echo "::error::promote-production must be dispatched on main/);
  assert.match(promote, /node scripts\/release-gate\.mjs/);
  assert.match(promote, /node scripts\/github-app-token\.mjs/);
  assert.match(promote, /if: \$\{\{ inputs\.mode != 'bootstrap' \}\}[\s\S]*node scripts\/verify-release\.mjs/);
  assert.match(promote, /ls-remote origin refs\/heads\/production/);
  assert.match(promote, /--force-with-lease=refs\/heads\/production:\$\{PREVIOUS\}/);
});

test("no workflow pushes to main", () => {
  for (const [name, yml] of Object.entries(all)) {
    assert.ok(!/push[^\n]*(HEAD|origin)[^\n]*:main\b/.test(yml), `${name} pushes to main`);
    assert.ok(!/git push origin main\b/.test(yml), `${name} pushes to main`);
  }
});
