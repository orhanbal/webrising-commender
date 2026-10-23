#!/bin/bash
set -euo pipefail
if (($# != 3)); then echo "Usage: $0 UNIVERSAL_BINARY VERSION OUTPUT_DIR" >&2; exit 2; fi
BIN="$1"; VERSION="$2"; OUT="$3"
[[ -x "$BIN" ]] || { echo "Missing universal executable" >&2; exit 1; }
[[ "$VERSION" =~ ^[0-9][0-9.]*$ ]] || { echo "Bad pkg version" >&2; exit 1; }
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
mkdir -p "$TMP/root/usr/local/bin" "$TMP/root/usr/local/libexec/wecommander"
install -m 0755 "$BIN" "$TMP/root/usr/local/bin/webrising-commender"
install -m 0755 scripts/setup-macos.sh "$TMP/root/usr/local/bin/wecommander-setup"
install -m 0755 scripts/install-macos.sh "$TMP/root/usr/local/libexec/wecommander/install-macos.sh"
install -m 0755 scripts/uninstall-macos.sh "$TMP/root/usr/local/libexec/wecommander/uninstall-macos.sh"
pkgbuild --root "$TMP/root" --identifier tr.webrising.wecommander.agent \
 --version "$VERSION" --install-location / "$OUT/WECOMMANDER-macos-universal.pkg"
pkgutil --check-signature "$OUT/WECOMMANDER-macos-universal.pkg" || true
