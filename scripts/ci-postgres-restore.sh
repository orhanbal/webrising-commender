#!/usr/bin/env bash
# CI-only disposable database restore drill. Never runs against production.
# Proves relational row recovery, not merely that schema objects exist.
set -Eeuo pipefail
umask 077
test "${CI:-}" = "true" || { echo "CI=true required" >&2; exit 2; }
[[ "${DATABASE_URL:-}" == 'postgres://commender:commender-test@127.0.0.1:5432/commender' ]] ||
  { echo "Refusing non-test DATABASE_URL" >&2; exit 2; }
command -v docker >/dev/null || exit 2
command -v sha256sum >/dev/null || exit 2
DIR="$(mktemp -d)"
DB="wc_ci_restore_$(date +%s)_$$"
PROBE_NAME="wc_ci_restore_probe_${DB}"
PROBE_EMAIL="${DB}@example.invalid"
[[ "$DB" =~ ^wc_ci_restore_[0-9]+_[0-9]+$ ]] || exit 2
[[ "$PROBE_NAME" =~ ^[a-z0-9_]+$ ]] || exit 2
[[ "$PROBE_EMAIL" =~ ^[a-z0-9_]+@example[.]invalid$ ]] || exit 2
CREATED=0
SEEDED=0
pgc(){
  docker run --rm --network host -e PGPASSWORD=commender-test postgres:16-alpine "$@"
}
cleanup(){
  if [ "$CREATED" = 1 ]; then
    pgc psql -X -q -h 127.0.0.1 -U commender -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE \"$DB\";" ||
      echo "WARNING: isolated scratch database cleanup failed" >&2
  fi
  if [ "$SEEDED" = 1 ]; then
    pgc psql -X -q -h 127.0.0.1 -U commender -d commender -v ON_ERROR_STOP=1 -c "DELETE FROM users WHERE email = '$PROBE_EMAIL'; DELETE FROM organizations WHERE name = '$PROBE_NAME';" ||
      echo "WARNING: disposable CI sentinel cleanup failed" >&2
  fi
  rm -rf -- "$DIR"
}
trap cleanup EXIT

# CI's own disposable source database receives an inert relational fixture.
# A schema-only restore could previously pass with zero actual business rows.
SEEDED=1
pgc psql -X -q -h 127.0.0.1 -U commender -d commender -v ON_ERROR_STOP=1 -c "
  INSERT INTO organizations(name) VALUES ('$PROBE_NAME');
  INSERT INTO users(email,password_hash) VALUES ('$PROBE_EMAIL','ci-inert-non-login');
  INSERT INTO organization_members(organization_id,user_id,role)
    SELECT o.id,u.id,'viewer' FROM organizations o CROSS JOIN users u
    WHERE o.name='$PROBE_NAME' AND u.email='$PROBE_EMAIL';
" >/dev/null

pgc pg_dump -h 127.0.0.1 -U commender -d commender -Fc --no-acl --no-owner > "$DIR/acceptance.dump"
test -s "$DIR/acceptance.dump"
(cd "$DIR" && sha256sum acceptance.dump > acceptance.dump.sha256 && sha256sum -c acceptance.dump.sha256 >/dev/null)
docker run --rm -i --network host postgres:16-alpine pg_restore --list < "$DIR/acceptance.dump" >/dev/null

# A changed archive must be rejected by the checksum gate before restore.
cp -- "$DIR/acceptance.dump" "$DIR/tampered.dump"
(cd "$DIR" && sha256sum tampered.dump > tampered.dump.sha256)
printf 'ci-corruption' >> "$DIR/tampered.dump"
if (cd "$DIR" && sha256sum -c tampered.dump.sha256 >/dev/null 2>&1); then
  echo "Corrupted archive passed SHA-256 integrity check" >&2
  exit 1
fi

# Remove the fixture from the source *before* restore: the restored row must
# come from the dump, not from a query accidentally hitting the source DB.
pgc psql -X -q -h 127.0.0.1 -U commender -d commender -v ON_ERROR_STOP=1 -c "
  DELETE FROM users WHERE email='$PROBE_EMAIL';
  DELETE FROM organizations WHERE name='$PROBE_NAME';
" >/dev/null
pgc psql -X -q -h 127.0.0.1 -U commender -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB\";" >/dev/null
CREATED=1
docker run --rm -i --network host -e PGPASSWORD=commender-test postgres:16-alpine pg_restore -h 127.0.0.1 -U commender -d "$DB" --exit-on-error --no-owner --no-acl < "$DIR/acceptance.dump" >/dev/null

TABLES="$(pgc psql -X -At -h 127.0.0.1 -U commender -d "$DB" -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('users','organizations','organization_members');")"
test "$TABLES" = "3"
ROWS="$(pgc psql -X -At -h 127.0.0.1 -U commender -d "$DB" -v ON_ERROR_STOP=1 -c "
  SELECT count(*) FROM organization_members m
  JOIN organizations o ON o.id=m.organization_id
  JOIN users u ON u.id=m.user_id
  WHERE o.name='$PROBE_NAME' AND u.email='$PROBE_EMAIL' AND m.role='viewer';
")"
test "$ROWS" = "1" || { echo "Relational fixture was not recovered from archive" >&2; exit 1; }
SOURCE_ROWS="$(pgc psql -X -At -h 127.0.0.1 -U commender -d commender -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM organizations WHERE name='$PROBE_NAME';")"
test "$SOURCE_ROWS" = "0" || { echo "Disposable source sentinel was not removed" >&2; exit 1; }
echo "WECOMMANDER CI backup/restore PASS (isolated scratch DB; relational data roundtrip; checksum corruption rejected)"
