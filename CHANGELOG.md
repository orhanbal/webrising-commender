# Changelog

## Unreleased

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
