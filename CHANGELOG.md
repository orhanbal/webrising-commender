# Changelog

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
