# WECOMMANDER — 1C/1D acceptance evidence gates

Baseline: main `a27c311586586e0e7a43946bb79e5fccec18c5d8` (2026-10-24).
Verified code candidate: `12a5addd2eb4257d385984c049a6d9c760f7a4b5`, CI #40143597740 (attempt 2), **17/17 PASS** (real Rust Agent E2E, PostgreSQL integration and all platform jobs).
Scope: Desktop Commander parity work packages 1C and 1D. This matrix does **not** supersede the canonical parity plan.
Status convention: PASS = test result linked to exact SHA and environment; PENDING = no verified gate; BLOCKED_EXTERNAL = requires authorized physical machine/network.

## Non-negotiable release rules

1. Do not equate Rust/TypeScript build success, CI smoke or artifact creation with physical acceptance.
2. No PASS without named test, exact SHA, CI run/job or signed manual test record, and expected/actual verdict.
3. Any change to native path traversal, pagination, quota accounting, file reads or MCP schemas must run positive AND adversarial regressions.
4. Never treat a historical CI run as proof for a newer code SHA.
5. Keep tenant/actor/device authorization, root allowlisting, symlink denial, bounded inputs/outputs, and HIGH-risk approval semantics unchanged.

## 1C — Search at scale, pagination, concurrency

| Gate | Acceptance criterion | Evidence so far | Status |
| --- | --- | --- | --- |
| 1C-01 | At least 530 fixture files; deterministic page boundaries, cap at 500 results, `truncated` correct, offset 490/length 30, no duplicate or omitted entries | Current candidate `a249abb1` agent-e2e 17/17 CI; five 100-item pages, unique results and stable re-read assertion | PASS (CI) |
| 1C-02 | Search query overlength (1025 chars), page size >100, invalid/negative offset fail closed; no silent widening of result set | Current candidate `a249abb1` agent-e2e 17/17 CI: 501 offset, 101 page size, 1025 query | PASS (CI) |
| 1C-03 | A symlink that escapes an allowed root never yields filename or content matches outside it | Current candidate `a249abb1` agent-e2e 17/17 CI: filename/content symlink escape | PASS (CI) |
| 1C-04 | Eight concurrent searches for one actor across two Gateway instances succeed; ninth is denied; other actors/organizations remain isolated | Existing sequential PostgreSQL E2E plus new actual nine-way concurrent `Promise.allSettled` cross-instance test (`gateway/test/integration.mjs`, commit `2d425ccb`); CI #40143597740 passed; independent persistence instances share one PostgreSQL actor quota, but two actual Gateway processes remain untested. | PARTIAL (CI) |
| 1C-05 | Stopped but unsettled native work still holds a quota slot; only native settlement releases it | Existing PostgreSQL E2E plus `2d425ccb` negative test: stopped/unsettled scanner retains quota until owner settlement; CI #40143597740 passed; native Agent settlement still requires end-to-end fault injection. | PARTIAL (CI) |
| 1C-06 | Simultaneous stop/settle/restart does not double-release slots, duplicate results or leak scans across tenant/device | `2d425ccb` concurrent stop/foreign settle/owner settle/idempotence/slot reuse test added. Process restart fault injection still missing. CI #40143597740 passed the concurrent PostgreSQL race test. | PARTIAL (CI) |
| 1C-07 | Sustained large-tree search under CPU/memory budgets with pause/resume and gateway interruption, on real Windows and Ubuntu agents | Requires authorized real devices | BLOCKED_EXTERNAL |

## 1D — Bounded multi-file reading and safe edits

| Gate | Acceptance criterion | Evidence so far | Status |
| --- | --- | --- | --- |
| 1D-01 | Multi-file read respects aggregate byte and per-file caps; partial results explicitly indicate truncation | `3085efe3` 17/17 CI: 10-file, 64 KiB per-file and 256 KiB aggregate raw budget; over-limit items return `read_failed`. Explicit `truncated` metadata for partial batch results is **not** implemented, so full criterion remains open. | PARTIAL (caps CI PASS) |
| 1D-02 | UTF-8 boundary, CRLF and binary files do not return invalid offsets or silently mutate contents | Current candidate `a249abb1` E2E checks Unicode/CRLF preservation, binary Base64 roundtrip, over-limit rejection. CRLF line offsets added in `79e0afd6` and exercised by `3085efe3` 17/17 CI. | PASS (CI) |
| 1D-03 | A single invalid/unreadable path cannot expose or overwrite any file outside allowed roots | `a249abb1` native E2E checks disallowed path and symlink to private external file, with successful neighboring reads, no data leak | PASS (CI) |
| 1D-04 | Concurrent modify/delete between metadata check and open/read is rejected or safely handled | TOCTOU regression on real native Agent required | PENDING |
| 1D-05 | Chunk/page continuation cannot be replayed for a different actor, device, tenant or changed file | MCP + Gateway + Agent negative test required | PENDING |
| 1D-06 | Native multi-file operations work after reconnect on Windows, Ubuntu, macOS if hardware exists | Authorized physical machine required | BLOCKED_EXTERNAL |

## Next implementation sequence

1. Locate exact Rust Agent and Gateway tests for 1C-01–1C-05, rerun against exact current code SHA, attach proof and mark only verified gates PASS.
2. Add 1C-06 fault-injection regression using two Gateway instances + PostgreSQL and real Rust Agent, then confirm 17/17 on the resulting SHA.
3. Audit existing 1D operations and MCP input contracts before adding overlapping features. Add the missing bounded read, encoding, authorization and TOCTOU regressions.
4. Complete manual OS/network checks separately; record external blockers without suppressing CI-based development.
5. Update both parity plan and this matrix once a gate genuinely passes.

## Review checklist for each PR

- [ ] Only 1C/1D scope changed
- [ ] Real tests added or identified with exact paths
- [ ] Negative security cases exercised
- [ ] Current head CI green (17/17 when applicable)
- [ ] No production/server mutation without separate deployment authorization
- [ ] Status matrix reflects evidence, not implementation claims

## Verified evidence update — 2026-10-24

The 17-job GitHub Actions run [#40131910457](https://github.com/orhanbal/webrising-commender/actions/runs/40131910457) passed on commit `a249abb19d3059ff2321dc7a360385bea9aa0caa`. The matrix distinguishes CI-passed sub-gates from full 1C/1D release acceptance; no physical Windows, macOS, Ubuntu or network interruption test is inferred. `read_multiple` uses a per-file 64 KiB cap, not an aggregate 64 KiB budget; the 256 KiB aggregate budget is now enforced and verified by real Rust Agent E2E on `3085efe3` (CI #40132610665).


## 2026-10-25 — Hourly work group: four bounded verification tasks

1. **CI failure root cause isolated:** PR merge-preview CI #40138970984 failed at `agent-e2e` with `SyntaxError: Identifier 'binaryBatchPath' has already been declared`. The PR branch alone contained one declaration, but current `main` added another in the same scope. Commit `62a50ee0` renames the new fixture and adds a remaining-budget recovery E2E. This is **not** a successful CI verdict yet.
2. **Native byte-budget boundary:** `1317bdcc` adds Rust unit coverage for 256 KiB exact acceptance, post-budget rejection, and continued reading after an individual over-budget item. The 256 KiB implementation was already CI-proven on `3085efe3`.
3. **Concurrent distributed search quota:** `2d425ccb` adds nine simultaneous PostgreSQL reservations over two live Gateway persistence instances, requires exactly eight successes, checks a ninth denial and independent actor access.
4. **Stop/settle race:** the same integration test concurrently issues stop and owner/foreign settlement, verifies stopped-unsettled quota retention, a single freed slot and rejection of a tenth worker. Gateway process restart fault injection is still pending.
5. **Evidence discipline:** the 1D-01 full criterion remains PARTIAL because individual failures are explicit but there is no separate `truncated` flag. Physical OS/network/ChatGPT tests remain BLOCKED_EXTERNAL. All new test commits require a current-head merge-preview CI pass before marking their gates PASSED.

These changes remain scoped to PR #25. No production, device or release operation was performed.

## Verified CI update — 2026-10-25

Code commit `12a5addd2eb4257d385984c049a6d9c760f7a4b5` passed [CI #40143597740](https://github.com/orhanbal/webrising-commender/actions/runs/40143597740) on retry attempt 2: 17/17 jobs passed, with all four acceptance artifacts present and unexpired. The first attempt's macOS acceptance job failed because the runner could not resolve `static.crates.io`; rerunning only that job succeeded. Real native Agent E2E and PostgreSQL integration succeeded on the first attempt. No claim is made that real two-process Gateway restart, ancestor directory TOCTOU, or physical OS reconnect tests passed. This documentation update itself creates a newer SHA whose CI must be checked separately.
