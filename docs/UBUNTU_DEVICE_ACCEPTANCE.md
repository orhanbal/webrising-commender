# Real Ubuntu device acceptance: Claude Code Web → WECOMMANDER → `148.135.181.148`

Status: **items 1–12 PASSED on 2026-11-04** (results below); items 13–15
pending.
Claude has no SSH access and must never receive root keys. The owner runs
every server-side command in their own SSH session.

## Preconditions

1. The production cut-over in `docs/RELEASE_POLICY.md` is complete, and a
   verified release that contains PR #34 (MCP transport fixes) is live at
   `https://wecommander.app`. Before that release, the 405 and
   protocol-version behaviour described here is not in production.
2. The Agent package: release `ubuntu-preview-1569` contains
   `wecommander-agent_0.1.1569_amd64.deb` (SHA-256
   `b2d06f4ea33749a0a4b59dc30e0e9e78949bfffc293be28d3e0de94ca6d33cbb`, equal
   to GitHub's asset digest) and `SHA256SUMS.txt`. It was built from `main`
   `d895eb59`, which contains PR #34 and PR #39. Install it with the pinned
   checksum below, not with "latest".
3. Two WECOMMANDER accounts in the same organization:
   - an **operator**: the identity Claude connects as;
   - an **admin/owner**: the only identity that approves HIGH-risk
     operations, from a separate browser session.

## Step A — install the Agent (owner, on the server, needs approval A)

Approval A covers: install one package; create the unprivileged system user
`wecommander`; create one read-only acceptance directory; enable one systemd
service. No inbound port is opened. The Agent connects outbound to the
gateway only.

```bash
curl -fsSLO https://github.com/orhanbal/webrising-commender/releases/download/ubuntu-preview-1569/wecommander-agent_0.1.1569_amd64.deb
curl -fsSLO https://github.com/orhanbal/webrising-commender/releases/download/ubuntu-preview-1569/SHA256SUMS.txt
echo 'b2d06f4ea33749a0a4b59dc30e0e9e78949bfffc293be28d3e0de94ca6d33cbb  wecommander-agent_0.1.1569_amd64.deb' | sha256sum -c -
sudo apt-get install -y ./wecommander-agent_0.1.1569_amd64.deb
```

The acceptance root is **read-only at the OS level** for the Agent. Even an
approved write fails at the kernel, independent of WECOMMANDER policy.

```bash
sudo install -d -o root -g wecommander -m 0750 /srv/wecommander-acceptance
echo "hello from 148.135.181.148" | sudo tee /srv/wecommander-acceptance/readme.txt >/dev/null
sudo chown root:wecommander /srv/wecommander-acceptance/readme.txt
sudo chmod 0640 /srv/wecommander-acceptance/readme.txt
sudo wecommander-setup --allowed-root /srv/wecommander-acceptance --read-only --no-commands
```

`--read-only --no-commands` (PR #39) makes the first, read-only phase
enforced by the Agent on the device itself: even an approved command or
write is refused, and only the owner can lift it, locally. The pinned
`ubuntu-preview-1569` package contains PR #39, so both flags are available.
Before items
11 and 13 the owner enables commands locally:
`sudo -u wecommander /opt/wecommander/bin/webrising-commender --config /var/lib/webrising-commender/agent.json capabilities --commands on`
followed by `sudo systemctl restart webrising-commender` (part of approval B).

`wecommander-setup` (from the package, `/usr/bin/wecommander-setup`) checks the
packaged binary's SHA-256 and passes the flags to `setup-ubuntu.sh`.

`wecommander-setup` prints a `…/connect-device?requestId=…` URL. Open it in
the **admin's own browser**, sign in, and approve the device into the
organization. The script refuses broad roots (`/`, `/etc`, `/home`, `/srv`
itself, …) and checks that the service account can read the root.

**Rollback A** (the package also ships `/opt/wecommander/libexec/uninstall-linux.sh`):

```bash
sudo systemctl disable --now webrising-commender
sudo apt-get remove -y wecommander-agent
sudo userdel wecommander
sudo rm -rf /var/lib/webrising-commender /srv/wecommander-acceptance
```

Then revoke the device in WECOMMANDER → Devices.

## Step B — connect Claude Code Web (operator)

Add `https://wecommander.app/mcp` as a remote MCP server or connector
in the Claude client and complete the OAuth consent as the **operator**.
Whether Claude Code on the web supports a custom remote MCP server with an
OAuth browser consent must be verified in the client itself. If it does not,
record **BLOCKED_EXTERNAL** for item 3. Testing another client (for example the
Claude Code CLI, as in `docs/MCP_CLIENT_ACCEPTANCE.md`) is useful, but it does
not replace this item.

## Results (2026-11-04, production `ede66013`, Agent `ubuntu-preview-1569`)

The client was a Claude.ai custom connector (`https://wecommander.app/mcp`),
signed in as the owner. Device `794911a6-08a2-45c9-86a5-3029e1a04620`.

| # | Result | Evidence |
|---|---|---|
| 1 | PASS | production-guard probe: HTTPS 200, HSTS `max-age=31536000`, `build.commit` = released SHA, MCP OAuth discovery |
| 2 | PASS | consent → Claude callback (after PR #53); REST with OAuth token → 401 is covered by `oauth-integration.mjs` |
| 3 | PASS | Claude.ai connector connected, WECOMMANDER tools listed in the Claude session |
| 4–5 | PASS | `devices_list`: `794911a6…` `148-135-181-148`, online; same id printed by `wecommander-setup` |
| 6 | PASS | Ubuntu 24.04, kernel 6.8.0-146-generic, 12 CPU, 16 GiB |
| 7–8 | PASS | `readme.txt` (27 bytes) listed and read: `hello from 148.135.181.148` |
| 9 | PASS | `/etc/passwd` → `path is outside configured allowed roots`; `…/../../etc/shadow` → `parent traversal components are not allowed` |
| 10 | PASS | `process_exec id` → `approval_required`; with `--no-commands` `policy_info` showed `commandExecution: disabled`; a forged `approval_token` → `approval_required`; `fs_write` → `device_policy_denied: file writes are disabled on this device` |
| 11 | PASS | after the owner enabled commands locally and approved the exact command: `uid=999(wecommander) gid=987(wecommander)`, exit 0 |
| 12 | PASS | the same command again → new `approval_required` (single use) |
| 13 | PASS (2026-11-05, Agent `0.1.1609`) | `task_start` → `approval_required` → approved in `/approvals` → the same call ran once; `task_list` recovered the id; `task_status`: exit 0, three dates 5 s apart (06:36:18/23/28 UTC). Checked from separate MCP requests in the same Claude session |
| 14 | PASS | audit: `task_start` approval_pending → `approval_request.approve` → approval_consumed → success, then `task_list`/`task_status`; risk and outcome only, no file contents. Found: `edit_block` no-match was audited as `denied` and a device-policy refusal as `error`; swapped in the liveness PR |
| 15 | PASS with finding | first attempt blocked only one of the two Cloudflare addresses and had no effect (the Agent connects through Cloudflare, `172.67.160.142`). Second attempt blocked both (`104.21.14.207`, `172.67.160.142`) for 150 s: calls failed with `device-request-timeout`, then the device answered again without re-enrollment and `task_list` still listed the task; no leftover rule. **Finding:** during the block the device stayed "online" (only `last_seen_at` stopped) and neither side noticed, because the proxy kept the gateway side open and TCP resumed the old connection. Fixed by gateway ping/stale-close and an Agent silence timeout (liveness PR) |
| — | PASS | DC-compatible tools on the real device: `list_directory`/`read_file` without `device_id`, `get_file_info`, `/etc/passwd` refused, `url_fetch` public OK and `169.254.169.254` refused, `edit_block` no-match and write refused by device policy, `pdf_read` and `read_file` on a PDF return the page text |

Defects found and fixed during this run: device-link rate-limit 429 on setup
(PR #52); Claude dynamic client registration and proxy-blind OAuth limits
(PR #52); consent page CSP `form-action` blocking the redirect back to Claude
(PR #53); `MCP_OAUTH_ENABLED` was `false` in production (set to `true`).

Note: with command execution enabled, an approved shell command runs with the
`wecommander` user's permissions and is not limited to the file tools'
allowed roots. Each command needs its own approval.

## Acceptance items (record the result and evidence for each)

| # | Check | How | Expected |
|---|---|---|---|
| 1 | HTTPS reachable | browser + `scripts/accept-production.mjs` with `COMMANDER_EXPECTED_COMMIT` | PASS, HSTS present, `build.commit` = released SHA |
| 2 | OAuth flow | consent screen as operator | token issued; REST API with that token → 401 |
| 3 | Real MCP connection from Claude Code Web | client shows wecommander connected | 50 tools listed |
| 4 | `devices_list` | Claude | the server is listed, online |
| 5 | correct identity | compare device id/hostname with WECOMMANDER → Devices | same id |
| 6 | `system_info` | Claude | Ubuntu, kernel, CPU |
| 7 | `fs_list /srv/wecommander-acceptance` | Claude | `readme.txt` |
| 8 | `fs_read …/readme.txt` | Claude | `hello from 148.135.181.148` |
| 9 | `fs_read /etc/hostname`, `fs_list /var/lib/webrising-commender` | Claude | refused: outside allowed roots |
| 10 | `process_exec "id"` without approval | Claude | `approval_required`, nothing runs (with `--no-commands`, `policy_info` also shows `commandExecution: disabled`) |
| 11 | admin approves exactly `id` (needs approval B), Claude retries | Claude | output `uid=…(wecommander)`, not root |
| 12 | same `id` again | Claude | `approval_required` (single use) |
| 13 | `task_start "for i in 1 2 3; do date; sleep 5; done"` (approval C), close the Claude session, new session → `task_status` | Claude | completed, three dates |
| 14 | audit | WECOMMANDER → Audit as admin | AI calls by operator, approvals by admin, no file contents |
| 15 | reconnect | owner on server (approval D), see below | device offline, then online without re-enrollment; `task_list` still answers |
| 16 | local mode with Desktop Commander names: the `printf … list_directory … | mcp-stdio` command in docs/LOCAL_MODE.md | owner on server | **PASS 2026-11-05** on agent `0.1.1630`: handshake, then `ornek.pdf` and `readme.txt` listed (0.1.1626 had answered `unknown_tool`, fixed in PR #78) |

Approvals B and C are HIGH-risk operations in WECOMMANDER. Each applies to
exactly the command shown and is given in the admin's browser.

### Item 15 — temporary egress block with automatic undo (approval D)

This blocks only the Agent's outbound connection to the gateway, for 90
seconds. It does not touch SSH. The undo is scheduled **before** the block is
applied.

`wecommander.app` is behind Cloudflare, which returns several addresses, so
block all of them plus the address the Agent is connected to
(`sudo ss -tnp | grep -i webrising`):

```bash
GWS=$( (getent ahostsv4 wecommander.app | awk '{print $1}'; sudo ss -tnp | awk '/webrising/{split($5,a,":");print a[1]}') | sort -u | tr '\n' ' ')
sudo systemd-run --on-active=150 --unit=wec-unblock /bin/sh -c "for ip in $GWS; do iptables -D OUTPUT -d \$ip -p tcp --dport 443 -m owner --uid-owner wecommander -j REJECT; done"
for ip in $GWS; do sudo iptables -I OUTPUT -d "$ip" -p tcp --dport 443 -m owner --uid-owner wecommander -j REJECT; done
```

Watch WECOMMANDER → Devices go offline, then online again within about two
minutes of the undo. Afterwards `sudo iptables -S OUTPUT` must show no
leftover rule.

## What remains out of scope until separately approved

- Writable directories, service restarts or any command other than items 11
  and 13.
- Adding paths beyond `/srv/wecommander-acceptance`.
