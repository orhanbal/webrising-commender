# Phase status

Updated: 2026-10-20

| Phase | Status | Notes |
|---|---|---|
| 0 Foundation | DONE | canonical plan, architecture, protocol, CI, security model |
| 1 Core relay | DONE | PostgreSQL, pairing, hashed device credentials, WSS relay, presence |
| 2 Remote operations | DONE (MVP) | filesystem, recursive tree/search, surgical text edit, move/rename, process, system info, persistent PTY/tasks with reconnect discovery |
| 3 MCP | DONE (MVP) | initialize, tools/list, tools/call, routing, structured tool errors |
| 4 Console | DONE (MVP) | device management, filesystem, command/task/terminal controls, approvals, audit |
| 5 Hardening | IMPLEMENTED — ACCEPTANCE PENDING | exact-operation approvals, native verification, RBAC, allowlisted roots, payload/resource caps, redaction, rate limits, replay/tamper rejection |
| 6 Distribution | IMPLEMENTED — ACCEPTANCE PENDING | Docker Compose, native Windows SCM host, Windows/Linux/macOS installers, tagged multi-platform release pipeline |
| 7 SaaS | BILLING CORE + ENTITLEMENTS IMPLEMENTED | onboarding/access plus provider-neutral plans, subscriptions, usage snapshots, transactional device/member/token quotas and idempotent normalized billing events are implemented; provider checkout/webhook adapters, verified public signup and regional relay orchestration remain |

## Automated acceptance already covered

CI exercises:

- Rust format/clippy/tests
- Linux, Windows and macOS compilation
- TypeScript typecheck/tests/build
- clean Docker Compose boot + health + console
- gateway integration flow
- real native Linux agent enrollment and reconnect
- filesystem read/write/delete
- process execution
- PTY start/input/read/stop
- persistent task execution across gateway disconnect/reconnect
- HIGH-risk denial, parameter tamper rejection and single-use approval
- human-in-the-loop MCP approval queue
- organization isolation and token RBAC boundaries
- browser user login/logout, HttpOnly session persistence and CSRF rejection
- invitation preview/accept/replay rejection, workspace creation/switching, role updates/removal and last-owner protection
- SaaS plan/subscription provisioning, billing-required gating, device/member/token quota enforcement, pending-seat reservation, normalized-event idempotency/conflict rejection
- self-hosted unlimited resource allocation remains covered by Compose/real-agent flows while integration runs in SaaS mode
- installer syntax
- native Windows service install/start/stop/remove lifecycle

## External acceptance still required

These require a real deployed gateway and real user-controlled machines rather than CI runners:

- production reverse proxy/TLS deployment
- real Windows machine enrollment and day-to-day service behavior
- real Linux systemd installation
- real macOS LaunchAgent installation
- reconnect after a real gateway/container restart
- long-running terminal/task soak test over an actual network interruption
- MCP connection from the intended ChatGPT/AI client
- production-domain and operational backup/restore acceptance

Phase 5/6 are not marked production-accepted until these external gates pass.
