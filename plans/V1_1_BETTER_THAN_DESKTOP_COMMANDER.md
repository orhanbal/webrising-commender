# WECOMMANDER v1.1: a better Desktop Commander

Created: 2026-11-04 · Owner decision pending: the loosest trust level (see 1).

## Goal

WECOMMANDER is meant to be a better and more capable Desktop Commander: the
user adds it to the AI they already use as an MCP server, and the AI uses
terminals and files on the user's machines and servers.

## Where we stand (2026-11-04, production `bb7f0045`)

| Area | Desktop Commander | WECOMMANDER today |
|---|---|---|
| Works with which AI clients | local desktop MCP clients (stdio) | **any MCP client incl. claude.ai web, ChatGPT, mobile** (OAuth, verified with claude.ai) |
| Remote / many machines | paid, quota-limited remote service | **one MCP endpoint for all devices, no inbound port, self-hosted free core** |
| Security | runs with the user's full rights; client-side prompts only | **non-root agent, server-side single-use approvals, device-local capabilities, allowlist, RBAC, audit** |
| Extra tools | — | **undo/versions, SHA compare-and-swap, resumable search, XLSX/DOCX, process-tree cleanup** |
| Setup | one line (`npx …`) | account + device approval + agent + connector (**worse**) |
| Day-to-day friction | commands run immediately | HIGH-risk commands wait for approval (**worse** for trusted machines) |
| Editing / formats | fuzzy `edit_block`, PDF, URL reading | exact `fs_replace` only; no PDF, no URL (**worse**) |
| Local, serverless use | yes | no (**worse**) |

The remote, security and multi-device rows are already better. v1.1 closes
the four rows marked worse.

## Work items

### 1. Per-device trust level (highest impact) · 1 day
Owner chooses per device in the console (browser session only, audited):

- **Strict:** every HIGH-risk operation needs approval (today's default).
- **Standard:** command allowlist runs without approval, everything else
  needs approval (live since `bb7f0045`).
- **Full:** Desktop Commander behaviour, no per-call approval. Still kept:
  the non-root service user, allowed roots for file tools, device-local
  capabilities, audit of every call, undo for file changes, and the approval
  e-mail switched to an after-the-fact activity digest. Can be time-limited
  and revoked instantly.

Acceptance: an AI client cannot change the level (403 for API/OAuth tokens);
switching to Full requires the password; the real-device test runs the same
command under each level with the expected outcome.

### 2. One-line install and instant connection · 1 day
- Linux/macOS: `curl -fsSL https://<gateway>/install.sh | sh` (checksum-pinned
  package, the same non-root setup as today). Windows: one signed `.exe`.
- The device-link page shows the ready MCP URL and one-click "add to Claude /
  ChatGPT" instructions after approval.
- Acceptance: a fresh Ubuntu VM goes from nothing to AI-usable in under 2
  minutes and 2 user actions (run the line, approve in the browser).

### 3. Tool parity with Desktop Commander · 1 day
- `edit_block`: search/replace with whitespace-tolerant fuzzy matching, a
  shown diff, and refusal when the match is ambiguous.
- `pdf_read`: text and page ranges, bounded, no external renderer.
- `url_fetch`: from the device or the gateway, http(s) only, size and time
  bounded, SSRF guard (no private ranges unless the device opts in).
- Desktop Commander-compatible aliases for the common tools (for example
  `read_file`, `write_file`, `start_process`, `interact_with_process`,
  `read_process_output`, `list_directory`, `search_files`).
- Acceptance: a Desktop Commander user's common prompts work unchanged.

### 4. Local mode · 2–3 days
The same Rust agent serves MCP over stdio for a local AI client with no
gateway and no account. Policy, allowed roots, undo and the local audit file
still apply; remote features light up when the device is linked to a
gateway.
Acceptance: Claude Desktop with `wecommander --mcp-stdio` passes the same tool
suite as the remote path.

## Order and timing

v1.1 development starts right away, in parallel with the remaining v1.0
acceptance, which now mostly waits on hardware and owner actions. Every
item ships through its own PR, CI and `promote-production`. Items 1 → 2 → 3
need about 3 days, plus 2–3 days for 4.

## Later (v1.2+), unchanged from the earlier proposal
Fleet operations (groups, batch commands), change sets with one-click
rollback, secret redaction in output, structured Docker/systemd tools,
private AI via Ollama on the owner's GPU, runbooks, session recording,
tamper-evident audit export.
