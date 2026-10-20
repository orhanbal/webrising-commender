#!/usr/bin/env bash
# Verify a PostgreSQL custom-format archive and its SHA-256 sidecar.
set -euo pipefail
[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] ||
  { echo "Usage: $0 BACKUP.dump" >&2; exit 2; }
command -v sha256sum >/dev/null
archive="$1"
directory="$(cd -- "$(dirname -- "$archive")" && pwd -P)"
filename="$(basename -- "$archive")"
[[ "$filename" =~ ^[A-Za-z0-9._-]+\.dump$ ]] ||
  { echo "Invalid backup filename" >&2; exit 2; }
archive="$directory/$filename"
sidecar="$archive.sha256"
[[ -f "$sidecar" && ! -L "$sidecar" ]] ||
  { echo "Missing checksum sidecar" >&2; exit 1; }
read -r expected listed_name < "$sidecar"
[[ "$expected" =~ ^[a-f0-9]{64}$ && "$listed_name" == "$filename" ]] ||
  { echo "Malformed checksum sidecar" >&2; exit 1; }
actual="$(sha256sum "$archive" | cut -d ' ' -f 1)"
[[ "$actual" == "$expected" ]] || { echo "Checksum mismatch" >&2; exit 1; }
docker compose exec -T postgres pg_restore --list < "$archive" >/dev/null
echo "Archive and checksum verified: $archive"
