#!/usr/bin/env bash
set -euo pipefail
if (( EUID != 0 )); then
  echo "Run using sudo: sudo wecommander-setup" >&2
  exit 1
fi
BIN=/opt/wecommander/bin/webrising-commender
SCRIPT=/opt/wecommander/libexec/setup-ubuntu.sh
[[ -x "$BIN" && -f "$SCRIPT" ]] || { echo "WECOMMANDER package incomplete." >&2; exit 1; }
CHECKSUM="$(sha256sum "$BIN" | awk '{print $1}')"
exec bash "$SCRIPT" --binary "$BIN" --sha256 "$CHECKSUM" "$@"
