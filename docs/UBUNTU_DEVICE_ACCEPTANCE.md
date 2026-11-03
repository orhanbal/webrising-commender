# Real Ubuntu device acceptance: Claude Code Web → WECOMMANDER → `148.135.181.148`

Status: **PENDING owner approval.** Nothing on this server has been touched.
Claude has no SSH access and must never receive root keys. The owner runs
every server-side command in their own SSH session.

## Preconditions

1. The production cut-over in `docs/RELEASE_POLICY.md` is complete, and a
   verified release that contains PR #34 (MCP transport fixes) is live at
   `https://wecommander.webrising.tr`. Before that release, the 405 and
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

Add `https://wecommander.webrising.tr/mcp` as a remote MCP server or connector
in the Claude client and complete the OAuth consent as the **operator**.
Whether Claude Code on the web supports a custom remote MCP server with an
OAuth browser consent must be verified in the client itself. If it does not,
record **BLOCKED_EXTERNAL** for item 3. Testing another client (for example the
Claude Code CLI, as in `docs/MCP_CLIENT_ACCEPTANCE.md`) is useful, but it does
not replace this item.

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

Approvals B and C are HIGH-risk operations in WECOMMANDER. Each applies to
exactly the command shown and is given in the admin's browser.

### Item 15 — temporary egress block with automatic undo (approval D)

This blocks only the Agent's outbound connection to the gateway, for 90
seconds. It does not touch SSH. The undo is scheduled **before** the block is
applied.

```bash
GW=$(getent ahostsv4 wecommander.webrising.tr | awk 'NR==1{print $1}')
sudo systemd-run --on-active=90 --unit=wec-unblock iptables -D OUTPUT -d "$GW" -p tcp --dport 443 -m owner --uid-owner wecommander -j REJECT
sudo iptables -I OUTPUT -d "$GW" -p tcp --dport 443 -m owner --uid-owner wecommander -j REJECT
```

Watch WECOMMANDER → Devices go offline, then online again within about two
minutes of the undo. Afterwards `sudo iptables -S OUTPUT` must show no
leftover rule.

## What remains out of scope until separately approved

- Writable directories, service restarts or any command other than items 11
  and 13.
- Adding paths beyond `/srv/wecommander-acceptance`.
