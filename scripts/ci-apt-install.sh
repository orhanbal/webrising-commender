#!/bin/bash
# CI: install Ubuntu packages without hanging. A stalled mirror or a dpkg
# lock held by the runner's own updates once kept a job waiting for over
# 40 minutes; here every network wait and the lock wait are bounded and the
# whole install is retried.
# Usage: scripts/ci-apt-install.sh <package>...
set -uo pipefail
# The runner's Azure mirror sometimes stalls on every package (20 s per
# file, so a large install never finishes). Put the main Ubuntu archive
# first in the runner's mirror list and keep the Azure mirror as fallback.
mirrors=/etc/apt/apt-mirrors.txt
if [ -f "$mirrors" ]; then
  printf 'http://archive.ubuntu.com/ubuntu/\tpriority:1\nhttp://azure.archive.ubuntu.com/ubuntu/\tpriority:2\nhttp://security.ubuntu.com/ubuntu/\tpriority:3\n' \
    | sudo tee "$mirrors" >/dev/null
fi
opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o DPkg::Lock::Timeout=180)
for attempt in 1 2 3; do
  if timeout 420 sudo apt-get "${opts[@]}" update \
     && timeout 600 sudo DEBIAN_FRONTEND=noninteractive apt-get "${opts[@]}" install -y "$@"; then
    exit 0
  fi
  echo "apt attempt $attempt failed; retrying" >&2
  sleep 20
done
exit 1
