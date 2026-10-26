# WECOMMANDER — Hourly 1A–10D acceptance queue

Last reviewed: 2026-10-26 (Windows junction acceptance). **PENDING is not a claim that the feature is absent**; it means all required schema + Gateway/TypeScript + Rust Agent + authorization + real E2E + negative + applicable OS gates have not been evidenced. Prior accepted slices must not be repeated. No paid/limited runtime, production deployment, other repository, Desktop Commander, or Remote Desktop Commander.

Latest code HEAD: [`42257b69`](https://github.com/orhanbal/webrising-commender/commit/42257b69cfc4880c68fd8e013b922c99e9614a3e). [CI #40345656336](https://github.com/orhanbal/webrising-commender/actions/runs/40345656336): Rust 93/93 PASSED, Windows native junction negatives 2/2 PASSED, Agent MCP E2E PASSED; full CI and 4/4 artifacts must be verified on final HEAD.

| Item | Scope | Overall acceptance |
|---|---|---|
| 1A | Native streaming search, pause/cancel, parallel sessions | PENDING (full acceptance not yet established; partial implementations may exist) |
| 1B | Restart search checkpoint and principal isolation | PENDING (full acceptance not yet established; partial implementations may exist) |
| 1C | Search paging/case/quota/timeout/large negative E2E | PENDING (full acceptance not yet established; partial implementations may exist) |
| 1D | Batch file read, line/tail/paging/partial errors | PENDING (full acceptance not yet established; partial implementations may exist) |
| 2A | PTY/REPL prompt and paged output | PENDING (full acceptance not yet established; partial implementations may exist) |
| 2B | Durable terminal history and retention | PENDING (Windows junction native negative tests 2/2 PASSED; long soak, adversarial TOCTOU, physical OS open) |
| 2C | Process tree terminate/kill/cancel/cleanup | PENDING (full acceptance not yet established; partial implementations may exist) |
| 2D | Terminal/process/history quota and concurrency | PENDING (full acceptance not yet established; partial implementations may exist) |
| 3A | Atomic file edit with SHA CAS and filesystem race safety | PENDING (full acceptance not yet established; partial implementations may exist) |
| 3B | Rollback, snapshot crash resilience and recovery | PENDING (SIGKILL test PASSED; full crash/rollback gates open) |
| 3C | Config policy, shell allowlist, audit | PENDING (full acceptance not yet established; partial implementations may exist) |
| 3D | Tool history/usage/log secure paging | PENDING (full acceptance not yet established; partial implementations may exist) |
| 4A | XLSX/XLSM read workbook/sheet/range/search | PENDING (full acceptance not yet established; partial implementations may exist) |
| 4B | XLSX/XLSM write formula/style/OOXML roundtrip | PENDING (full acceptance not yet established; partial implementations may exist) |
| 4C | CSV/JSON/Markdown/source bidirectional tools | PENDING (full acceptance not yet established; partial implementations may exist) |
| 4D | Document scale and concurrent performance | PENDING (full acceptance not yet established; partial implementations may exist) |
| 5A | DOCX paragraphs/tables/editing with formatting | PENDING (full acceptance not yet established; partial implementations may exist) |
| 5B | DOCX atomic save and corruption negatives | PENDING (full acceptance not yet established; partial implementations may exist) |
| 5C | PDF text/page read | PENDING (full acceptance not yet established; partial implementations may exist) |
| 5D | PDF page add/remove/merge safety | PENDING (full acceptance not yet established; partial implementations may exist) |
| 6A | Image header/metadata PNG/JPEG/GIF/WebP | PENDING (full acceptance not yet established; partial implementations may exist) |
| 6B | Image preview bounds/negative fixtures | PENDING (full acceptance not yet established; partial implementations may exist) |
| 6C | Document MCP schema/Gateway/Agent E2E | PENDING (full acceptance not yet established; partial implementations may exist) |
| 6D | Document performance/regression | PENDING (full acceptance not yet established; partial implementations may exist) |
| 7A | MCP protocol/session/transport/errors | PENDING (full acceptance not yet established; partial implementations may exist) |
| 7B | Live ChatGPT/Claude client acceptance | BLOCKED_EXTERNAL (live/physical gates; internal work may remain PENDING) |
| 7C | UI pages/responsive/accessibility | PENDING (full acceptance not yet established; partial implementations may exist) |
| 7D | Browser interaction and error E2E | PENDING (full acceptance not yet established; partial implementations may exist) |
| 8A | Windows installer/service/upgrade/uninstall | PENDING (full acceptance not yet established; partial implementations may exist) |
| 8B | Ubuntu/Linux installer/systemd/upgrade/uninstall | PENDING (full acceptance not yet established; partial implementations may exist) |
| 8C | macOS installer/service/upgrade/uninstall | PENDING (full acceptance not yet established; partial implementations may exist) |
| 8D | Platform CI/artifacts/physical OS acceptance | PENDING (full acceptance not yet established; partial implementations may exist) |
| 9A | Auth/RBAC/pairing/approval/audit/limits | PENDING (full acceptance not yet established; partial implementations may exist) |
| 9B | Reconnect/relay failover/soak/backup | PENDING (full acceptance not yet established; partial implementations may exist) |
| 9C | 46+ MCP tool contract/negative/OS matrix | PENDING (full acceptance not yet established; partial implementations may exist) |
| 9D | Self-hosted clean install smoke | PENDING (full acceptance not yet established; partial implementations may exist) |
| 10A | 17+ CI jobs and artifacts per HEAD | PENDING (latest code HEAD 17/17 PASSED; ongoing per-HEAD acceptance) |
| 10B | Release/upgrade/uninstall compatibility docs | PENDING (full acceptance not yet established; partial implementations may exist) |
| 10C | Physical OS/clients/signing/notarization | BLOCKED_EXTERNAL (live/physical gates; internal work may remain PENDING) |
| 10D | Final canonical plans/matrix and SHA evidence | PENDING (full acceptance not yet established; partial implementations may exist) |

Next action: verify documentation HEAD CI first; if green, continue 2B soak/Windows reparse and 3A CAS/TOCTOU, then 3B legacy migration and 3C config/audit. Stop new feature work if any P0/security/CI red appears. Evidence for partial scopes is recorded in the four canonical plans. Never mark physical OS, signing, notarization or live ChatGPT/Claude PASSED without direct evidence.

## 2026-10-26 — Windows junction hardening (partial acceptance)

A: prior HEAD `d4928a77` CI #40337905593 17/17 PASSED, platform distribution #40339579101 SUCCESS. B: `157f2fcd` rejects Windows reparse/junction ancestors before directory creation, locking, reading, pruning. C: `6cae199f` tests junction-parent creation and post-initialization directory replacement; `42257b69` runs both tests in native Windows CI. D: CI #40345656336 Windows job `121651964221` 2/2 PASSED; Rust 93/93 PASSED, Agent MCP E2E PASSED. Full CI and artifacts must be checked after this documentation commit. Native CI runner is not physical Windows acceptance. Concurrent adversarial TOCTOU, soak and physical OS remain PENDING; external clients/signing/notarization BLOCKED_EXTERNAL. No production/other repo/paid runtime.
