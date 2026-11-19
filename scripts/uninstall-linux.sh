#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

systemctl disable --now webrising-commender.service 2>/dev/null || true
rm -f /etc/systemd/system/webrising-commender.service
# "Run as root" rule from install-linux.sh --allow-root, if any.
rm -f /etc/sudoers.d/wecommander-agent
systemctl daemon-reload

echo "Service removed."
echo "Binary /usr/local/bin/webrising-commender and agent config were NOT deleted."
