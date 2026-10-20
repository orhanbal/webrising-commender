# Operations

## Health

- `GET /health/live`: process liveness only.
- `GET /health`: PostgreSQL readiness.

## Backup and restore

Durable control-plane state lives in PostgreSQL. The repository includes a verified Compose backup path:

```bash
bash scripts/backup-compose.sh ./backups
```

The script:

- runs `pg_dump --format=custom` inside the existing PostgreSQL container;
- writes with `umask 077`;
- rejects empty output;
- validates the archive with `pg_restore --list` before publishing it;
- writes a SHA-256 sidecar and manifest;
- optionally prunes old archives with `BACKUP_RETENTION_DAYS` (default 14).

Restore is deliberately destructive and requires an explicit acknowledgement:

```bash
COMMANDER_RESTORE_CONFIRM=RESTORE \
  bash scripts/restore-compose.sh ./backups/commender-YYYYMMDDTHHMMSSZ.dump
```

Restore validates the checksum/archive **before** stopping the gateway. It then stops the gateway, terminates DB sessions, recreates the database, restores with `--exit-on-error`, and starts the gateway only after a successful restore. If restore fails, the gateway intentionally remains stopped so a partial database is not served.

CI exercises a real round trip on a clean Compose stack: create marker data → backup → delete marker → destructive restore → verify marker through the API.

Important boundaries:

- Database backups contain hashed device credentials and encrypted mail-outbox rows, so protect the archive as sensitive operational data.
- `MAIL_OUTBOX_KEY`, `CONTROL_API_KEY`, `APPROVAL_SIGNING_SECRET`, SMTP credentials and the agent-side raw device tokens are not recoverable from database hashes/ciphertext alone. Back up runtime secrets separately.
- Existing agents continue to authenticate after restore only if their device rows and the corresponding agent-side raw credentials are preserved.
- Do not commit backup archives. The repository ignores `/backups/`.

## Gateway reconnect / task soak

For a real enrolled device, use the first-party soak runner:

```bash
CONTROL_API_KEY=... \
DEVICE_ID=<device-uuid> \
SOAK_ITERATIONS=20 \
node scripts/soak-restart.mjs
```

Default mode runs `docker compose restart gateway` each iteration, waits for gateway health, waits for the same device to return online, and performs a low-risk `system_info` request.

To verify a persistent task across all restarts:

```bash
SOAK_TASK_COMMAND='sleep 1800' \
CONTROL_API_KEY=... DEVICE_ID=... \
node scripts/soak-restart.mjs
```

The runner obtains exact-operation approvals for task start/cancel and checks `task_status` after every gateway restart.

For a real network interruption instead of a Compose restart:

```bash
SOAK_RESTART_MODE=manual CONTROL_API_KEY=... DEVICE_ID=... \
node scripts/soak-restart.mjs
```

Manual mode waits until the device/gateway interruption is observed, then waits for recovery. It does not manipulate host networking itself.

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
