#!/bin/bash
# Packages the Management Center for Linux (tray/, Tauri + WebKitGTK) as
# WECOMMANDER-Center-linux-x86_64.tar.gz: the binary, its icon and a .desktop
# entry. scripts/install-center-macos-online.sh (center.sh) installs it for the
# current user on Linux.
# Usage: scripts/build-center-linux.sh <version> <out-dir>   (after a release build)
set -euo pipefail

VERSION="${1:?version}"
OUT="${2:?out dir}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/tray/target/release/wecommander-center"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

test -x "$BIN"
"$BIN" --version | grep -qx "WECOMMANDER Center ${VERSION}"

PKG="$WORK/wecommander-center"
mkdir -p "$PKG"
install -m 0755 "$BIN" "$PKG/wecommander-center"
install -m 0644 "$ROOT/tray/icons/icon.png" "$PKG/wecommander-center.png"
cat > "$PKG/wecommander-center.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=WECOMMANDER Center
Name[tr]=WECOMMANDER Yönetim Merkezi
Comment=Approve or deny what an AI may run on your devices
Comment[tr]=Yapay zekânın cihazlarında çalıştıracaklarını onayla veya reddet
Exec=wecommander-center
Icon=wecommander-center
Terminal=false
Categories=Utility;Security;
StartupNotify=false
X-GNOME-UsesNotifications=true
DESKTOP
echo "$VERSION" > "$PKG/VERSION"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
tar -C "$WORK" -czf "$OUT/WECOMMANDER-Center-linux-x86_64.tar.gz" wecommander-center
ls -l "$OUT/WECOMMANDER-Center-linux-x86_64.tar.gz"
