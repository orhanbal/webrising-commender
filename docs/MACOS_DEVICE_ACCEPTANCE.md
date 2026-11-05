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
password), creates `~/Documents/WECOMMANDER` as the only allowed folder, and
prints a pairing link. Open the link, approve the device in the browser, and
the agent starts as a per-user LaunchAgent.

To choose another folder: `curl -fsSL https://wecommander.app/install.sh | sh -s -- --allowed-root "$HOME/Projects/demo"` (never `/` or the whole home folder).

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
| 11 | local mode: the `printf … list_directory …` command in [LOCAL_MODE.md](LOCAL_MODE.md) with `--allowed-root "$HOME/Documents/WECOMMANDER"` | owner, Terminal | handshake line, then the folder listing |
| 12 | uninstall: `bash /usr/local/libexec/wecommander/uninstall-macos.sh` (no sudo) | owner | LaunchAgent removed, device shows offline (binary, config and logs are kept) |

Record the agent version (`webrising-commender --version`), macOS version
and chip with the results.
