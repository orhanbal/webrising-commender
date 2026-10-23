#!/usr/bin/env bash
# CI-only disposable database restore drill. Never runs against production.
set -Eeuo pipefail
test "${CI:-}" = "true" || { echo "CI=true required" >&2; exit 2; }
[[ "${DATABASE_URL:-}" == 'postgres://commender:commender-test@127.0.0.1:5432/commender' ]] ||
  { echo "Refusing non-test DATABASE_URL" >&2; exit 2; }
command -v docker >/dev/null || exit 2
DIR="$(mktemp -d)"
DB="wc_ci_restore_$(date +%s)_$$"
CREATED=0
pgc(){
  docker run --rm --network host -e PGPASSWORD=commender-test postgres:16-alpine "$@"
}
cleanup(){
  if [ "$CREATED" = 1 ]; then
    pgc psql -X -q -h 127.0.0.1 -U commender -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE \"$DB\";" || true
  fi
  rm -rf "$DIR"
}
trap cleanup EXIT
pgc pg_dump -h 127.0.0.1 -U commender -d commender -Fc --no-acl --no-owner > "$DIR/acceptance.dump"
test -s "$DIR/acceptance.dump"
docker run --rm -i --network host postgres:16-alpine pg_restore --list < "$DIR/acceptance.dump" >/dev/null
pgc psql -X -q -h 127.0.0.1 -U commender -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB\";" >/dev/null
CREATED=1
docker run --rm -i --network host -e PGPASSWORD=commender-test postgres:16-alpine pg_restore -h 127.0.0.1 -U commender -d "$DB" --exit-on-error --no-owner --no-acl < "$DIR/acceptance.dump" >/dev/null
ROWS="$(pgc psql -X -At -h 127.0.0.1 -U commender -d "$DB" -v ON_ERROR_STOP=1 -c "select count(*) from information_schema.tables where table_schema='public' and table_name in ('users','organizations');")"
test "$ROWS" = "2"
echo "WECOMMANDER CI backup/restore PASS (isolated scratch database)"
