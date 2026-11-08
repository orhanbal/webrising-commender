# WECOMMANDER — Database backup and recovery runbook

The production database is **PostgreSQL inside the WECOMMANDER Docker Compose application**. Its existing Coolify named volume is not an off-site backup and must not be mistaken for a recovery copy.

## Preconditions

- Authorized operator on the production host with Docker/Compose privileges.
- Source checkout containing the exact production Compose file and this repository's scripts.
- An encrypted backup destination off the production server, with tested access controls.
- Do **not** stop/recreate the database container or modify production volumes for a routine backup.
- **Never share passwords, database dumps, secret keys or backup contents in chat or GitHub.**

The canonical backup script is `scripts/backup-compose.sh`. It produces a private custom-format dump, validates archive structure, writes SHA-256 and a manifest. Existing archives are kept by default; delete/retention only occurs with an explicitly provided positive `BACKUP_RETENTION_DAYS`.

### Produce a backup

From the source checkout on the authorized host:

```bash
umask 077
BACKUP_DIR=/path/to/private/encrypted-backup-volume \
  COMMANDER_COMPOSE_PROJECT=<actual-compose-project> \
  bash scripts/backup-compose.sh
```

If Coolify used a non-default Compose file, set `COMMANDER_COMPOSE_FILE` as well. Do not guess the Compose project: verify it on the host first.

### Test recovery without touching production

```bash
bash scripts/test-postgres-restore.sh /path/to/private/commender-YYYYMMDDTHHMMSSZ-NNN.dump
```

The drill checks the SHA-256 manifest, creates a new uniquely named scratch database **inside the same PostgreSQL server**, restores the dump there, checks `users` and `organizations` tables, and removes only that scratch database. It never drops/recreates the live `commender` database.

For an independent CI safety signal, `scripts/ci-postgres-restore.sh` is run against CI's disposable PostgreSQL service after integration acceptance. This is **not** proof of actual production recoverability.

### Disaster recovery procedure (authorization required)

The existing `scripts/restore-compose.sh` is destructive: it stops the gateway, drops and recreates the named live database, and requires `COMMANDER_RESTORE_CONFIRM=RESTORE`. **Only run it after operator approval, a verified off-host archive, maintenance announcement and a recovery decision.** Do not execute it during normal deployments.

### Outstanding production acceptance

- Verify backup files are written on a durable encrypted destination outside the application volume.
- Verify full scratch restore in the authorized production environment.
- Verify off-host copy and restoration from a separately stored archive.
- Set up a scheduled backup with monitoring and non-secret alerts; confirm a failure produces an alert.
- Periodically confirm restoration after schema changes.
- Record the last successful backup/restore timestamps without exposing file contents.

**Status:** scripts and CI drill code available. Actual production recovery and off-host retention are pending operator-level server access and a successful on-host test.

### 30 October 2026 — CI relational recovery acceptance

The disposable CI drill now seeds an inert organization, user and membership, removes those rows from its source after the dump, restores into a separate scratch database and verifies the relationship survived. A modified copy of the archive must fail the SHA-256 checksum check before restore. [Code CI #41045386900](https://github.com/orhanbal/webrising-commender/actions/runs/41045386900) passed the integration drill. The SHA-256 manifest detects accidental corruption but is **not** an authenticated signature. This does **not** establish production backup freshness, off-host retention, recovery point/time objectives, or real operator restore acceptance; all remain PENDING.

### 8 November 2026 — production scratch restore drill: PASSED

Run by the owner on the production host (`148-135-181-148`, Coolify `localhost`) as root, against the live Compose PostgreSQL container `postgres-u5mlu98kqroo7w68zoa0syac-20261108T175612` (application `webrising-commender`, UUID `u5mlu98kqroo7w68zoa0syac`). Commands used, all inside the container, never touching the live database:

1. `pg_dump -U commender -d commender -Fc -f /tmp/drill.dump` → 134296 bytes, SHA-256 `cfe5badda0c9c9ccc338fbfc036d99eef824f3d9a2451d2fde887e22a3eddf3d`.
2. `createdb restore_drill_20261108T180540Z` and `pg_restore --no-owner` into it → completed without errors.
3. Row counts, live vs. restored copy (users, organizations, devices, audit_logs): `1 | 2 | 4 | 1080` and `1 | 2 | 4 | 1080` — identical.
4. `dropdb` of the scratch database and removal of the dump file.

Result: a full logical backup of production restores into a separate database with identical contents (recovery point = the moment of the dump). **Still open:** a scheduled, monitored backup written off-host (encrypted) and a restore from that off-host copy; this drill kept the dump inside the container and deleted it.
