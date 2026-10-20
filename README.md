# WebRising Commender

Secure, persistent remote computer control for AI clients through MCP.

WebRising Commender is a self-hostable control plane plus native device agent. It is designed for AI clients that need reliable terminal, filesystem, process and long-running task access without exposing an inbound port on the controlled machine.

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
          WebRising Commender Gateway
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
- filesystem list/stat/read/write/mkdir/delete
- process list/execute/kill
- persistent PTY sessions
- persistent background command tasks
- system information
- request cancellation
- output/payload limits

### Gateway
- TypeScript / Node.js
- PostgreSQL persistence
- hashed device credentials and pairing codes
- authenticated WebSocket relay
- MCP JSON-RPC endpoint
- one-time high-risk approval tokens
- device rename/disconnect/revoke
- audit log + secret redaction
- enrollment/pairing rate limits
- liveness/readiness endpoints

### Self-hosted console
- device enrollment code generation
- online/offline device view
- system information
- filesystem browser + text editing
- approved command execution
- persistent background task control
- persistent terminal UI
- audit log
- device rename/reconnect/revoke

### Operations
- Docker Compose
- release Dockerfile
- Windows Service installer/uninstaller
- Linux systemd installer/uninstaller
- macOS LaunchAgent installer/uninstaller
- GitHub Actions for Rust, TypeScript, multi-platform compile and integration/E2E acceptance
- tagged release workflow for native binaries

## Risk model

| Risk | Examples | Default rule |
|---|---|---|
| Low | system info, file read/list, process list, task/terminal read | authenticated device routing |
| Medium | file write/mkdir, terminal input/resize | allowed only inside agent roots |
| High | command execution, process kill, delete, task start/cancel, PTY start/stop | short-lived one-time approval required |

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
- approval tokens are HMAC-signed, short-lived and consumed once
- high-risk actions without valid approval are rejected
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
