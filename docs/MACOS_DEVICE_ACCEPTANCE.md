# macOS device acceptance

Physical-device acceptance for the macOS agent (v1.0 item A7). Same idea as
[UBUNTU_DEVICE_ACCEPTANCE.md](UBUNTU_DEVICE_ACCEPTANCE.md): a person runs
each step on a real Mac and records PASS/FAIL with evidence.

## Before you start

- A Mac (Apple Silicon or Intel, macOS 13 or later) with an administrator
  account. Run the commands in Terminal as your normal user, **without sudo**;
  the installer asks for the administrator password when it needs it.
- Signed in to wecommander.app as the workspace owner in a browser.
- The PKG comes from the newest `macos-preview-N` GitHub release (built and
  tested by the `macos` workflow); the installer verifies its SHA-256.

## Install and connect

```bash
curl -fsSL https://wecommander.app/install.sh | sh
```

The command downloads and verifies the PKG, installs it (administrator
password), creates `~/WECOMMANDER` as the only allowed folder, and
prints a pairing link. Open the link, approve the device in the browser, and
the agent starts as a per-user LaunchAgent.

Keep the allowed folder outside `~/Documents`, `~/Desktop`, `~/Downloads` and iCloud Drive: macOS privacy protection (TCC) asks for permission on every command the background agent starts there (see Results). To choose another folder: `curl -fsSL https://wecommander.app/install.sh | sh -s -- --allowed-root "$HOME/Projects/demo"` (never `/` or the whole home folder).

## Acceptance items

| # | Step | Who / where | Expected |
|---|---|---|---|
| 1 | install command above | owner, Terminal | "Checksum verified", PKG installed, pairing link shown |
| 2 | approve the pairing link | owner, browser | device appears in WECOMMANDER → Devices, online, platform macos |
| 3 | `launchctl print gui/$(id -u)/tr.webrising.commender \| grep state` | owner, Terminal | `state = running` |
| 4 | `policy_info` | AI client | `allowedRoots` = the chosen folder only |
| 5 | `list_directory` of the allowed folder, then of `/etc` | AI client | first works, second is refused (outside allowed roots) |
| 6 | `health_snapshot` | AI client | CPU, memory, disks; `observedAt` and `limitations` present |
| 7 | `write_file` a test file in the allowed folder, then `edit_block` it, then `fs_versions` + `fs_undo` | AI client | write and edit succeed (after approval, if the device's trust level asks for one); undo restores the previous content |
| 8 | `process_exec "id"` | AI client | `approval_required`; after the owner approves exactly that command, output is your user, not root; a second run needs a new approval |
| 9 | `process_exec "echo API_KEY=abc123def"` (approved) | AI client | output shows `API_KEY=[REDACTED]` |
| 10 | log out and back in (or restart the Mac) | owner | device goes offline and comes back online without re-pairing |
| 11 | local mode: the `printf … list_directory …` command in [LOCAL_MODE.md](LOCAL_MODE.md) with `--allowed-root "$HOME/WECOMMANDER"` | owner, Terminal | handshake line, then the folder listing |
| 12 | uninstall: `bash /usr/local/libexec/wecommander/uninstall-macos.sh` (no sudo) | owner | LaunchAgent removed, device shows offline (binary, config and logs are kept) |

Record the agent version (`webrising-commender --version`), macOS version
and chip with the results.

## Results

**2026-11-05**, macOS 26.5.2 (Darwin 25.5.0), 8 cores, 8 GB, allowed folder
`~/Documents/WECOMMANDER` (the old default). Installed by hand from
`macos-preview-49` (the one-line installer was broken, fixed in PR #82),
then upgraded with the one-line installer to agent `0.1.58`.

| # | Result |
|---|---|
| 1–3 | PASS. Upgrade through `curl … \| sh` kept the enrollment ("Existing device enrollment found") |
| 4 | PASS: `allowedRoots` = the folder only; `outputRedaction` and `systemLogs` enabled on 0.1.58 |
| 5 | PASS: folder listed, `/etc` refused |
| 6 | open (`health_snapshot` not yet called from a client that has the new tool list) |
| 7 | PASS: write, `edit_block`, `fs_versions`, `fs_undo` restored the exact previous content |
| 8 | PASS: `id` → `approval_required`; after approval `uid=501(orhanbalci)`; the next run asked again |
| 9 | PASS: `echo API_KEY=abc123def` → `API_KEY=[REDACTED]`, `redactions: 1` |
| 10 | PASS: log out/in and the 19:27 gateway release both reconnected without re-pairing |
| 11, 12 | open |

**Findings**

- macOS asked for file access on **every** command started in
  `~/Documents/WECOMMANDER`; until the dialog was answered the command did
  not start, so early attempts ended in `device-request-timeout` or a bare
  "Bad Gateway" and spent their single-use approval. Fixed: the default
  folder is now `~/WECOMMANDER`, and the agent changes directory inside the
  shell so a pending dialog ends in a timeout that names it.
- The one-line installer picked `macos-preview-58` over `-59` (GitHub API
  order). Fixed: it now takes the highest `macos-preview` number.
- Open: when a device does not return a result, the approval is spent and
  the client only sees a timeout or "Bad Gateway". Tracked in the v1.2+ roadmap.
