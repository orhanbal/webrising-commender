#!/usr/bin/env bash
set -euo pipefail
umask 077

OUTPUT_DIR="${1:-${BACKUP_DIR:-./backups}}"
DB_USER="${POSTGRES_USER:-commender}"
DB_NAME="${POSTGRES_DB:-commender}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-0}"

if ! [[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ && "$DB_USER" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "POSTGRES_DB and POSTGRES_USER must contain only letters, numbers or underscore." >&2
  exit 2
fi
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 2; }

compose_args=()
if [[ -n "${COMMANDER_COMPOSE_FILE:-}" ]]; then
  compose_args+=(-f "$COMMANDER_COMPOSE_FILE")
fi
if [[ -n "${COMMANDER_COMPOSE_PROJECT:-}" ]]; then
  compose_args+=(-p "$COMMANDER_COMPOSE_PROJECT")
fi

compose() {
  docker compose "${compose_args[@]}" "$@"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "sha256sum or shasum is required" >&2
    return 1
  fi
}

mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$OUTPUT_DIR/commender-$timestamp-$.dump"
partial="$archive.partial"
if [[ -e "$archive" || -e "$partial" ]]; then echo "Refusing to overwrite an existing backup." >&2; exit 1; fi
checksum_file="$archive.sha256"
manifest="$archive.manifest"

cleanup() {
  rm -f "$partial"
}
trap cleanup EXIT

echo "Creating PostgreSQL backup: $archive"
compose exec -T postgres   pg_dump -U "$DB_USER" -d "$DB_NAME"   --format=custom --no-owner --no-acl > "$partial"

if [[ ! -s "$partial" ]]; then
  echo "Backup is empty." >&2
  exit 1
fi

echo "Verifying archive structure..."
compose exec -T postgres pg_restore --list < "$partial" >/dev/null

checksum="$(sha256_file "$partial")"
bytes="$(wc -c < "$partial" | tr -d ' ')"
mv "$partial" "$archive"
printf '%s  %s\n' "$checksum" "$(basename "$archive")" > "$checksum_file"
cat > "$manifest" <<EOF
format=pg_dump_custom
created_at=$timestamp
database=$DB_NAME
user=$DB_USER
sha256=$checksum
bytes=$bytes
EOF

if [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && (( RETENTION_DAYS > 0 )); then
  echo "CAUTION: opt-in retention will remove backups older than $RETENTION_DAYS days. Ensure verified off-host copies." >&2
  while IFS= read -r -d '' old; do
    rm -f "$old" "$old.sha256" "$old.manifest"
  done < <(find "$OUTPUT_DIR" -maxdepth 1 -type f -name 'commender-*.dump' -mtime +"$RETENTION_DAYS" -print0)
fi

trap - EXIT
echo "Backup complete: $archive"
echo "SHA-256: $checksum"
