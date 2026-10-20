# Phase status

Updated: 2026-10-20

| Phase | Status | Notes |
|---|---|---|
| 0 Foundation | DONE | Canonical plan, architecture, protocol, CI, security model |
| 1 Core relay | DONE | PostgreSQL, pairing, hashed device credentials, WSS relay, presence |
| 2 Remote operations | DONE (MVP) | filesystem, process, system info, persistent in-process PTY |
| 3 MCP | DONE (MVP) | initialize, tools/list, tools/call, routing, structured tool errors |
| 4 Console | DONE (MVP) | health, API-key session, pairing, device presence |
| 5 Hardening | IN PROGRESS | approval signatures, allowlisted roots, payload caps, redaction implemented; E2E acceptance pending |
| 6 Distribution | IN PROGRESS | installers + release pipeline; native acceptance pending |
| 7 SaaS | PLANNED | organization auth/RBAC/billing/regional relays after self-hosted MVP acceptance |

## Remaining acceptance gates

These require a real gateway deployment and at least one real Windows/Linux/macOS machine:

- clean Docker Compose boot
- real enrollment
- automatic reconnect after gateway restart
- filesystem E2E
- process E2E
- PTY E2E
- approval denial/acceptance E2E
- Windows service acceptance
- Linux systemd acceptance
- macOS launchd acceptance

No phase is production-ready until these external acceptance tests pass.
