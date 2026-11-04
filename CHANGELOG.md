# Changelog

## Unreleased

- Per-device trust level (Strict / Standard / Full): owner-chosen in the console (admin browser session; Full needs the password, can be time-limited, e-mails all admins/owners, audited as `trusted_full`). Strict ignores the command allowlist; Full runs HIGH-risk operations without per-call approval while device-local capabilities still apply.
- Domain: defaults move to `https://wecommander.app` (old domain keeps serving during the transition); new agent command `set-control-url` moves an enrolled device to a new gateway origin without re-enrolling. See `docs/DOMAIN_MIGRATION.md`.
- CI: macOS checks moved from `ci` to a separate `macos` workflow; the production release gate now requires the 14 Linux/Windows `ci` jobs, so GitHub macOS runner capacity cannot block a Linux release. The macOS PKG is published separately (`macos-preview-*`) by `macos-distribution` only after `macos` passes.
- Command allowlist: owner/admin-managed per-device list of routine `process_exec` commands that run without per-call approval (token-prefix match, shell metacharacters always refused, interpreters/privilege/destructive tools never allowed, browser-session-only management, audited). New approval requests e-mail admins/owners with a link to the Approvals view. See `docs/SECURITY.md`.
- Production release boundary (Issue #30): `production` branch moved only by the owner-approved `promote-production` workflow through a dedicated release GitHub App; exact-SHA 17-job CI/distribution gate, annotated `production-release/*` ledger, unauthorized-update detection (`production-guard`), one-time `mode=bootstrap` in the same workflow, newest-run-only CI/distribution evaluation, `/health` `build.commit` verified after each release, read-only `bootstrap-locks`. See `docs/RELEASE_POLICY.md`.
- MCP Streamable HTTP: event-stream `GET /mcp` and `DELETE /mcp` now return 405 (`Allow: POST`) instead of the dashboard page or 404. Added `gateway/test/mcp-client-acceptance.mjs` (OAuth operator AI client, admin approver, real Rust Agent, tenant isolation, audit) to CI; see `docs/MCP_CLIENT_ACCEPTANCE.md`.
- Added a dependency-free external production acceptance probe and an isolated Coolify Compose deployment model.
- Hardened PUBLIC_BASE_URL validation, relay RPC redirect behavior, SMTP plaintext transport defaults and query-limit parsing.
- Backup/restore and restart-soak tooling can now target an explicit production Compose file/project.
- Added optional native HTTPS/WSS gateway termination using operator-supplied certificate/key files with TLS 1.2+ enforcement.
- Added CA-verified HTTPS health + WSS upgrade CI acceptance and fail-closed TLS configuration checks.
- Added first-party regional relay registry, preferred-region placement, capacity-aware transactional assignment and relay health/drain controls.
- Added HMAC-authenticated control-to-relay RPC and DeviceRouter routing for REST/MCP operations.
- Added native agent route refresh so disconnected agents can fail over to another healthy region without re-enrollment.
- Added real-agent two-relay CI acceptance covering preferred-region placement, unsigned internal-RPC rejection, drain and cross-region failover.
- Added verified PostgreSQL Compose backup/restore tooling with custom-format archive validation, SHA-256 sidecars, retention and fail-closed restore behavior.
- Added a dependency-free gateway restart/manual-network soak runner that verifies device reconnect, low-risk requests and optional persistent-task rediscovery.
- Added CI backup → mutation → destructive restore → API verification acceptance.
- Added SaaS-only verified public signup with pending activation and password-confirmed email verification.
- Added password-reset request/confirm flows with one-time hash-only tokens and full browser-session revocation.
- Added a dependency-free SMTP/STARTTLS client and AES-256-GCM encrypted persistent mail outbox with bounded retries/dead-letter handling.
- Added safe mail-outbox operational status/retry APIs and console signup/reset/verification UX.
- Added organization-scoped browser users and memberships.
- Added scrypt password verification, hashed HttpOnly browser sessions, CSRF protection and login throttling.
- Added browser login/logout to the web console while preserving API-token and self-hosted control-key access.
- Added browser-auth integration acceptance including CSRF denial and session revocation.
- Added workspace creation, switching and owner-only rename controls.
- Added expiring, revocable, hash-only invitation tokens with new/existing-user acceptance flows.
- Added member role updates/removal with serialized last-owner protection and scoped session revocation.
- Added web-console management for members, invitations and tenant API tokens.
- Device presence now becomes online only after the current agent socket completes its hello handshake, eliminating first-command readiness races.
- Added self-hosted vs SaaS deployment modes with self-hosted unlimited core allocations.
- Added provider-neutral billing plans, organization subscriptions, usage snapshots and Access-console plan visibility.
- Added transaction-serialized quotas for device enrollment, member seats/pending invitations and tenant API tokens.
- Added idempotent normalized billing events with payload-collision rejection and provider-bound subscription state.
- Added provider event occurrence ordering, stale-event suppression, wrong-provider rejection, same-time order-conflict detection and provider subscription identity collision protection.
- Restricted provider/customer/subscription identity binding to the normalized verified-event path; manual plan assignments remain provider-neutral.
- Added SaaS CI coverage for billing-required, quota-exceeded and past-due allocation gates.

## 0.1.0 - Unreleased

- Native Rust agent with outbound WebSocket reconnect loop.
- One-time device enrollment with hashed credentials.
- PostgreSQL control plane and organization-scoped tenancy foundation.
- Viewer/operator/admin/owner API-token RBAC.
- Device presence and heartbeat.
- Allowed-root filesystem list/stat/read/write/mkdir/delete/move.
- Bounded recursive tree and filename search.
- Bounded literal text/code search and guarded surgical replacement.
- Task and PTY session discovery after AI reconnect.
- Bounded filesystem reads and payload limits.
- Process execute/list/kill with streamed capped output.
- Persistent PTY sessions with bounded retained output.
- Persistent background tasks across AI/gateway reconnects, up to 24-hour task timeout.
- MCP JSON-RPC endpoint.
- Human-in-the-loop MCP approval request queue.
- HIGH-risk approvals bound to the exact device and operation parameters.
- Independent native-agent approval signature verification.
- Single-use approval consumption and replay/tamper rejection.
- Audit log redaction and retention housekeeping.
- Self-hosted device/terminal/filesystem/task/approval/audit console.
- Docker Compose deployment with hardened gateway container settings.
- Native Windows SCM service host plus install/remove scripts.
- Linux systemd and macOS LaunchAgent install/remove scripts.
- CI for Rust, TypeScript, Compose boot, real-agent E2E, RBAC/approval integration and Windows service lifecycle.
- Release workflow for Linux x64, Windows x64 and universal macOS binaries with SHA-256 checksums.
