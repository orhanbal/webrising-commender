#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo "Run as root." >&2; exit 1; fi
BINARY="${1:-}"
CONFIG="${2:-}"
RUN_AS_USER="${3:-${SUDO_USER:-}}"
if [[ -z "$BINARY" || -z "$CONFIG" || -z "$RUN_AS_USER" ]]; then
  echo "Usage: sudo bash install-linux.sh /path/to/webrising-commender /path/to/agent.json non-root-user" >&2
  exit 2
fi
if [[ ! "$RUN_AS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "Invalid systemd service account name." >&2; exit 2
fi
if [[ "$RUN_AS_USER" == root ]]; then
  echo "Refusing to install a root-privileged remote-control agent." >&2; exit 1
fi
BINARY="$(readlink -f -- "$BINARY")"
CONFIG="$(readlink -f -- "$CONFIG")"
test -x "$BINARY"
test -f "$CONFIG"
id "$RUN_AS_USER" >/dev/null
runuser -u "$RUN_AS_USER" -- test -r "$CONFIG" || {
  echo "Selected account cannot read the agent configuration." >&2; exit 1;
}
# Publish atomically: do not overwrite a currently executing ELF binary in place.
install -m 0755 "$BINARY" /usr/local/bin/.webrising-commender.new
mv -f /usr/local/bin/.webrising-commender.new /usr/local/bin/webrising-commender
cat >/etc/systemd/system/webrising-commender.service <<EOF
[Unit]
Description=WECOMMANDER restricted Linux agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_AS_USER
ExecStart=/usr/local/bin/webrising-commender --config "$CONFIG" run
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=full
PrivateTmp=yes
RestrictSUIDSGID=yes
CapabilityBoundingSet=
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
