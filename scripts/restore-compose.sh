#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${1:-}"
CONFIRM="${COMMANDER_RESTORE_CONFIRM:-}"
DB_USER="${POSTGRES_USER:-commender}"
DB_NAME="${POSTGRES_DB:-commender}"
HEALTH_ATTEMPTS="${RESTORE_HEALTH_ATTEMPTS:-60}"

if [[ -z "$ARCHIVE" ]]; then
  echo "Usage: COMMANDER_RESTORE_CONFIRM=RESTORE bash scripts/restore-compose.sh <backup.dump>" >&2
  exit 2
fi
if [[ "$CONFIRM" != "RESTORE" ]]; then
  echo "Restore is destructive. Set COMMANDER_RESTORE_CONFIRM=RESTORE." >&2
  exit 2
fi
if ! [[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ && "$DB_USER" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "POSTGRES_DB and POSTGRES_USER must contain only letters, numbers or underscore." >&2
  exit 2
fi
if [[ ! -r "$ARCHIVE" ]]; then
  echo "Backup not readable: $ARCHIVE" >&2
  exit 2
fi
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 2; }

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

checksum_file="$ARCHIVE.sha256"
if [[ ! -r "$checksum_file" ]]; then
  echo "Checksum file missing: $checksum_file" >&2
  exit 2
fi

expected="$(awk '{print $1}' "$checksum_file" | head -n1)"
actual="$(sha256_file "$ARCHIVE")"
if [[ -z "$expected" || "$expected" != "$actual" ]]; then
  echo "Backup checksum mismatch." >&2
  echo "Expected: $expected" >&2
  echo "Actual:   $actual" >&2
  exit 1
fi

echo "Validating pg_dump archive before stopping the gateway..."
docker compose exec -T postgres pg_restore --list < "$ARCHIVE" >/dev/null

echo "Stopping gateway for consistent destructive restore..."
docker compose stop gateway

echo "Terminating database sessions..."
docker compose exec -T postgres psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1   -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DB_NAME' and pid<>pg_backend_pid();" >/dev/null

echo "Recreating database $DB_NAME..."
docker compose exec -T postgres dropdb --if-exists --force -U "$DB_USER" "$DB_NAME"
docker compose exec -T postgres createdb -U "$DB_USER" -O "$DB_USER" "$DB_NAME"

echo "Restoring archive..."
if ! docker compose exec -T postgres   pg_restore -U "$DB_USER" -d "$DB_NAME"   --no-owner --no-acl --exit-on-error < "$ARCHIVE"; then
  echo "Restore failed. Gateway intentionally remains stopped." >&2
  exit 1
fi

echo "Starting gateway..."
docker compose start gateway

echo "Waiting for gateway health..."
for ((i=1; i<=HEALTH_ATTEMPTS; i++)); do
  if docker compose exec -T gateway node -e     "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"     >/dev/null 2>&1; then
    echo "Restore complete and gateway healthy."
    exit 0
  fi
  sleep 1
done

echo "Restore completed, but gateway did not become healthy. Inspect docker compose logs." >&2
exit 1
