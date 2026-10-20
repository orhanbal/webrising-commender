# Operations

## Health

- `GET /health/live`: process liveness only.
- `GET /health`: PostgreSQL readiness.

## Backup

The gateway keeps durable state in PostgreSQL. Back up the database volume or use `pg_dump`.

```bash
docker compose exec -T postgres pg_dump -U commender -d commender > commender-backup.sql
```

Device tokens are not recoverable from database hashes. Existing agents continue to authenticate after restore only if their device rows are preserved.

## Secret rotation

### Control API key
Change `CONTROL_API_KEY` and restart the gateway. Existing native agents are unaffected.

### Approval signing secret
Changing `APPROVAL_SIGNING_SECRET` invalidates outstanding approval tokens. Device connectivity is unaffected.

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
