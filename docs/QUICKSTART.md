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

For a WebRising-operated SaaS deployment, set:

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
    "provider":null,
    "cancelAtPeriodEnd":false
  }'
```

A tenant can read its effective limits and current usage with `GET /api/billing`. The web console shows the same data under **Access → Plan & usage**.

The provider-neutral normalized event ingress is `POST /api/admin/billing/events`. It is protected by the global control credential and is **not** a raw Paddle/Stripe webhook endpoint. A provider adapter must verify the provider signature first, resolve the organization/plan, and only then submit the normalized event.

In SaaS mode:
- missing/inactive billing state returns `billing_required` for new allocations;
- exhausted limits return `quota_exceeded` with resource, usage and limit;
- existing resources remain intact when billing state changes;
- pending invitations reserve member slots;
- revoked/expired invitations, revoked tokens and revoked devices release their corresponding capacity.
