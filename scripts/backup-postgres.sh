#!/usr/bin/env bash
# WECOMMANDER PostgreSQL backup — run from a trusted host with docker compose access.
# No credentials are passed as process arguments or printed.
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${BACKUP_DIR:-${ROOT}/backups}"
command -v docker >/dev/null || { echo "docker required" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum required" >&2; exit 1; }
mkdir -p -- "$DEST"
chmod 700 "$DEST"
DEST="$(cd "$DEST" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PREFIX="wecommander-${STAMP}-$$"
TMP="$(mktemp "${DEST}/.${PREFIX}.XXXXXXXX.dump")"
OUT="${DEST}/${PREFIX}.dump"
MANIFEST="${OUT}.sha256"
cleanup(){ rm -f -- "$TMP"; }
trap cleanup EXIT

cd "$ROOT"
# Exec runs inside the DB container and uses its configured internal credentials.
# -T prevents TTY bytes from corrupting the binary custom-format dump.
docker compose exec -T postgres pg_dump -U commender -d commender --format=custom --no-owner --no-acl >"$TMP"
test -s "$TMP" || { echo "empty backup refused" >&2; exit 1; }
docker compose exec -T postgres pg_restore --list <"$TMP" >/dev/null
mv -n -- "$TMP" "$OUT"
test -f "$OUT" || { echo "backup destination already exists" >&2; exit 1; }
sha256sum "$OUT" >"$MANIFEST"
chmod 600 "$OUT" "$MANIFEST"
echo "Backup validated: $OUT"
echo "SHA256 manifest: $MANIFEST"
echo "Remember: copy encrypted backups off-host; local-only backups cannot survive host failure."
