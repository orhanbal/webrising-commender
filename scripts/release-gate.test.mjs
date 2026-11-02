import test from "node:test";
import assert from "node:assert/strict";
import { evaluateReleaseGate } from "./release-gate.mjs";

const SHA = "9bdcf23c52e841c6ffd551654f155edd49f347ed";
const PREV = "7a87701b99eed9f9761ed645d84492898382887c";
const jobs = n => Array.from({ length: n }, (_, i) => ({ name: `job-${i}`, status: "completed", conclusion: "success" }));
const base = (over = {}) => ({
  mode: "promote", sha: SHA, confirmSha: SHA, minCiJobs: 17,
  shaIsOnMain: true, productionSha: PREV, productionIsAncestor: true, releasedShas: [PREV],
  ciRuns: [{ id: 41113664032, head_sha: SHA, event: "push", head_branch: "main", status: "completed", conclusion: "success", run_attempt: 1 }],
  ciJobs: jobs(17),
  distributionRuns: [{ id: 1, head_sha: SHA, status: "completed", conclusion: "success" }],
  ...over,
});
const refused = (r, re) => { assert.equal(r.ok, false); assert.ok(r.reasons.some(x => re.test(x)), r.reasons.join("; ")); };

test("green exact-sha main commit with distribution is promotable", () => {
  const r = evaluateReleaseGate(base());
  assert.deepEqual(r.reasons, []);
  assert.equal(r.ok, true);
  assert.equal(r.ciRunId, 41113664032);
});

test("first release with no production branch is allowed", () => {
  assert.equal(evaluateReleaseGate(base({ productionSha: null, productionIsAncestor: false, releasedShas: [] })).ok, true);
});

for (const bad of ["main", "production", "9bdcf23c", SHA.toUpperCase(), ` ${SHA}`, "", undefined, "v1.0.0"])
  test(`non-sha ref ${JSON.stringify(bad)} is refused`, () => refused(evaluateReleaseGate(base({ sha: bad, confirmSha: bad })), /full lowercase 40-character/));

test("confirmation must match exactly", () => refused(evaluateReleaseGate(base({ confirmSha: PREV })), /confirm_sha/));
test("commit not on main (PR branch, fork) is refused", () => refused(evaluateReleaseGate(base({ shaIsOnMain: false })), /not reachable from origin\/main/));
test("re-releasing the current production head is refused", () => refused(evaluateReleaseGate(base({ productionSha: SHA })), /already the production head/));
test("promotion cannot move production backwards", () => refused(evaluateReleaseGate(base({ productionIsAncestor: false })), /fast-forward/));

test("pull_request CI does not count, only main push CI", () => {
  refused(evaluateReleaseGate(base({ ciRuns: [{ ...base().ciRuns[0], event: "pull_request" }] })), /no completed successful `ci` push run/);
  refused(evaluateReleaseGate(base({ ciRuns: [{ ...base().ciRuns[0], head_branch: "feature" }] })), /no completed successful `ci` push run/);
});
test("CI for a different sha does not count", () =>
  refused(evaluateReleaseGate(base({ ciRuns: [{ ...base().ciRuns[0], head_sha: PREV }] })), /no completed successful/));
test("failed or running CI is refused", () => {
  refused(evaluateReleaseGate(base({ ciRuns: [{ ...base().ciRuns[0], conclusion: "failure" }] })), /no completed successful/);
  refused(evaluateReleaseGate(base({ ciRuns: [{ ...base().ciRuns[0], status: "in_progress", conclusion: null }] })), /no completed successful/);
});
test("a failed or cancelled job inside a green run is refused", () => {
  const j = jobs(17); j[5] = { name: "rust-platforms (windows-latest)", status: "completed", conclusion: "cancelled" };
  refused(evaluateReleaseGate(base({ ciJobs: j })), /rust-platforms \(windows-latest\)" is completed\/cancelled/);
});
test("a run with missing jobs is refused", () => refused(evaluateReleaseGate(base({ ciJobs: jobs(16) })), /16 jobs, expected at least 17/));
test("an all-skipped run is refused", () =>
  refused(evaluateReleaseGate(base({ ciJobs: jobs(17).map(j => ({ ...j, conclusion: "skipped" })) })), /no successful job/));
test("missing or failed platform distribution is refused", () => {
  refused(evaluateReleaseGate(base({ distributionRuns: [] })), /platform-distribution/);
  refused(evaluateReleaseGate(base({ distributionRuns: [{ head_sha: SHA, status: "completed", conclusion: "failure" }] })), /platform-distribution/);
});
test("latest successful attempt is selected when a run was retried", () => {
  const runs = [
    { id: 10, head_sha: SHA, event: "push", head_branch: "main", status: "completed", conclusion: "failure", run_attempt: 1 },
    { id: 11, head_sha: SHA, event: "push", head_branch: "main", status: "completed", conclusion: "success", run_attempt: 2 },
  ];
  assert.equal(evaluateReleaseGate(base({ ciRuns: runs })).ciRunId, 11);
});

test("rollback is only allowed to a previously released sha", () => {
  const back = base({ mode: "rollback", sha: PREV, confirmSha: PREV, productionSha: SHA, productionIsAncestor: false, releasedShas: [PREV],
    ciRuns: [{ ...base().ciRuns[0], head_sha: PREV }], distributionRuns: [{ head_sha: PREV, status: "completed", conclusion: "success" }] });
  assert.deepEqual(evaluateReleaseGate(back).reasons, []);
  refused(evaluateReleaseGate({ ...back, releasedShas: [] }), /never released/);
});
test("unknown mode is refused", () => refused(evaluateReleaseGate(base({ mode: "force" })), /unknown mode/));
