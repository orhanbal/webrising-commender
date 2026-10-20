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
- `fs_list`
- `fs_stat`
- `fs_read`
- `fs_write`
- `fs_mkdir`
- `fs_delete`
- `process_exec`
- `process_list`
- `process_kill`
- `task_start`
- `task_status`
- `task_cancel`
- `terminal_start`
- `terminal_input`
- `terminal_read`
- `terminal_resize`
- `terminal_stop`

Every action has a deterministic risk classification shared by gateway and agent.

For HIGH-risk actions, `approvalToken` is cryptographically bound to the complete `action` object. The gateway consumes the token once, and the native agent independently verifies that the received action exactly matches the signed approval claim.
