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
6. Gateway validates the credential and marks the device online.
7. MCP/REST requests are routed to the live socket.
8. If the socket drops, the agent reconnects with exponential backoff.

## Persistence

Gateway is stateless for device transport except for live sockets and in-flight request promises. Durable state is PostgreSQL.

PTY sessions and background task state are held by the native agent process, not by the AI client connection. This lets the AI disconnect/reconnect without killing work. `terminal_list` and `task_list` allow a newly connected client to rediscover retained session/task ids.
