#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

BINARY="${1:-}"
CONFIG="${2:-}"
RUN_AS_USER="${3:-${SUDO_USER:-}}"

if [[ -z "$BINARY" || -z "$CONFIG" ]]; then
  echo "Usage: $0 /path/to/webrising-commender /path/to/agent.json [run-as-user]" >&2
  exit 1
fi

if [[ -z "$RUN_AS_USER" ]]; then
  echo "Refusing to guess a service account. Supply a non-root run-as-user as the third argument." >&2
  exit 1
fi

if [[ "$RUN_AS_USER" == "root" && "${COMMANDER_ALLOW_ROOT:-0}" != "1" ]]; then
  echo "Refusing to run the agent as root implicitly." >&2
  echo "Use a non-root service account, or set COMMANDER_ALLOW_ROOT=1 and pass root explicitly." >&2
  exit 1
fi

BINARY="$(readlink -f "$BINARY")"
CONFIG="$(readlink -f "$CONFIG")"

test -x "$BINARY"
test -f "$CONFIG"
id "$RUN_AS_USER" >/dev/null

install -m 0755 "$BINARY" /usr/local/bin/webrising-commender

cat >/etc/systemd/system/webrising-commender.service <<EOF
[Unit]
Description=WebRising Commender Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_AS_USER
ExecStart=/usr/local/bin/webrising-commender --config $CONFIG run
Restart=always
RestartSec=5
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now webrising-commender.service
systemctl --no-pager --full status webrising-commender.service || true
