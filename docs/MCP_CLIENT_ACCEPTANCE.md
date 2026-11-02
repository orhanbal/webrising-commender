# MCP client acceptance: Claude Code → WECOMMANDER Gateway → Rust Agent

Scope: isolated environment only (local PostgreSQL 16, gateway from this branch,
debug Rust Agent on the same Ubuntu 24.04 VM, one allowed root). No production
gateway, production database or real customer device was used.

## Automated acceptance (CI)

`gateway/test/mcp-client-acceptance.mjs` runs in the `agent-e2e` job against a
gateway with `MCP_OAUTH_ENABLED=true` and a real Rust Agent. Identities are
separated as they are in production:

- the AI client holds only an OAuth 2.1/PKCE MCP token of an `operator` user;
- a separate `admin` user approves from a browser session;
- an `owner` of another organization tries to reach the device.

| # | Check | Result (local, 2 Nov 2026) |
|---|---|---|
| 1 | 401 + `resource_metadata` challenge; `initialize` (2025-06-18); `notifications/initialized` → 202; `ping`; unknown method → -32601; event-stream `GET /mcp` and `DELETE /mcp` → 405 `Allow: POST` | PASSED |
| 2 | `tools/list`: 50 tools, unique names, object input schemas, `required` ⊆ `properties`, every HIGH-risk tool exposes `approval_token` | PASSED |
| 3 | `devices_list` (own organization only), `system_info`, `fs_list`, `fs_read` inside the allowed root | PASSED |
| 4 | outside-root read, list, `..` traversal and write refused; secret never in any response | PASSED |
| 5 | HIGH-risk `process_exec` without approval → `approval_required`; AI token on the approval API → 401; forged token refused; admin deny keeps it blocked | PASSED |
| 6 | admin-approved exact command runs once; a different command and a replay need a new approval | PASSED |
| 7 | approved `task_start`; a new OAuth client and new MCP session read `task_status` = completed with full output | PASSED |
| 8 | other tenant: empty `devices_list`; `system_info` / `fs_read` on the device fail | PASSED |
| 9 | audit: every AI call attributed to the operator user, approve/deny to the admin user, no secret content | PASSED |

Regression proof: on `main` without the 405 fix, check 1 fails with
`503 !== 405`, because the event-stream `GET /mcp` fell through to the dashboard
page route.

## Real client run (Claude Code 2.1.316, headless `claude -p`)

Claude Code connected over HTTP MCP with `Authorization: Bearer <operator OAuth
token>` (`--mcp-config`, `--strict-mcp-config`). Only the tools named in
`--allowedTools` were permitted. Three separate client processes were used, so
each run was a new connection.

- **Session A:** MCP server `connected`, 50 tools.
  - `devices_list` returned 1 online device.
  - `system_info` returned Ubuntu 24.04, 4 CPUs.
  - `fs_list` and `fs_read` returned `hello from the allowed root`.
  - `fs_read` outside the root returned "path is outside configured allowed roots".
  - `process_exec uname -a` and `task_start` both returned `approval_required`.
- **Between sessions:** approving with the operator token returned **401**.
  The admin session approved both requests (200 each).
- **Session B:** the retried `uname -a` ran (exit 0, real kernel string).
  `task_start` returned `running` with a task id.
- **Session C** (after the client disconnected):
  - `task_status` returned `completed`, exit 0, output `tick 1 … tick 5, task-finished`.
  - `uname -a` again returned `approval_required`: the approval was single-use.
- **Audit:** 16 events, with AI calls by `user:<operator>` and approvals by
  `user:<admin>`.

## Not yet accepted (needs owner-approved access)

- The same flow from Claude Code on the web (or ChatGPT) to a public
  WECOMMANDER gateway over HTTPS, using the interactive OAuth consent instead
  of a pre-minted token.
- A real, separately hosted Ubuntu server enrolled with a dedicated
  non-root Agent and a narrow allowed root. Read-only checks come first; any
  HIGH-risk command needs the owner's explicit approval each time.
- Reconnect of the Agent across a network interruption on that server.
