# Agent protocol v1

Transport: JSON messages over authenticated WebSocket.

## Agent -> Gateway

```json
{"type":"hello","deviceId":"...","hostname":"...","os":"...","version":"0.1.0","capabilities":["fs","process","pty","system"]}
{"type":"heartbeat","timestamp":"..."}
{"type":"result","requestId":"...","ok":true,"data":{}}
{"type":"result","requestId":"...","ok":false,"error":{"code":"...","message":"..."}}
```

## Gateway -> Agent

```json
{"type":"request","requestId":"...","action":{"kind":"system_info"},"approvalToken":null}
{"type":"cancel","requestId":"..."}
{"type":"ping","timestamp":"..."}
```

## Action kinds

- `system_info`
- `log_query` (`source` `journal`|`file`, `path`, `unit`, `sinceMinutes` 1–10080, `level` error|warning|info|debug, `pattern` case-insensitive regex ≤512, `limit` 1–1000): bounded log search, newest first, with `matched`/`returned`/`truncated`, `repeated` message groups and `limitations`; output is redacted. The journal source needs the `systemLogs` capability; file logs follow the allowed roots. Low risk.
- `health_snapshot` (`top` 1–20, default 5): CPU usage and load, memory and swap, disks, network counters, top processes by CPU and memory; carries `observedAt`, `source` and `limitations`. Low risk.
- `fs_list`
- `fs_stat`
- `fs_read`
- `fs_write`
- `fs_mkdir`
- `fs_delete`
- `fs_move`
- `fs_tree`
- `fs_search`
- `text_search`
- `fs_replace`
- `process_exec`
- `process_list`
- `process_kill`
- `task_start`
- `task_status`
- `task_cancel`
- `task_list`
- `terminal_start`
- `terminal_input`
- `terminal_read`
- `terminal_resize`
- `terminal_stop`
- `terminal_list`

Every action has a deterministic risk classification shared by gateway and agent.

For HIGH-risk actions, `approvalToken` is cryptographically bound to the complete `action` object. The gateway consumes the token once, and the native agent independently verifies that the received action exactly matches the signed approval claim.


## Search and reconnect discovery

The agent provides bounded recursive discovery so an AI client does not need shell commands for normal repository navigation:

- `fs_tree`: bounded recursive tree
- `fs_search`: file/directory-name search
- `text_search`: bounded literal UTF-8 text search
- MCP also exposes `code_search` as an alias of `text_search`
- `task_list`: recover retained background task ids after client reconnect
- `terminal_list`: recover persistent PTY session ids after client reconnect

`fs_replace` is a guarded surgical edit. Unless `replaceAll=true`, the search text must match exactly once. `fs_move` handles move/rename within the agent allowlisted roots.


## Connection readiness

An authenticated WebSocket upgrade means the transport is connected, but the device is not exposed as `online` or eligible for routed requests until the gateway has received and persisted that socket's `hello` message.

This prevents a race where the control plane could route a request before the agent receive loop and gateway message handlers were ready. Replacing a socket clears readiness until the new connection completes its own `hello` handshake. Messages from a stale replaced socket are ignored.
