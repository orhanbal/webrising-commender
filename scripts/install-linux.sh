#!/usr/bin/env bash
# Installs the WECOMMANDER agent as a systemd service running as a normal
# (non-root) account.
#
#   sudo bash install-linux.sh /path/to/webrising-commender /path/to/agent.json non-root-user [--allow-root]
#   sudo bash install-linux.sh --allow-root      # on an existing install
#   sudo bash install-linux.sh --disallow-root   # on an existing install
#
# --allow-root is the machine owner's half of "run as root" (two keys, see
# docs/AI_PERMISSIONS.md): it adds /etc/sudoers.d/wecommander-agent
# (<service user> ALL=(ALL) NOPASSWD:ALL, checked with visudo -cf, mode 0440),
# drops the unit's no-new-privileges hardening that would stop sudo, and sets
# the ceiling in the agent config. An admin must still turn "run as root" on
# for the device in the web panel, with their password. --disallow-root
# removes all of it again; the agent then reports that root is unavailable.
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo "Run as root." >&2; exit 1; fi

ROOT_MODE=keep
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --allow-root) ROOT_MODE=allow ;;
    --disallow-root) ROOT_MODE=disallow ;;
    --*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

UNIT=/etc/systemd/system/webrising-commender.service
SUDOERS=/etc/sudoers.d/wecommander-agent
BIN=/usr/local/bin/webrising-commender

BINARY="${POSITIONAL[0]:-}"
CONFIG="${POSITIONAL[1]:-}"
RUN_AS_USER="${POSITIONAL[2]:-${SUDO_USER:-}}"
REINSTALL=1
if [[ ${#POSITIONAL[@]} -eq 0 && "$ROOT_MODE" != keep ]]; then
  # Re-run on an existing install: take the account and config from the unit.
  if [[ ! -f "$UNIT" ]]; then
    echo "No existing install ($UNIT). Give the binary, config and account too." >&2; exit 2
  fi
  REINSTALL=0
  RUN_AS_USER="$(sed -n 's/^User=//p' "$UNIT" | head -n1)"
  CONFIG="$(sed -n 's/^ExecStart=.* --config "\(.*\)" run$/\1/p' "$UNIT" | head -n1)"
  BINARY="$BIN"
  if [[ -z "$RUN_AS_USER" || -z "$CONFIG" ]]; then
    echo "Cannot read the account or config from $UNIT." >&2; exit 1
  fi
fi
if [[ -z "$BINARY" || -z "$CONFIG" || -z "$RUN_AS_USER" ]]; then
  echo "Usage: sudo bash install-linux.sh /path/to/webrising-commender /path/to/agent.json non-root-user [--allow-root]" >&2
  echo "   or: sudo bash install-linux.sh --allow-root | --disallow-root   (existing install)" >&2
  exit 2
fi
if [[ ! "$RUN_AS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "Invalid systemd service account name." >&2; exit 2
fi
if [[ "$RUN_AS_USER" == root ]]; then
  echo "Refusing to install a root-privileged remote-control agent. Use a normal account; --allow-root lets it use sudo when an admin turns root on." >&2; exit 1
fi
BINARY="$(readlink -f -- "$BINARY")"
CONFIG="$(readlink -f -- "$CONFIG")"
test -x "$BINARY"
test -f "$CONFIG"
id "$RUN_AS_USER" >/dev/null
runuser -u "$RUN_AS_USER" -- test -r "$CONFIG" || {
  echo "Selected account cannot read the agent configuration." >&2; exit 1;
}

# A fresh install without a flag keeps an existing root choice only if the
# sudoers drop-in is already there.
if [[ "$ROOT_MODE" == keep ]]; then
  if [[ -f "$SUDOERS" ]]; then ROOT_MODE=allow; else ROOT_MODE=disallow; fi
fi

if [[ "$REINSTALL" == 1 ]]; then
  # Publish atomically: do not overwrite a currently executing ELF binary in place.
  install -m 0755 "$BINARY" /usr/local/bin/.webrising-commender.new
  mv -f /usr/local/bin/.webrising-commender.new "$BIN"
fi

if [[ "$ROOT_MODE" == allow ]]; then
  command -v visudo >/dev/null || { echo "sudo/visudo is not installed; cannot allow root." >&2; exit 1; }
  TMP="$(mktemp)"
  trap 'rm -f "$TMP"' EXIT
  {
    echo "# WECOMMANDER agent: run as root (install-linux.sh --allow-root)."
    echo "# Used only when an admin turns \"run as root\" on for this device."
    echo "# Remove with: sudo bash install-linux.sh --disallow-root"
    echo "Defaults:$RUN_AS_USER !requiretty, umask=0022, umask_override"
    echo "$RUN_AS_USER ALL=(ALL) NOPASSWD:ALL"
  } >"$TMP"
  visudo -cf "$TMP" >/dev/null || { echo "The sudoers rule did not validate; nothing changed." >&2; exit 1; }
  install -o root -g root -m 0440 "$TMP" "$SUDOERS"
  rm -f "$TMP"
  trap - EXIT
  CEILING=on
  # sudo must be able to gain privileges inside the service.
  HARDENING="ProtectSystem=no"
else
  rm -f "$SUDOERS"
  CEILING=off
  HARDENING="NoNewPrivileges=yes
ProtectSystem=full
RestrictSUIDSGID=yes
CapabilityBoundingSet="
fi
# The agent's own record of the ceiling (it also checks that sudo works).
# The sudoers drop-in above is the real gate: without it sudo -n fails.
if ! runuser -u "$RUN_AS_USER" -- "$BIN" --config "$CONFIG" capabilities --allow-root "$CEILING" >/dev/null; then
  echo "Warning: could not record the root ceiling in $CONFIG (the service account must be able to write it)." >&2
  echo "Run: sudo -u $RUN_AS_USER $BIN --config $CONFIG capabilities --allow-root $CEILING" >&2
fi

cat >"$UNIT" <<EOF
[Unit]
Description=WECOMMANDER restricted Linux agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_AS_USER
ExecStart=$BIN --config "$CONFIG" run
Restart=always
RestartSec=5
$HARDENING
PrivateTmp=yes
UMask=0077
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable webrising-commender.service >/dev/null
systemctl restart webrising-commender.service
sleep 2
if ! systemctl is-active --quiet webrising-commender.service; then
  echo "Agent service failed to start. Inspect: sudo journalctl -u webrising-commender -n 30 --no-pager" >&2
  exit 1
fi
echo "WECOMMANDER systemd service: active (account=$RUN_AS_USER)"
if [[ "$CEILING" == on ]]; then
  echo "Run as root: allowed on this machine. An admin must still turn it on for this device in the web panel (Devices > AI permissions)."
else
  echo "Run as root: not allowed on this machine (default)."
fi
