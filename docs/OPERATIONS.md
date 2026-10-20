# Operations

## Health

- `GET /health/live`: process liveness only.
- `GET /health`: PostgreSQL readiness.

## Backup and recovery

Use the first-party archive and checksum scripts. They require only Docker Compose, PostgreSQL tools inside the existing container, Bash and sha256sum.

```bash
bash scripts/backup-postgres.sh
bash scripts/verify-backup.sh backups/commender-YYYYMMDDTHHMMSSZ.dump
```

Backups are private custom-format archives with SHA-256 sidecars. Store them off-host on access-controlled, encrypted storage; the scripts do not encrypt the files or provide a retention policy. Verify checksums before any recovery, and perform a test restore into a separate empty database before changing the production connection. Never overwrite the only live database as a first recovery step.

Database backups preserve hashed device credentials and enrolled device rows, but not the external APPROVAL_SIGNING_SECRET. Keep that secret separately; changing it requires agent re-enrollment for high-risk approvals. Production restore/cutover remains an external acceptance gate.

## Secret rotation

### Control API key
Change `CONTROL_API_KEY` and restart the gateway. Existing native agents are unaffected.

### Approval signing secret
Changing `APPROVAL_SIGNING_SECRET` invalidates outstanding approval tokens **and changes the per-device approval verifier derived at enrollment**. Device WebSocket connectivity remains valid, but existing agents will reject new HIGH-risk approvals until they are re-enrolled with the new verifier.

Treat signing-secret rotation as a coordinated security event:
1. rotate the gateway secret,
2. revoke stale pending approvals,
3. re-enroll controlled devices,
4. verify a HIGH-risk denial + approved operation on each device.

### Device credential
Revoke the device row and re-enroll the device. Do not attempt to reconstruct the old token.

## Logs

The gateway writes operational messages to stdout/stderr for container collection. Do not enable HTTP body logging around this service unless that logging layer performs equivalent secret redaction.

## Reverse proxy

Production deployments should terminate TLS before the gateway and forward WebSocket upgrades for `/agent`.

Required public routes:
- `/mcp`
- `/agent`
- `/api/agent/enroll`
- management API routes used by the console
- health routes

Use WSS/HTTPS outside trusted local development.

## Upgrade order

1. Back up PostgreSQL.
2. Deploy the new gateway.
3. Verify `/health`.
4. Upgrade native agents gradually.
5. Verify device reconnect and a low-risk MCP call.
6. Verify a high-risk denial + approved call.

Breaking protocol changes require a compatibility window.


## Native agent service identity

Run the native agent with the least privilege needed for its configured roots. Elevated service identities expand the blast radius of command execution and filesystem access.

### Windows

The installer refuses an implicit LocalSystem installation. Recommended:

```powershell
$cred = Get-Credential
.\scripts\install-windows.ps1 `
  -BinaryPath .\webrising-commender.exe `
  -ConfigPath "$env:APPDATA\webrising-commender\agent.json" `
  -Credential $cred
```

LocalSystem is available only as an explicit opt-in:

```powershell
.\scripts\install-windows.ps1 -BinaryPath .\webrising-commender.exe -ConfigPath C:\secure\agent.json -AllowLocalSystem
```

Use LocalSystem only when the controlled roots genuinely require machine-level privilege.

### Linux

When invoked through `sudo`, the installer uses `SUDO_USER`. Otherwise pass the service account explicitly:

```bash
sudo ./scripts/install-linux.sh ./webrising-commender ~/.config/webrising-commender/agent.json myuser
```

Running as root requires an explicit acknowledgement:

```bash
sudo COMMANDER_ALLOW_ROOT=1 ./scripts/install-linux.sh ./webrising-commender /root/.config/webrising-commender/agent.json root
```

### macOS

The provided installer creates a per-user LaunchAgent, so it naturally runs with that user's permissions.


## Resource ceilings

The native agent and gateway apply bounded-resource defaults:

- filesystem read: 4 MiB hard maximum
- filesystem write: 8 MiB decoded hard maximum
- one-shot command output: 1 MiB per stdout/stderr stream
- one-shot command timeout: 10 minutes maximum
- persistent background task timeout: 24 hours maximum
- concurrent persistent tasks: 16 per agent
- concurrent PTY sessions: 32 per agent
- PTY retained output: 1 MiB per session
- gateway in-flight requests: 1024 total and 64 per device

Reverse proxies should keep their own request-size, connection and rate limits enabled. Do not raise these ceilings casually; they are part of the denial-of-service boundary.
