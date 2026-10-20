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

For production SaaS, `CONTROL_API_KEY` is replaced by user/session authorization. The self-hosted API key mode remains supported.

## 7. High-risk approval

High-risk actions such as shell execution and deletion require a short-lived approval token.

```bash
curl -X POST http://localhost:8787/api/approvals \
  -H "Authorization: Bearer $CONTROL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"<DEVICE_UUID>","action":"process_exec","ttlSeconds":120}'
```

Pass the returned `approvalToken` to the corresponding MCP tool call.
