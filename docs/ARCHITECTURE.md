# Architecture

```text
AI client (ChatGPT / Claude / Cursor / custom)
                    |
             MCP over HTTPS
                    |
                    v
+-------------------------------------------+
| WebRising Commender Gateway               |
| - MCP JSON-RPC endpoint                   |
| - management REST API                     |
| - WebSocket device relay                  |
| - approval signer                         |
| - audit + redaction                       |
| - SaaS entitlement/billing boundary        |
| - auth verification + durable mail outbox  |
+----------------------+--------------------+
                       |
                    PostgreSQL
                       |
             outbound WSS/TLS
                       |
                       v
+-------------------------------------------+
| Native Rust Agent                         |
| - reconnect/heartbeat                     |
| - local path policy                       |
| - file/search/edit/process/system ops     |
| - persistent PTY + background tasks       |
+-------------------------------------------+
```

## Trust boundaries

The gateway authenticates the AI/control-plane caller and the device separately. Device tokens are random credentials stored server-side only as SHA-256 digests. Pairing codes are one-time and expire.

The agent is the final enforcement boundary for filesystem roots. A compromised or misconfigured gateway must not be able to escape the agent's configured roots through normal filesystem tools.

## Connection lifecycle

1. Operator creates a one-time pairing code.
2. Agent calls the enrollment endpoint with that code.
3. Gateway returns device id + device token.
4. Agent persists the credentials with user-only permissions.
5. Agent opens `/agent` WebSocket using the device id/token.
6. Gateway validates the transport credential but keeps the device not-ready.
7. Agent sends `hello`; after that current socket's metadata is persisted, the gateway marks the device online/ready.
8. MCP/REST requests are routed only to a ready socket.
9. If the socket drops, the agent reconnects with exponential backoff and must complete `hello` again.

## Persistence

Gateway is stateless for device transport except for live sockets and in-flight request promises. Durable state is PostgreSQL.

PTY sessions and background task state are held by the native agent process, not by the AI client connection. This lets the AI disconnect/reconnect without killing work. `terminal_list` and `task_list` allow a newly connected client to rediscover retained session/task ids.


## Deployment and entitlement modes

The same gateway binary supports two deployment modes.

- `self_hosted` (default): core remote-control resources are unlimited and no subscription record is required.
- `saas`: an organization must have an entitled `trialing` or `active` subscription backed by an active billing plan before allocating new devices, member seats or tenant API tokens.

Plan limits are intentionally provider-neutral. The database stores plan entitlements, organization subscription state, provider identifiers and normalized billing events, but it does not hard-code checkout prices or a payment vendor.

Quota checks run inside the same organization-level database lock as the resource allocation. This prevents concurrent requests from both consuming the final available slot. Subscription/event changes take the same organization lock so billing state and allocations have a deterministic serial order.

A downgrade, `past_due` state or cancellation never deletes existing devices, memberships or tokens. It blocks new allocations until entitlement is restored or usage falls within the active plan.

Provider webhooks are expected to be signature-verified by a provider-specific adapter before they are converted to the normalized internal billing event contract. The normalized event ledger is idempotent on `provider + event_id` and rejects an event-id replay carrying a different payload.
The normalized contract includes the provider's trusted occurrence time. Subscription rows retain the last applied provider event id/time; older events and events from a no-longer-bound provider are ledgered for audit but cannot mutate current entitlement state. Same-time different events are rejected as an ordering conflict so the adapter can reconcile from an authoritative provider snapshot instead of relying on an arbitrary tie-breaker.


## Authentication mail boundary

Email delivery is internal to the gateway rather than delegated to a hosted SDK.

Public signup writes a short-lived pending registration containing the normalized email, scrypt password verifier, requested workspace name and only the SHA-256 verifier of the verification token. Verification atomically converts that pending record into a verified user + owner membership.

Password reset uses a separate single-use auth-token table and revokes all browser sessions when consumed.

Mail is first committed to `mail_outbox`. In SMTP mode, a built-in worker claims rows with PostgreSQL row locks/leases and delivers them through a first-party SMTP client. Failed deliveries back off and retry. Successful auth messages have their text body cleared so bearer links do not remain at rest after delivery.

This architecture permits an operator-owned mail server, a local relay, or development outbox mode without introducing a runtime dependency on a commercial email provider.
