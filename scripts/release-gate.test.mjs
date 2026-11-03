import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateReleaseGate, releasedShasFromTags, REQUIRED_CI_JOBS } from "./release-gate.mjs";

const SHA = "9bdcf23c52e841c6ffd551654f155edd49f347ed";
const PREV = "7a87701b99eed9f9761ed645d84492898382887c";
const OTHER = "0fda39640000000000000000000000000000beef";
const tag = (commit, over = {}) => ({ ref: `refs/tags/production-release/x-${commit.slice(0, 12)}`, type: "tag", commit,
  message: `mode: promote\nsha: ${commit}\nprevious: none\n`, ...over });
const jobs = () => REQUIRED_CI_JOBS.map(name => ({ name, status: "completed", conclusion: "success", head_sha: SHA }));
const dist = (over = {}, ciId = 41113664032, attempt = 1) => ({ id: 1, event: "workflow_run", head_sha: SHA, status: "completed", conclusion: "success",
  display_title: `platform-distribution for ${SHA} (ci ${ciId}/${attempt})`, ...over });
const run = (over = {}) => ({ id: 41113664032, head_sha: SHA, event: "push", head_branch: "main", status: "completed", conclusion: "success", run_attempt: 1, ...over });
const base = (over = {}) => ({
  mode: "promote", sha: SHA, confirmSha: SHA,
  shaIsOnMain: true, productionSha: PREV, productionIsAncestor: true, releaseTags: [tag(PREV)],
  ciRuns: [run()], ciJobs: jobs(),
  distributionRuns: [dist()],
  ...over,
});
const refused = (r, re) => { assert.equal(r.ok, false); assert.ok(r.reasons.some(x => re.test(x)), r.reasons.join("; ")); };

test("REQUIRED_CI_JOBS matches every job and matrix leg of ci.yml", () => {
  const yml = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const body = yml.slice(yml.indexOf("\njobs:\n"));
  const expected = [];
  const blocks = body.split(/\n(?=  [A-Za-z0-9_-]+:\n)/).slice(1);
  for (const b of blocks) {
    const id = /^  ([A-Za-z0-9_-]+):/.exec(b)[1];
    assert.ok(!/^    if:/m.test(b), `job ${id} is conditional; the gate requires unconditional jobs`);
    assert.ok(!/^    name:/m.test(b), `job ${id} has a custom name; update the gate`);
    const os = /^      matrix:\n        os: \[([^\]]+)\]/m.exec(b);
    if (os) for (const o of os[1].split(",")) expected.push(`${id} (${o.trim()})`);
    else { assert.ok(!/^    strategy:/m.test(b), `job ${id} has an unsupported matrix`); expected.push(id); }
  }
  assert.deepEqual([...expected].sort(), [...REQUIRED_CI_JOBS].sort());
});

test("green exact-sha main commit with distribution is promotable", () => {
  const r = evaluateReleaseGate(base());
  assert.deepEqual(r.reasons, []);
  assert.equal(r.ciRunId, 41113664032);
});

for (const bad of ["main", "production", "9bdcf23c", SHA.toUpperCase(), ` ${SHA}`, "", undefined, "v1.0.0", `${SHA}\n`])
  test(`non-sha ref ${JSON.stringify(bad)} is refused`, () => refused(evaluateReleaseGate(base({ sha: bad, confirmSha: bad })), /full lowercase 40-character/));

test("confirmation must match exactly", () => refused(evaluateReleaseGate(base({ confirmSha: PREV })), /confirm_sha/));
test("commit not on main (PR branch, fork) is refused", () => refused(evaluateReleaseGate(base({ shaIsOnMain: false })), /not reachable from origin\/main/));
test("re-releasing the current production head is refused", () =>
  refused(evaluateReleaseGate(base({ productionSha: SHA, releaseTags: [tag(SHA)] })), /already the production head/));
test("promotion cannot move production backwards or sideways", () => refused(evaluateReleaseGate(base({ productionIsAncestor: false })), /fast-forward/));
test("promotion requires an existing production branch (no silent first release)", () =>
  refused(evaluateReleaseGate(base({ productionSha: null, productionIsAncestor: false })), /does not exist; run the one-time owner bootstrap/));

test("unauthorized production update (untagged head) blocks promote, rollback and audit", () => {
  for (const mode of ["promote", "rollback", "audit"]) {
    const sha = mode === "audit" ? OTHER : SHA;
    refused(evaluateReleaseGate(base({ mode, sha, confirmSha: sha, productionSha: OTHER, releaseTags: [tag(PREV), tag(SHA)] })), /possible unauthorized update/);
  }
});

test("bootstrap succeeds only with no production branch and no release tags", () => {
  const ok = base({ mode: "bootstrap", productionSha: null, productionIsAncestor: false, releaseTags: [] });
  assert.deepEqual(evaluateReleaseGate(ok).reasons, []);
  refused(evaluateReleaseGate({ ...ok, productionSha: PREV }), /already exists/);
  refused(evaluateReleaseGate({ ...ok, releaseTags: [tag(PREV)] }), /refusing to bootstrap twice/);
  refused(evaluateReleaseGate({ ...ok, releaseTags: [tag(PREV, { type: "commit" })] }), /refusing to bootstrap twice/);
});

test("audit of a correctly released head passes and checks its CI", () => {
  const a = base({ mode: "audit", productionSha: SHA, releaseTags: [tag(SHA)] });
  assert.deepEqual(evaluateReleaseGate(a).reasons, []);
  refused(evaluateReleaseGate({ ...a, distributionRuns: [] }), /platform-distribution/);
  refused(evaluateReleaseGate({ ...a, sha: PREV, confirmSha: PREV }), /audit sha must be the current production head/);
});

test("pull_request or non-main CI does not count, only main push CI", () => {
  refused(evaluateReleaseGate(base({ ciRuns: [run({ event: "pull_request" })] })), /no `ci` push run on main/);
  refused(evaluateReleaseGate(base({ ciRuns: [run({ head_branch: "feature" })] })), /no `ci` push run on main/);
  refused(evaluateReleaseGate(base({ ciRuns: [run({ head_sha: PREV })] })), /no `ci` push run on main/);
});
test("failed or running CI is refused", () => {
  refused(evaluateReleaseGate(base({ ciRuns: [run({ conclusion: "failure" })] })), /newest `ci` run .* is completed\/failure/);
  refused(evaluateReleaseGate(base({ ciRuns: [run({ status: "in_progress", conclusion: null })] })), /is in_progress\/null/);
});
for (const conclusion of ["cancelled", "skipped", "failure", "neutral", null]) {
  test(`a required job with conclusion ${conclusion} is refused`, () => {
    const j = jobs(); j[2] = { ...j[2], conclusion, status: conclusion ? "completed" : "in_progress" };
    refused(evaluateReleaseGate(base({ ciJobs: j })), /required ci job "rust-platforms \(windows-latest\)" is/);
  });
}
test("a missing required job is refused", () => {
  refused(evaluateReleaseGate(base({ ciJobs: jobs().filter(j => j.name !== "macos-acceptance-artifact") })), /"macos-acceptance-artifact" is missing/);
});
test("unexpected or duplicated jobs are refused", () => {
  refused(evaluateReleaseGate(base({ ciJobs: [...jobs(), { name: "new-job", status: "completed", conclusion: "success" }] })), /unexpected ci job "new-job"/);
  refused(evaluateReleaseGate(base({ ciJobs: [...jobs(), jobs()[0]] })), /appears more than once/);
});
test("a job reporting a different sha is refused", () => {
  const j = jobs(); j[0] = { ...j[0], head_sha: PREV };
  refused(evaluateReleaseGate(base({ ciJobs: j })), /ran on/);
});
test("missing or failed platform distribution is refused", () => {
  refused(evaluateReleaseGate(base({ distributionRuns: [] })), /no `platform-distribution` run linked to ci run 41113664032/);
  refused(evaluateReleaseGate(base({ distributionRuns: [dist({ conclusion: "failure" })] })), /platform-distribution/);
  refused(evaluateReleaseGate(base({ distributionRuns: [dist({}, 999)] })), /no `platform-distribution` run linked/);
});
test("distribution is linked to the ci run, not to its listed head_sha", () => {
  // GitHub lists workflow_run runs under the default-branch head at trigger time.
  assert.deepEqual(evaluateReleaseGate(base({ distributionRuns: [dist({ head_sha: PREV })] })).reasons, []);
  // A run listed under this sha but built for another ci run does not count.
  refused(evaluateReleaseGate(base({ distributionRuns: [dist({}, 41113316174)] })), /no `platform-distribution` run linked/);
  // Skipped runs (triggered by PR CI) are ignored even when newest.
  assert.deepEqual(evaluateReleaseGate(base({ distributionRuns: [dist({ id: 1 }), dist({ id: 2, conclusion: "skipped", display_title: "platform-distribution" })] })).reasons, []);
});
test("legacy distribution runs are linked by the ci run-number artifact", () => {
  const legacy = { id: 41114449603, event: "workflow_run", head_sha: SHA, status: "completed", conclusion: "success",
    display_title: "platform-distribution", artifactNames: ["WECOMMANDER-multiplatform-preview-1530"] };
  const ci = [run({ run_number: 1530 })];
  assert.deepEqual(evaluateReleaseGate(base({ ciRuns: ci, distributionRuns: [legacy] })).reasons, []);
  // 41113316174 is listed with a matching-looking sha but built ci run 1529 (7a87701b).
  refused(evaluateReleaseGate(base({ ciRuns: ci, distributionRuns: [{ ...legacy, id: 41113316174, artifactNames: ["WECOMMANDER-multiplatform-preview-1529"] }] })), /no `platform-distribution` run linked/);
  refused(evaluateReleaseGate(base({ ciRuns: ci, distributionRuns: [{ ...legacy, artifactNames: undefined }] })), /no `platform-distribution` run linked/);
});
// Regression (review of #33): an older green run must never outvote a newer
// failed, cancelled or unfinished run or attempt of the same sha.
const at = (min) => `2026-11-02T20:${String(min).padStart(2, "0")}:00Z`;
const distAt = (min, over = {}, ciId = 41113664032, attempt = 1) => dist({ id: 900 + min, run_started_at: at(min), ...over }, ciId, attempt);
for (const [label, newer] of [
  ["failed", { conclusion: "failure" }],
  ["cancelled", { conclusion: "cancelled" }],
  ["timed out", { conclusion: "timed_out" }],
  ["still running", { status: "in_progress", conclusion: null }],
  ["queued", { status: "queued", conclusion: null }],
]) {
  test(`a newer ${label} ci run supersedes an older successful run`, () => {
    const runs = [run({ id: 10, run_started_at: at(1) }), run({ id: 11, run_started_at: at(5), ...newer })];
    refused(evaluateReleaseGate(base({ ciRuns: runs, distributionRuns: [distAt(2, {}, 10)] })), /newest `ci` run 11 .*an older success does not count/);
  });
  test(`a ${label} re-run attempt supersedes the earlier successful attempt`, () => {
    // The runs API reports the latest attempt; run_started_at moves forward.
    const runs = [run({ id: 10, run_attempt: 2, run_started_at: at(9), ...newer }), run({ id: 9, run_started_at: at(1) })];
    refused(evaluateReleaseGate(base({ ciRuns: runs, distributionRuns: [distAt(2, {}, 10, 1)] })), /newest `ci` run 10 \(attempt 2\)/);
  });
  test(`a newer ${label} platform-distribution run supersedes an older success`, () => {
    const runs = [run({ run_started_at: at(1) })];
    refused(evaluateReleaseGate(base({ ciRuns: runs, distributionRuns: [distAt(2), distAt(6, newer)] })), /newest `platform-distribution` run 906 .*older success does not count/);
  });
}
test("a newer successful run is accepted even after an older failure", () => {
  const runs = [run({ id: 10, conclusion: "failure", run_started_at: at(1) }), run({ id: 11, run_attempt: 2, run_started_at: at(5) })];
  const r = evaluateReleaseGate(base({ ciRuns: runs, ciJobs: jobs().map(j => ({ ...j, run_id: 11, run_attempt: 2 })), distributionRuns: [distAt(7, {}, 11, 2)] }));
  assert.deepEqual(r.reasons, []);
  assert.equal(r.ciRunId, 11);
});
test("distribution of an earlier ci attempt, or older than the attempt, is refused", () => {
  const runs = [run({ run_attempt: 2, run_started_at: at(8) })];
  refused(evaluateReleaseGate(base({ ciRuns: runs, distributionRuns: [distAt(9, {}, 41113664032, 1)] })), /belongs to ci attempt 1, not the latest attempt 2/);
  refused(evaluateReleaseGate(base({ ciRuns: runs, distributionRuns: [distAt(3, {}, 41113664032, 2)] })), /predates the latest `ci` attempt/);
});
test("jobs from another run or an older attempt are refused", () => {
  const runs = [run({ id: 11, run_attempt: 2, run_started_at: at(5) })];
  const d = [distAt(7, {}, 11, 2)];
  refused(evaluateReleaseGate(base({ ciRuns: runs, distributionRuns: d, ciJobs: jobs().map(j => ({ ...j, run_id: 11, run_attempt: 1 })) })), /from attempt 1, not the latest attempt 2/);
  refused(evaluateReleaseGate(base({ ciRuns: runs, distributionRuns: d, ciJobs: jobs().map(j => ({ ...j, run_id: 10, run_attempt: 2 })) })), /belongs to run 10, not 11/);
});

test("rollback only to a sha with a valid annotated release tag", () => {
  const back = base({ mode: "rollback", sha: PREV, confirmSha: PREV, productionSha: SHA, productionIsAncestor: false,
    releaseTags: [tag(PREV), tag(SHA)],
    ciRuns: [run({ head_sha: PREV })], ciJobs: jobs().map(j => ({ ...j, head_sha: PREV })),
    distributionRuns: [dist({ head_sha: PREV })] });
  assert.deepEqual(evaluateReleaseGate(back).reasons, []);
  refused(evaluateReleaseGate({ ...back, releaseTags: [tag(SHA)] }), /never released/);
  refused(evaluateReleaseGate({ ...back, releaseTags: [tag(SHA), tag(PREV, { type: "commit" })] }), /never released/);
  refused(evaluateReleaseGate({ ...back, releaseTags: [tag(SHA), tag(PREV, { message: `sha: ${OTHER}\n` })] }), /never released/);
});

test("releasedShasFromTags rejects lightweight and inconsistent tags", () => {
  const r = releasedShasFromTags([tag(SHA), tag(PREV, { type: "commit" }), tag(OTHER, { message: "no sha line" }), tag(PREV, { message: `sha: ${PREV}x` })]);
  assert.deepEqual(r.released, [SHA]);
  assert.equal(r.rejected.length, 3);
});
test("unknown mode is refused", () => refused(evaluateReleaseGate(base({ mode: "force" })), /unknown mode/));
