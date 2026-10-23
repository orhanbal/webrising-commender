#!/usr/bin/env bash
# Non-destructive restore drill into a brand-new, temporary database.
# Never restores over commender or another existing database.
set -Eeuo pipefail
umask 077
BACKUP="${1:?Usage: scripts/test-postgres-restore.sh /path/to/backup.dump}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test -f "$BACKUP" || { echo "Backup file not found" >&2; exit 1; }
BACKUP="$(readlink -f -- "$BACKUP")"
command -v docker >/dev/null || { echo "docker required" >&2; exit 1; }
cd "$ROOT"
compose_args=()
if [[ -n "${COMMANDER_COMPOSE_FILE:-}" ]]; then compose_args+=(-f "$COMMANDER_COMPOSE_FILE"); fi
if [[ -n "${COMMANDER_COMPOSE_PROJECT:-}" ]]; then compose_args+=(-p "$COMMANDER_COMPOSE_PROJECT"); fi
compose(){ docker compose "${compose_args[@]}" "$@"; }
if ! test -f "$BACKUP.sha256"; then
 echo "Refusing restore drill without a SHA256 manifest" >&2
 exit 1
fi
if test -f "$BACKUP.sha256"; then
  (cd "$(dirname "$BACKUP")" && sha256sum -c "$(basename "$BACKUP").sha256") || exit 1
fi
compose exec -T postgres pg_restore --list < "$BACKUP" >/dev/null
DB="wc_restore_$(date -u +%Y%m%d%H%M%S)_$$"
# Untrusted input is never used as an SQL identifier.
[[ "$DB" =~ ^wc_restore_[0-9]+_[0-9]+$ ]] || exit 1
CREATED=0
cleanup(){
  if [ "$CREATED" -eq 1 ]; then
    compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U commender -d postgres -c "DROP DATABASE \"$DB\";" >/dev/null || echo "WARNING: scratch database $DB needs manual removal" >&2
  fi
}
trap cleanup EXIT
compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U commender -d postgres -c "CREATE DATABASE \"$DB\";" >/dev/null
CREATED=1
compose exec -T postgres pg_restore -U commender -d "$DB" --exit-on-error --no-owner --no-acl <"$BACKUP" >/dev/null
RESULT="$(compose exec -T postgres psql -X -At -v ON_ERROR_STOP=1 -U commender -d "$DB" -c "select count(*) from information_schema.tables where table_schema='public' and table_name in ('users','organizations');")"
if [ "$RESULT" != "2" ]; then
 echo "Restore drill failed: core tables missing" >&2
 exit 1
fi
echo "Restore drill PASS: restored and verified schema in isolated database, which will now be dropped."
