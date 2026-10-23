#!/usr/bin/env bash
set -euo pipefail
if (($# != 3)); then
  echo "Usage: $0 /path/to/webrising-commender VERSION OUTPUT_DIRECTORY" >&2; exit 2
fi
BIN="$(readlink -f -- "$1")"
VER="$2"
OUT="$3"
[[ -x "$BIN" ]] || { echo "Missing executable: $BIN" >&2; exit 1; }
[[ "$VER" =~ ^[0-9][0-9a-z.+~-]*$ ]] || { echo "Invalid Debian version" >&2; exit 1; }
command -v dpkg-deb >/dev/null
mkdir -p "$OUT"
OUT="$(readlink -f -- "$OUT")"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
PKG="$WORK/pkg"
install -d -m 0755 "$PKG/DEBIAN" "$PKG/opt/wecommander/bin" "$PKG/opt/wecommander/libexec" "$PKG/usr/bin"
install -m 0755 "$BIN" "$PKG/opt/wecommander/bin/webrising-commender"
for script in setup-ubuntu.sh install-linux.sh uninstall-linux.sh; do
  install -m 0755 "scripts/$script" "$PKG/opt/wecommander/libexec/$script"
done
install -m 0755 scripts/wecommander-setup-wrapper.sh "$PKG/usr/bin/wecommander-setup"
cat >"$PKG/DEBIAN/control" <<EOF
Package: wecommander-agent
Version: $VER
Section: admin
Priority: optional
Architecture: amd64
Maintainer: WebRising <support@webrising.tr>
Depends: ca-certificates, curl, python3, systemd, util-linux, coreutils
Description: WECOMMANDER restricted remote management agent
 Remote server management agent with browser-based enrollment and
 a non-root systemd service. Installation does not enroll a device.
EOF
cat >"$PKG/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = configure ]; then
  echo "WECOMMANDER package installed. Run: sudo wecommander-setup"
  echo "The agent remains inactive until the account owner approves enrollment."
fi
EOF
cat >"$PKG/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = remove ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now webrising-commender.service 2>/dev/null || true
  fi
  if [ -f /usr/local/bin/webrising-commender ] &&
     cmp -s /usr/local/bin/webrising-commender /opt/wecommander/bin/webrising-commender; then
    rm -f /usr/local/bin/webrising-commender
  fi
fi
EOF
chmod 0755 "$PKG/DEBIAN/postinst" "$PKG/DEBIAN/prerm"
dpkg-deb --root-owner-group --build "$PKG" "$OUT/wecommander-agent_${VER}_amd64.deb"
dpkg-deb --info "$OUT/wecommander-agent_${VER}_amd64.deb"
