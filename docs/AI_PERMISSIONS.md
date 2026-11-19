# AI permissions per device

What an AI client may do on an agent device over MCP is set per device, in the
web panel under **Devices > AI permissions** (admins only, browser session).
The Windows and macOS apps show the current state and open that page. AI
clients (API tokens, OAuth) can never change any of these settings.

| Setting | Values | Default | Widening needs |
|---|---|---|---|
| Trust | `strict`, `standard`, `full` | `standard` | `full`: current password |
| Time limit for `full` | 1 h … 7 days, or no limit | 1 h in the UI | (part of `full`) |
| Run as | `user`, `root` | `user` | password **and** the machine owner's consent (below) |
| Safety net | on, off | on | off: current password |
| Safety net allows shutdown/reboot | on, off | off | on: current password |

Every change is written to the audit log (`device.trust_level`,
`device.run_as`, `device.safety_net`) and every widening is e-mailed to all
admins and owners. Narrowing (back to standard, back to user, safety net on)
needs no password.

## Trust

- **strict**: every high-risk call waits for a human approval; the command
  allowlist is not used.
- **standard**: `process_exec` commands on the device's allowlist run without
  approval (`command-allowlist-rules.ts`); every other high-risk call waits for
  an approval.
- **full**: no per-call approval for any high-risk tool on the device,
  including `docker_container_action` and `scheduled_task_create/update/
  delete/run_now` for tasks that run on that device. WECOMMANDER's own
  containers are still never stopped or restarted, SSH targets and SSH
  scheduled tasks still need an approval every time, and the safety net
  still applies. `full` can be time-limited (`PUT /api/devices/:id/trust`
  with `minutes`, 5–10080) or left without a limit (omit `minutes`); an
  expired `full` returns to `standard` (audited, actor `system`).

Autonomous mode (`POST /api/trust/autonomy`) sets `full` on many devices at
once; see SECURITY.md.

## Run as root (two keys)

By default the agent runs as a normal (non-root) service account, and so do
the commands, tasks, terminals and file writes an AI starts. Running them as
root needs **both**:

1. **The machine owner, on the machine, once:**

   ```bash
   sudo bash install-linux.sh --allow-root      # existing install or with the usual arguments
   sudo bash install-linux.sh --disallow-root   # undo
   ```

   This writes `/etc/sudoers.d/wecommander-agent`
   (`<service user> ALL=(ALL) NOPASSWD:ALL`, validated with `visudo -cf`,
   mode 0440), drops the systemd hardening that blocks sudo
   (`NoNewPrivileges`, `CapabilityBoundingSet=`, `RestrictSUIDSGID`,
   `ProtectSystem=full`) and records the ceiling in the agent config
   (`capabilities.allowRoot`, also `webrising-commender capabilities
   --allow-root on|off`). The agent then reports `root_capable: true` when it
   connects (ceiling set and `sudo -n true` works, or the agent already runs
   as root). `uninstall-linux.sh` removes the drop-in.
2. **An admin, in the web panel:** run as **root** for that device
   (`PUT /api/devices/:id/run-as {runAs, currentPassword}`). Refused with
   `409 device_not_root_capable` (and the install command) while the agent
   does not report `root_capable`.

A web click alone can therefore never give root on a server, and the agent
enforces its half too: the gateway sends `runAs: "root"` inside the signed
action (so an approval binds it), and the agent refuses a root action unless
its local ceiling allows it **and** a gateway-signed approval of that exact
root action comes with it, whatever the action's risk. When the ceiling is
removed, the next connection reports `root_capable: false`, the device falls
back to `user` (audited `ceiling_removed`), and a call made in between is
refused with `run_as_root_unavailable` rather than run as the user.

As root:

- `process_exec` and `task_start` run `sudo -n -- /bin/sh -lc <command>`
  (on Linux the agent's reaper runs under sudo, so a timeout or cancel still
  ends the whole process tree); `terminal_start` starts `sudo -n -- <shell>`.
- `fs_write`: a file the service user cannot write is written with
  `sudo -n tee -- <path>` (an existing file keeps its owner and mode; no undo
  snapshot then). File tools stay limited to the allowed folders; there is no
  "all folders" option.
- Server tools (cleanup, process signal, restart, Docker) already escalate
  with `sudo -n` when it works; nothing changed there.
- Scheduled task runs keep running as the service user.
- Windows: not supported (refused).

`targets_list` and `devices_list` show `trust`, `run_as`, `root_capable` and
`safety_net` per device, and the descriptions of the command tools say so, so
the AI knows whether it is root. Audit rows of AI calls and approval e-mails
record `runAs`.

## Safety net

On by default. It refuses a short list of catastrophic commands on every trust
level and run_as, even with a human approval (`gateway/src/safety-net.ts`,
checked for `process_exec`, `task_start`, `terminal_input` and scheduled-task
commands; `safety_net_blocked` with the rule):

- `rm` with a recursive flag on `/`, `/*`, a top-level system folder (`/etc`,
  `/usr`, `/var`, `/home`, … and their `/*`) or the home folder, or with
  `--no-preserve-root`; `chmod/chown/chgrp -R` on `/`;
- `mkfs*`, `mke2fs`, `mkswap`, `wipefs`, `blkdiscard` on a `/dev/` device;
  `dd of=`, `shred` or a redirection onto a whole disk (`/dev/sda`,
  `/dev/nvme0n1`, `/dev/vda`, …);
- fork bombs (`:(){ :|:& };:` and renamed variants);
- `shutdown`, `reboot`, `poweroff`, `halt`, `systemctl reboot|poweroff|…`,
  `init 0|6`, unless "allow shutdown and reboot" is on;
- stopping, disabling, masking or deleting the agent's own service, binary or
  sudoers rule.

It sees through `sudo`, `env`, `nohup`, `timeout`, `sh -c "…"`, `eval`,
`$(…)` and backticks, and passes ordinary work (`rm -rf ./build`,
`rm -rf /var/www/old`, `dd if=/dev/zero of=disk.img`, `systemctl restart`).
It is a guard against slips, not a sandbox: someone with root and the safety
net on can still find other ways to break a machine.

Turning it off (`PUT /api/devices/:id/safety-net {enabled:false,
currentPassword}`) or allowing power commands (`allowPower: true`) needs the
password; turning it back on does not.
