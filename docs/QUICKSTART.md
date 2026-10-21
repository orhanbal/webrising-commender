# Quick start

This guide runs the self-hosted control plane locally and enrolls one device.

## 1. Start the gateway

Requirements: Docker + Docker Compose.

```bash
git clone https://github.com/orhanbal/webrising-commender.git
cd webrising-commender
cp .env.example .env
```

Generate two independent secrets of at least 32 random bytes:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

Set `CONTROL_API_KEY` and `APPROVAL_SIGNING_SECRET` in `.env`, then:

```bash
docker compose up -d --build
curl http://localhost:8787/health
```

Open `http://localhost:8787` and enter the control API key.

## 2. Build the agent

Install the stable Rust toolchain, then:

```bash
cargo build --release -p webrising-commender-agent
```

Binary:
- Windows: `target/release/webrising-commender.exe`
- Linux/macOS: `target/release/webrising-commender`

## 3. Create a pairing code

Use the web console, or:

```bash
curl -X POST http://localhost:8787/api/pairing \
  -H "Authorization: Bearer $CONTROL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Pairing codes are one-time and expire after 10 minutes.

## 4. Enroll the agent

Windows PowerShell example:

```powershell
.\webrising-commender.exe enroll `
  --control-url http://localhost:8787 `
  --pairing-code "<PAIRING_CODE>" `
  --allowed-root "C:\Users\YourName"
```

Linux/macOS example:

```bash
./webrising-commender enroll \
  --control-url http://localhost:8787 \
  --pairing-code "<PAIRING_CODE>" \
  --allowed-root "$HOME"
```

The device credential is written to the platform configuration directory and is not printed.

## 5. Run

```bash
webrising-commender run
```

The agent initiates the connection. No inbound port is required on the device.

## 6. MCP endpoint

Endpoint:

```text
POST https://YOUR-GATEWAY/mcp
Authorization: Bearer CONTROL_API_KEY
```

The endpoint implements the MCP JSON-RPC methods used by the MVP:

- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`

Self-hosted mode supports the global `CONTROL_API_KEY` and tenant-scoped API tokens. SaaS/browser session authentication can sit in front of the same organization/RBAC boundary without changing the native-agent protocol.

## 7. High-risk approval

HIGH-risk operations are approved for the **exact operation payload**, not only the action family. Changing the command, path, PID, task id or terminal session invalidates the approval.

Direct REST approval example:

```bash
curl -X POST http://localhost:8787/api/approvals \
  -H "Authorization: Bearer $CONTROL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId":"<DEVICE_UUID>",
    "action":{
      "kind":"process_exec",
      "command":"git status",
      "cwd":"/allowed/project",
      "timeoutMs":30000
    },
    "ttlSeconds":120
  }'
```

Pass the returned `approvalToken` with that **same** operation.

For MCP callers, the safer human-in-the-loop flow is automatic:

1. Call a HIGH-risk tool without `approval_token`.
2. Commender returns `approval_request_id` and stores the exact requested operation.
3. An admin/owner reviews it in the **Approvals** console and approves or denies it.
4. Retry the same MCP tool call without an approval token.
5. The gateway atomically consumes the approved request, creates a device-bound signed claim internally, and executes it once.

An approved request cannot authorize a different operation or a replay.


## Browser account bootstrap

For a self-hosted installation, use the `CONTROL_API_KEY` once to create the first browser owner:

```bash
curl -X POST http://localhost:8787/api/users \
  -H "Authorization: Bearer $CONTROL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@example.com","password":"replace-with-a-long-password","role":"owner"}'
```

After that, open the console and sign in with the browser account. The console uses an HttpOnly session cookie and CSRF protection; the control key no longer needs to be kept in the browser session.


## Workspace onboarding and invitations

Browser users can create additional workspaces from the **Access** tab. The current browser session becomes an `owner` of the new workspace.

Admins and owners can create invitation links without any paid email dependency:

1. Open **Access → Invite member**.
2. Enter the email and role.
3. Copy the one-time invitation URL.
4. Deliver it through email, chat, or another trusted channel.

Invitation secrets are returned only when created. The gateway stores only a SHA-256 verifier. Invitations expire automatically, can be revoked before use, and become unusable after acceptance.
The invitation token is carried in the URL fragment (`#invite=...`) so it is not sent as part of the page request URL or exposed to ordinary reverse-proxy access logs.

Existing users must enter their current account password when accepting an invitation. New users choose a password during acceptance.

Member role changes and removals use the **Members** table. The gateway refuses any operation that would leave a workspace without an owner.

Tenant API tokens are also managed from **Access**. Raw token values are returned once at creation and should be copied immediately.


## Deployment mode and SaaS entitlements

The default is:

```env
DEPLOYMENT_MODE=self_hosted
```

In `self_hosted` mode no billing record is required and core device/member/API-token allocations are unlimited.

For a WECOMMANDER-operated SaaS deployment, set:

```env
DEPLOYMENT_MODE=saas
```

SaaS mode intentionally ships without hard-coded commercial prices. The global control plane provisions a plan and assigns it to an organization. Example:

```bash
curl -X POST https://YOUR-GATEWAY/api/admin/billing/plans \
  -H "Authorization: Bearer $CONTROL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key":"pro",
    "name":"Pro",
    "maxDevices":10,
    "maxMembers":5,
    "maxApiTokens":10,
    "metadata":{},
    "active":true
  }'
```

Then assign the plan:

```bash
curl -X PUT https://YOUR-GATEWAY/api/admin/organizations/ORGANIZATION_UUID/subscription \
  -H "Authorization: Bearer $CONTROL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "planKey":"pro",
    "status":"active",
    "cancelAtPeriodEnd":false
  }'
```

A tenant can read its effective limits and current usage with `GET /api/billing`. The web console shows the same data under **Access → Plan & usage**.

The provider-neutral normalized event ingress is `POST /api/admin/billing/events`. It is protected by the global control credential and is **not** a raw Paddle/Stripe webhook endpoint. Manual subscription assignment never writes provider/customer/subscription identifiers; those identities are accepted only through the verified normalized-event path. A provider adapter must verify the provider signature first, resolve the organization/plan, and only then submit the normalized event. Every normalized event must include the provider's trusted `occurredAt` timestamp. Older events are ledgered but ignored; if two different events have the same occurrence time, the gateway returns `billing_event_order_conflict` (409) and the adapter must reconcile the current subscription state from the provider.

In SaaS mode:
- missing/inactive billing state returns `billing_required` for new allocations;
- exhausted limits return `quota_exceeded` with resource, usage and limit;
- existing resources remain intact when billing state changes;
- pending invitations reserve member slots;
- revoked/expired invitations, revoked tokens and revoked devices release their corresponding capacity.


## Local SMTP, verified signup and password reset

Commender does not require a transactional-email SaaS. The gateway includes its own SMTP/STARTTLS client and an encrypted PostgreSQL outbox.

Public signup is deliberately off by default and only operates in SaaS mode. Configure your own mail server:

```env
DEPLOYMENT_MODE=saas
PUBLIC_SIGNUP_ENABLED=true

SMTP_HOST=mail.example.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_HELO_NAME=wecommander.example.com
SMTP_USERNAME=commender@example.com
SMTP_PASSWORD=replace-me
SMTP_FROM=WECOMMANDER <commender@example.com>
SMTP_TLS_REJECT_UNAUTHORIZED=true

# 32 random bytes. Keep this outside the database backup.
MAIL_OUTBOX_KEY=<64 hex characters from: openssl rand -hex 32>
MAIL_DELIVERY_INTERVAL_MS=5000
MAIL_DELIVERY_BATCH=10
MAIL_MAX_ATTEMPTS=12
```

Signup flow:

1. `POST /api/auth/signup` stores only a pending signup, not an active user/workspace.
2. The verification token is hash-only in PostgreSQL; the mail payload is AES-256-GCM encrypted in the outbox.
3. The email link carries the token in the URL fragment (`#verify=...`), so it is not sent in the initial HTTP request URL.
4. Verification also requires the password chosen during signup. Only then are the user and first workspace created atomically.
5. The verified user receives an HttpOnly browser session.

Password reset uses the same local outbox. Reset requests return the same generic success response for existing and unknown addresses. A successful reset consumes all outstanding reset tokens and revokes every browser session for that user.

`GET /api/public/config` tells the console whether signup/reset initiation is available without exposing SMTP details.

Global-control operations can inspect delivery metadata only with `GET /api/admin/mail/outbox`; recipients, subjects and bodies are never returned. Failed dead-letter rows can be requeued with `POST /api/admin/mail/outbox/:id/retry`.

**Backup note:** `MAIL_OUTBOX_KEY` is intentionally not stored in PostgreSQL. A database restore containing unsent outbox rows requires the same key. Store it in your normal secret backup process. Changing the key while rows are pending makes those encrypted payloads unreadable.


## Regional relay deployment

Regional relays are optional. Leave `REGIONAL_RELAY_ENABLED=false` for a normal self-hosted single-gateway installation.

For a clustered control node:

```env
REGIONAL_RELAY_ENABLED=true
CLUSTER_NODE_ID=control-1
RELAY_CLUSTER_SECRET=<at least 32 random characters>
```

The control node does not need `RELAY_PUBLIC_WS_URL` or `RELAY_INTERNAL_BASE_URL`.

Each relay node runs the same gateway build against the same private PostgreSQL control-plane database and additionally sets:

```env
REGIONAL_RELAY_ENABLED=true
CLUSTER_NODE_ID=relay-eu-1
RELAY_CLUSTER_SECRET=<same cluster secret>
RELAY_REGION=eu-central
RELAY_PUBLIC_WS_URL=wss://relay-eu-1.example.com/agent
RELAY_INTERNAL_BASE_URL=https://10.0.20.11:8787
RELAY_MAX_DEVICES=10000
```

Production requirements:
- `RELAY_PUBLIC_WS_URL` uses WSS.
- `RELAY_INTERNAL_BASE_URL` uses HTTPS on a private network/VPN.
- PostgreSQL is private and reachable only by trusted Commender control/relay nodes.
- `RELAY_CLUSTER_SECRET` is distributed through your own secret-management process and is not stored in PostgreSQL.
- public reverse proxies must preserve WebSocket upgrade support on `/agent`.
- internal relay HTTP endpoints should not be internet-routable even though they also require HMAC.

Relay nodes self-register/heartbeat. Global control can inspect them with `GET /api/admin/relays` or through **Access → Regional relay nodes**. A node can be drained or disabled there.

Workspace owners can choose a best-effort preferred region under **Access → Workspace**. If that region is unavailable, Commender automatically falls back to another healthy region.

Agents do not require re-enrollment during relay failover. The durable `controlUrl` is used to refresh `gatewayWsUrl` after a disconnect.


## Native HTTPS/WSS without a reverse proxy

Commender can terminate TLS directly. Supply both certificate files and set the public URL to HTTPS:

```env
PUBLIC_BASE_URL=https://wecommander.example.com:8787
TLS_CERT_FILE=/run/secrets/commender-fullchain.pem
TLS_KEY_FILE=/run/secrets/commender-privkey.pem
TLS_MIN_VERSION=TLSv1.2
```

For Docker Compose, mount the certificate and key read-only into the gateway container using a local Compose override:

```yaml
services:
  gateway:
    volumes:
      - ./secrets/fullchain.pem:/run/secrets/commender-fullchain.pem:ro
      - ./secrets/privkey.pem:/run/secrets/commender-privkey.pem:ro
```

The paths in `.env` are paths **inside the container**. Keep the key file private. If the public host maps TCP 443 to the gateway's internal port, use the externally visible URL (for example `https://wecommander.example.com`) as `PUBLIC_BASE_URL`.

To keep an existing reverse proxy instead, leave `TLS_CERT_FILE` and `TLS_KEY_FILE` empty and terminate HTTPS/WSS at that proxy.

Commender does not issue or renew certificates. Use a certificate chain trusted by every browser, MCP client and agent that will connect. A certificate/key change currently requires a gateway restart.
