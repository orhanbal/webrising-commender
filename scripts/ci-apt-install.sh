#!/bin/bash
# CI: install Ubuntu packages without hanging. A stalled mirror or a dpkg
# lock held by the runner's own updates once kept a job waiting for over
# 40 minutes; here every network wait and the lock wait are bounded and the
# whole install is retried.
# Usage: scripts/ci-apt-install.sh <package>...
set -uo pipefail
# Ubuntu's own archive and the runner's Azure mirror sometimes stall from
# GitHub runners (every file times out, so a large install never ends).
# Point every Ubuntu source at one mirror list with several independent
# mirrors, so apt moves on to the next one when a mirror does not answer
# (no per-mirror retries: a stalled mirror costs one 15 s timeout per file).
mirrors=/etc/apt/apt-mirrors.txt
printf '%s\tpriority:%s\n' \
  http://mirrors.edge.kernel.org/ubuntu/ 1 \
  http://azure.archive.ubuntu.com/ubuntu/ 2 \
  http://archive.ubuntu.com/ubuntu/ 3 \
  http://mirror.math.princeton.edu/pub/ubuntu/ 4 | sudo tee "$mirrors" >/dev/null
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do
  [ -f "$f" ] || continue
  sudo sed -i -E "s#(mirror\+file:[^ ]*|https?://(azure\.)?archive\.ubuntu\.com/ubuntu/?|https?://security\.ubuntu\.com/ubuntu/?)#mirror+file:$mirrors#g" "$f"
done
opts=(-o Acquire::Retries=0 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=30 -o DPkg::Lock::Timeout=180)
for attempt in 1 2 3; do
  if timeout 420 sudo apt-get "${opts[@]}" update \
     && timeout 600 sudo DEBIAN_FRONTEND=noninteractive apt-get "${opts[@]}" install -y "$@"; then
    exit 0
  fi
  echo "apt attempt $attempt failed; retrying" >&2
  sleep 20
done
exit 1
