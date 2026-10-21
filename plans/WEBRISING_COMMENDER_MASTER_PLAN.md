# WECOMMANDER — Master Plan

Canonical product and implementation plan.

## 1. Product definition

WECOMMANDER is a secure, persistent remote-computer control platform designed for AI clients. It combines a native local agent with a self-hostable control plane and an MCP endpoint.

The product must work in two modes without architectural forks:

1. **Self-hosted / Community** — the user runs the gateway and PostgreSQL.
2. **Cloud / SaaS** — WebRising operates the control plane, relay and tenancy layer.

The local agent always initiates outbound connections. No inbound port is required on the controlled device.

## 2. Non-negotiable principles

- Local machine access is explicit and policy-bound.
- The agent survives AI-client disconnects and reconnects automatically.
- Long-lived terminal sessions remain alive while the agent process remains alive.
- Every mutating or command-execution operation is auditable.
- Secrets are never stored in plaintext server-side when a one-way verifier is sufficient.
- File access is limited to configured roots.
- Dangerous actions require an approval token unless the local policy explicitly allows them.
- No paid infrastructure dependency is required for the self-hosted edition.
- Self-hosted users are not intentionally feature-locked out of core remote-control capabilities.
- Cloud multi-tenancy is designed in from the schema boundary, even if the first release is single-tenant.

## 3. MVP acceptance criteria

### Native agent
- Rust single binary.
- Windows, Linux and macOS compatible architecture.
- Outbound WebSocket connection to the gateway.
- Automatic reconnect with capped exponential backoff.
- Device enrollment and durable device credentials.
- Heartbeat.
- System information.
- Allowed-root filesystem: list, stat, read, write, mkdir, delete.
- Process: execute with timeout, list, kill.
- Persistent PTY: start, input, read buffered output, resize, stop.
- Persistent background tasks that survive AI/gateway reconnects while the agent process remains alive.
- Local risk classification.
- Native verification of per-device, one-time approval claims bound to the exact HIGH-risk operation payload.
- Output size caps.

### Gateway/control plane
- Node.js/TypeScript service.
- PostgreSQL persistence.
- One-time device pairing codes.
- Hashed device credentials.
- WebSocket agent relay.
- Online/offline device registry.
- Request routing with timeout.
- REST management API.
- MCP Streamable-HTTP-compatible JSON-RPC endpoint for core tools.
- Audit logging.
- Secret redaction.
- Health/readiness endpoints.
- Minimal web console for pairing and device visibility.

### Operations
- Dockerfile.
- docker-compose.yml with PostgreSQL.
- .env.example.
- Database migrations/bootstrap.
- CI: Rust fmt/check/test + Node typecheck/test/build.
- Windows install/remove service scripts.
- Linux systemd install/remove scripts.
- No silent persistence installation.
- Verified backup/restore tooling for the supported Compose deployment.
- A repeatable restart/network soak runner for real-device acceptance.
- Optional native HTTPS/WSS termination using operator-supplied certificate/key files.

## 4. Security model

Risk levels:

- **LOW**: list devices, system info, file read/list/stat, process list, task status, terminal read.
- **MEDIUM**: file write/mkdir, terminal input/resize.
- **HIGH**: delete, process execution, process kill, task start/cancel, terminal start/stop.

Default policy:
- LOW allowed after authenticated device routing.
- MEDIUM allowed only within configured roots.
- HIGH requires an approval token issued by the gateway control plane.
- Shell execution is never hidden or obfuscated.
- Agent refuses paths outside allowlisted roots even if the gateway requests them.

Approval tokens are short-lived, one-time HMAC-signed claims containing device id, action family, the exact operation payload, nonce and expiry. The gateway derives a separate approval key per device; the agent verifies the claim independently before HIGH-risk execution.

## 5. SaaS-ready domain model

- organizations
- users
- organization_members
- invitations
- devices
- relay_nodes
- device_credentials
- pairing_codes
- sessions
- tasks
- approvals
- policies
- billing_plans
- organization_subscriptions
- billing_events
- audit_logs

The first implementation uses a default organization to remain simple for self-hosting. Tables and APIs carry organization_id where it materially affects future tenancy.

## 6. Delivery phases

### Phase 0 — Foundation
Repository, canonical plan, protocol, CI, security rules.

### Phase 1 — Core relay
Gateway + PostgreSQL + enrollment + agent WSS + device presence.

### Phase 2 — Remote operations
Filesystem, processes, system info, PTY, request timeout/cancellation boundaries.

### Phase 3 — MCP
MCP initialize/tools/list/tools/call with device routing and structured errors.

### Phase 4 — Console
Device list, pairing, online/offline, audit visibility.

### Phase 5 — Hardening
Approval tokens, allowlists, redaction, payload caps, rate limits, reconnect tests.

### Phase 6 — Distribution
Windows service, systemd, Docker images, release artifacts.

### Phase 7 — SaaS
Real user auth, organizations, RBAC, plans/billing, regional relays. This phase must not weaken self-hosted mode.

Current milestone: organization-scoped browser users, hardened sessions, email-verified public signup/password reset through the built-in SMTP/outbox layer, workspace onboarding/access, provider-neutral billing plans/subscriptions, transactional resource entitlements, idempotent normalized billing events, provider identity binding/stale-event protection, first-party regional relay orchestration with agent route refresh/failover, and native HTTPS/WSS termination are implemented. Third-party checkout/webhook adapters are not a required runtime component and are intentionally excluded while the no-third-party rule is active.

## 7. Definition of done

A release is accepted only when:
- CI is green on main.
- A clean gateway + PostgreSQL deployment starts from documented commands.
- A fresh agent can enroll with a one-time pairing code.
- The agent reconnects after gateway restart without manual intervention.
- MCP can list the device and perform allowed file/process/terminal operations.
- A HIGH operation without approval is rejected.
- The same HIGH operation with a valid approval succeeds.
- Audit records show actor/tool/device/outcome without leaking secrets.
- An uninstall path exists for every persistence mechanism we install.
