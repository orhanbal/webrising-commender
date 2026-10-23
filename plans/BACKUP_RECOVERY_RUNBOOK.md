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
