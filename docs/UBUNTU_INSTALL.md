# WECOMMANDER — Ubuntu 24.04 terminal agent installation

Status: automated Linux CI must pass, followed by **real Ubuntu server acceptance**. Never call production remote operation accepted solely on successful packaging.

## What the terminal installer does

- Keeps WECOMMANDER Gateway separate from the remote device. The server acts only as an outbound agent; **no inbound SSH or HTTP port** is added by WECOMMANDER.
- Verifies the pre-built Linux executable against a supplied SHA-256 value before installation.
- Creates an unprivileged `wecommander` Linux system identity and a dedicated accessible directory `/var/lib/webrising-commender/workspace`; does not grant `sudo`, Docker group membership or root access.
- Starts device linking with `/api/device-link/start`. Prints the URL `https://wecommander.webrising.tr/connect-device?requestId=...` to paste into **your own computer's browser**, signs in with the regular WECOMMANDER account, selects the workspace, and confirms.
- Redeems that approval using a secret kept only in the terminal process; the service config `/var/lib/webrising-commender/agent.json` is written as `wecommander` with user-only read/write permissions.
- Enables `webrising-commender.service` for boot, with `User=wecommander`, `NoNewPrivileges=yes`, no capabilities, and `ProtectSystem=full`.
- If already enrolled, **reuses the existing device identity**, avoiding a second cloud device entry.

**Security:** This service runs commands only with the Unix permissions of `wecommander`. Path policy restricts file operations, but commands may still read files accessible to this account: grant the account access only to intended data. Never install the agent with `root`, `/root` or Docker group membership. A production server should start with an isolated workspace and only add narrow ACLs after explicit review.

## Obtain the checked build (no Rust compilation required on server)

There is currently **no published GitHub Release**. Use a successful GitHub Actions CI artifact until a release is published.

1. On your own computer, open [GitHub Actions](https://github.com/orhanbal/webrising-commender/actions/workflows/ci.yml), open the newest *successful* run, and download the artifact **WECOMMANDER-linux-x64-acceptance** (for Ubuntu x86-64).
2. Extract the ZIP. Its files include `webrising-commender`, `SHA256SUMS.txt`, `setup-ubuntu.sh` and `install-linux.sh`.
3. Copy the extracted files to a private staging directory on your Ubuntu server. For example, from PowerShell/SSH with a directory named `wecommander-linux`:

```powershell
scp -r .\wecommander-linux root@YOUR_SERVER:/root/wecommander-linux
```

## Install through SSH on the Ubuntu machine

```bash
cd /root/wecommander-linux
sha256sum -c SHA256SUMS.txt
chmod +x ./webrising-commender
sha256="$(awk '$2 == "webrising-commender" { print $1 }' SHA256SUMS.txt)"
sudo bash ./setup-ubuntu.sh --binary "$PWD/webrising-commender" --sha256 "$sha256"
```

The terminal prints an approval URL. Open **that precise URL on your computer**, sign in to your WECOMMANDER account, choose your workspace and approve the server. Do not enter your account password into the Ubuntu terminal. The URL contains the public request ID only; the actual redemption secret stays on the SSH terminal.

The default allowed folder is `/var/lib/webrising-commender/workspace`. Do not initially choose `/`, `/root`, `/etc` or `/data`. A narrow custom folder may be specified using `--allowed-root` only after the Linux service account can actually access it.

## Verify and manage

```bash
sudo systemctl is-active webrising-commender
sudo systemctl status webrising-commender --no-pager
sudo journalctl -u webrising-commender -n 30 --no-pager
```

In the WECOMMANDER dashboard open **Devices**. The new Linux host should show **Online**. Try a read-only `whoami` remote command; it must return `wecommander`, not `root`. Test file listing only within `/var/lib/webrising-commender/workspace`.

The agent automatically reconnects on transient network failures. Verify this and system boot behavior separately; tests on a CI runner are not equivalent to a real Ubuntu installation.

## Update and removal

- The same script recognizes an existing `agent.json` and uses it rather than creating a new identity. Update the verified binary with the same command. systemd restarts against the new binary.
- `sudo bash ./uninstall-linux.sh` removes the service only; the executable and device config are intentionally preserved until you explicitly revoke the device in the WECOMMANDER dashboard.
- For sensitive hosts, back up the device authorization file securely. Never paste its contents into a chat or terminal log.
