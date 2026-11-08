# Production deployment acceptance

Target selected for the first real acceptance deployment:

- Coolify project: **WECOMMANDER**
- Server: **localhost** (reachable/usable)
- GitHub connection: **webrising-github**
- Repository: **orhanbal/webrising-commender**
- Branch: **main**
- Compose file: **docker-compose.coolify.yml**
- Recommended first acceptance domain: **wecommander.app**
- Runtime mode for first acceptance: **self_hosted** unless explicitly changed later.

## Why this layout

The current Coolify inventory does not contain a dedicated Commender database. The production Compose therefore runs the gateway together with its own PostgreSQL 16 instance and persistent volume. It does not depend on EXPHIRST or another product database.

Coolify terminates public HTTPS/WSS and forwards traffic to the gateway on port 8787. Native TLS remains available for non-Coolify deployments, but should stay disabled in this Coolify stack to avoid double TLS termination.

## One-time Coolify resource creation

The current Coolify MCP exposes deploy/control for **existing** resources but does not expose a create-application/service operation. Therefore this one resource must be created once in the Coolify UI.

Create a new **Docker Compose / Git repository** resource with:

- Project: WECOMMANDER
- Repository: orhanbal/webrising-commender
- Branch: main
- Compose file: docker-compose.coolify.yml
- Domain/FQDN for the gateway service: https://wecommander.app
- Internal gateway port: 8787

Do not expose PostgreSQL publicly.

## Required secrets

Generate URL-safe values. Hex avoids URL-encoding ambiguity in the PostgreSQL connection string.

```bash
openssl rand -hex 32   # POSTGRES_PASSWORD
openssl rand -hex 48   # CONTROL_API_KEY
openssl rand -hex 48   # APPROVAL_SIGNING_SECRET
```

Required environment variables:

```env
POSTGRES_PASSWORD=<hex secret>
CONTROL_API_KEY=<hex secret>
APPROVAL_SIGNING_SECRET=<hex secret>
PUBLIC_BASE_URL=https://wecommander.app
DEPLOYMENT_MODE=self_hosted
PUBLIC_SIGNUP_ENABLED=false
```

For the first acceptance deployment, leave regional relay and SMTP optional features disabled unless they are specifically being accepted in that run.

## External acceptance

After deployment is healthy:

```bash
COMMANDER_BASE_URL=https://wecommander.app \
CONTROL_API_KEY='<control key>' \
node scripts/accept-production.mjs
```

Expected checks:

- HTTPS health = PASS
- HSTS = PASS
- Web console = PASS
- public config = PASS
- MCP initialize/ping = PASS
- unauthenticated WSS upgrade rejection = PASS

The next acceptance gates add a real enrolled device, authenticated WSS, reconnect/soak, backup/restore, and ChatGPT MCP operation.

## Current tool limitation

The connected Coolify MCP can inspect repositories/resources and deploy existing resources, but it cannot create a new application/service resource. This is an external tooling blocker, not a product-code blocker. Once the resource exists, deployment, status inspection, logs and redeploy can be managed through the Coolify connector.


## Production backup and soak commands

When running the repository-managed production Compose directly, target it explicitly:

```bash
export COMMANDER_COMPOSE_FILE=docker-compose.coolify.yml

bash scripts/backup-compose.sh /secure/backups/commender

COMMANDER_RESTORE_CONFIRM=RESTORE \
bash scripts/restore-compose.sh /secure/backups/commender/commender-YYYYMMDDTHHMMSSZ.dump
```

If the deployment uses a non-default Compose project name, also set:

```bash
export COMMANDER_COMPOSE_PROJECT=<compose-project-name>
```

For restart/reconnect acceptance with a real enrolled device:

```bash
COMMANDER_CONTROL_URL=https://wecommander.app \
CONTROL_API_KEY='<control key>' \
DEVICE_ID='<device uuid>' \
COMMANDER_COMPOSE_FILE=docker-compose.coolify.yml \
SOAK_ITERATIONS=10 \
SOAK_TASK_COMMAND='<long-running harmless command>' \
node scripts/soak-restart.mjs
```

The destructive restore gate must be run only after a fresh backup has been verified and only during an explicit acceptance window.

## A4 — independent HTTPS/TLS check (8 November 2026): PASSED

Qualys SSL Labs (api.ssllabs.com, engine 2.4.3, criteria 2009q), full fresh assessment of `wecommander.app`:

| Endpoint (Cloudflare) | Before | After minimum TLS 1.2 |
|---|---|---|
| 2606:4700:3036::ac43:a08e | B | **A+** |
| 2606:4700:3033::6815:ecf | B | **A+** |
| 104.21.14.207 | B | **A+** |
| 172.67.160.142 | B | **A+** |

- The B grade was caused only by TLS 1.0 and 1.1 being enabled at the Cloudflare edge. The owner set **SSL/TLS → Edge Certificates → Minimum TLS Version = TLS 1.2**; the re-run graded every endpoint A+ (`isExceptional: true`, no warnings).
- Measured in the first run and unchanged: certificate chain trusted by Mozilla, Apple, Android, Java and Windows; TLS 1.3 with the post-quantum group X25519MLKEM768; forward secrecy; no Heartbleed, POODLE, ROBOT, Ticketbleed, CCS or renegotiation issues; HSTS `max-age=31536000` sent by the gateway and `wecommander.app` present in the Chrome, Edge, Firefox and IE HSTS preload lists (the `.app` TLD is preloaded); `content-security-policy`, `x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer` and `permissions-policy` on the page.
- WSS: agents and Management Centers connect over `wss://wecommander.app` through the same edge; the device list shows them online after the change.
