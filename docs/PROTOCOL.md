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
- `terminal_start`
- `terminal_input`
- `terminal_read`
- `terminal_resize`
- `terminal_stop`

Every action has a deterministic risk classification shared by gateway and agent.
