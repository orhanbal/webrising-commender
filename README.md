# WECOMMANDER

Secure, persistent remote computer control for AI clients through MCP.

WECOMMANDER is a self-hostable control plane plus native device agent. It is designed for AI clients that need reliable terminal, filesystem, process and long-running task access without exposing an inbound port on the controlled machine.

> Pre-release software. The core is implemented and continuously tested, but production acceptance still requires a real deployment and device enrollment.

## Why it exists

Typical remote MCP agents are useful while their relay and local process stay connected, but operational work often needs more:

- automatic reconnect after network or gateway interruptions
- persistent PTY sessions
- background tasks that keep running across AI/gateway disconnects
- multiple devices behind one control plane
- explicit approval for high-risk operations
- filesystem allowlists enforced by the native agent
- audit records with secret redaction
- self-hosting with no paid service dependency
- a path to SaaS without removing the self-hosted edition

## Architecture

```text
ChatGPT / Claude / Cursor / custom MCP client
                       |
                    HTTPS MCP
                       |
                       v
          WECOMMANDER Gateway
       MCP · REST · approvals · audit
                       |
                  PostgreSQL
                       |
                 outbound WSS
                       |
                       v
             Native Rust Agent
        files · processes · PTY · tasks
```

The agent initiates the connection. Controlled devices do not need an inbound firewall rule or port-forward.

## Implemented

### Native agent
- Rust single binary
- Windows, Linux and macOS builds
- one-time pairing/enrollment
- durable device credential
- automatic reconnect with capped backoff
- heartbeat and device presence
- agent-side allowlisted filesystem roots
- filesystem list/stat/read/write/mkdir/delete/move
- bounded recursive directory tree
- recursive filename search
- bounded literal text/code search
- guarded surgical text replacement
- process list/execute/kill
- persistent PTY sessions with session discovery after reconnect
- persistent background command tasks with task discovery after reconnect
- system information
- request cancellation
- output/payload limits

### Gateway
- TypeScript / Node.js
- PostgreSQL persistence
- hashed device credentials and pairing codes
- authenticated WebSocket relay
- optional first-party native HTTPS/WSS termination from certificate/key files
- MCP JSON-RPC endpoint
- tenant-scoped API tokens with viewer/operator/admin/owner RBAC
- verified browser signup and password reset through a first-party SMTP/STARTTLS client
- AES-256-GCM encrypted persistent mail outbox with retry/dead-letter handling
- first-party regional relay routing with preferred-region placement, signed inter-node RPC and automatic agent failover
- one-time exact-operation approval tokens
- human-in-the-loop approval queue for AI/MCP HIGH-risk actions
- native device-side verification of signed HIGH-risk approvals
- device rename/disconnect/revoke
- audit log + secret redaction
- enrollment/pairing rate limits
- bounded in-flight request concurrency and retention housekeeping
- liveness/readiness endpoints

### Self-hosted console
- device enrollment code generation
- online/offline device view
- system information
- filesystem browser + text editing
- AI/MCP tree, filename search, code/text search, move/rename and guarded replace tools
- approved command execution
- persistent background task control
- persistent terminal UI
- human approval review/approve/deny queue
- audit log
- browser signup/email verification/password reset UX when enabled
- device rename/reconnect/revoke

### Operations
- Docker Compose
- release Dockerfile
- native Windows SCM service mode + installer/uninstaller
- Linux systemd installer/uninstaller
- macOS LaunchAgent installer/uninstaller
- GitHub Actions for Rust, TypeScript, clean Compose boot, real-agent E2E and Windows service lifecycle
- tagged release workflow with Linux x64, Windows x64, universal macOS binaries and SHA-256 checksums
- verified PostgreSQL Compose backup/restore scripts with checksum/manifest and CI round-trip acceptance
- first-party gateway restart/network-interruption soak runner for enrolled devices and persistent tasks
- native HTTPS/WSS transport with TLS 1.2+ and CI handshake acceptance

## Risk model

| Risk | Examples | Default rule |
|---|---|---|
| Low | system info, file read/list, process list, task/terminal read | authenticated device routing |
| Medium | file write/mkdir, terminal input/resize | allowed only inside agent roots |
| High | command execution, process kill, delete, task start/cancel, PTY start/stop | short-lived one-time approval bound to the exact parameters |

The native filesystem policy is the final path boundary. Gateway requests cannot use normal file tools to escape configured roots.

## Quick start

See [docs/QUICKSTART.md](docs/QUICKSTART.md).

Minimal self-hosted flow:

```bash
cp .env.example .env
# set CONTROL_API_KEY and APPROVAL_SIGNING_SECRET
docker compose up -d --build
```

Then open the gateway console, create a pairing code, build/download the agent and enroll the device.

## MCP

Self-hosted endpoint:

```text
POST https://YOUR-GATEWAY/mcp
Authorization: Bearer CONTROL_API_KEY
```

Core methods:
- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`

The MCP tool surface includes device discovery, filesystem, process, persistent task and terminal operations.

## Persistent work

For short commands use `process_exec`.

For work that must survive an AI or gateway connection interruption, use:

1. `task_start`
2. disconnect/reconnect as needed
3. `task_status`
4. `task_cancel` when required

Task state lives in the native agent process. PTY sessions follow the same principle.

## Security notes

- device secrets are stored server-side only as SHA-256 verifiers
- pairing codes are one-time and expire
- approval tokens are per-device HMAC-signed, short-lived, exact-operation bound and consumed once
- HIGH-risk MCP calls can enter a human approval queue instead of silently executing
- the native agent independently verifies approved device/action/parameters/expiry before execution
- agent configuration is written with user-only permissions on Unix
- logs intentionally avoid credentials and redact common secret forms
- install scripts are explicit; no silent persistence installation
- uninstall scripts are provided

Read [docs/SECURITY.md](docs/SECURITY.md) before exposing a gateway publicly.

## Project status

The canonical roadmap is [plans/WEBRISING_COMMENDER_MASTER_PLAN.md](plans/WEBRISING_COMMENDER_MASTER_PLAN.md).

Current phase tracking is in [plans/PHASE_STATUS.md](plans/PHASE_STATUS.md).

The product is being built in two compatible modes:

- **Community / self-hosted** — free core control plane and agent
- **Cloud / SaaS** — multi-user organizations, managed relay and commercial administration layers

Core remote-control capabilities remain available to self-hosted users.

## License

MIT.
