# WECOMMANDER — 1C/1D acceptance evidence gates

Baseline: main `a27c311586586e0e7a43946bb79e5fccec18c5d8` (2026-10-24).\nVerified candidate: `a249abb19d3059ff2321dc7a360385bea9aa0caa`, CI #40131910457, **17/17 PASS** (including real Rust Agent E2E).
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
| 1C-04 | Eight concurrent searches for one actor across two Gateway instances succeed; ninth is denied; other actors/organizations remain isolated | PostgreSQL advisory actor lock and pool-backed E2E `f13b3f6b` / `cd339dda` | PENDING |
| 1C-05 | Stopped but unsettled native work still holds a quota slot; only native settlement releases it | PostgreSQL E2E `cd339dda` | PENDING |
| 1C-06 | Simultaneous stop/settle/restart does not double-release slots, duplicate results or leak scans across tenant/device | No current HEAD fault-injection evidence established | PENDING |
| 1C-07 | Sustained large-tree search under CPU/memory budgets with pause/resume and gateway interruption, on real Windows and Ubuntu agents | Requires authorized real devices | BLOCKED_EXTERNAL |

## 1D — Bounded multi-file reading and safe edits

| Gate | Acceptance criterion | Evidence so far | Status |
| --- | --- | --- | --- |
| 1D-01 | Multi-file read respects aggregate byte and per-file caps; partial results explicitly indicate truncation | `fs_read_multiple` enforces 10-file maximum and 64 KiB per-file (not aggregate) cap; E2E asserts over-limit failures. Aggregate response budget needs separate acceptance. | PARTIAL |
| 1D-02 | UTF-8 boundary, CRLF and binary files do not return invalid offsets or silently mutate contents | Current candidate `a249abb1` E2E checks Unicode/CRLF preservation, binary Base64 roundtrip, over-limit rejection. Offset handling remains unproven. | PARTIAL |
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

The 17-job GitHub Actions run [#40131910457](https://github.com/orhanbal/webrising-commender/actions/runs/40131910457) passed on commit `a249abb19d3059ff2321dc7a360385bea9aa0caa`. The matrix distinguishes CI-passed sub-gates from full 1C/1D release acceptance; no physical Windows, macOS, Ubuntu or network interruption test is inferred. `read_multiple` uses a per-file 64 KiB cap, not an aggregate 64 KiB budget; any aggregate-budget requirement must be addressed explicitly and must not be marked passed.
