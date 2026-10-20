#!/usr/bin/env bash
# First-party PostgreSQL backup for a Docker Compose Commender deployment.
set -euo pipefail
umask 077

usage() {
  echo "Usage: $0 [--output PATH]" >&2
  exit 2
}

output=""
while (($#)); do
  case "$1" in
    --output) (($# >= 2)) || usage; output="$2"; shift 2 ;;
    -h|--help) echo "Usage: $0 [--output PATH]"; exit 0 ;;
    *) usage ;;
  esac
done

command -v docker >/dev/null || { echo "Docker is required" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum is required" >&2; exit 1; }

if [[ -z "$output" ]]; then
  output="backups/commender-$(date -u +%Y%m%dT%H%M%SZ).dump"
fi
[[ "$output" == *.dump ]] || { echo "Backup path must end in .dump" >&2; exit 2; }
directory="$(dirname -- "$output")"
filename="$(basename -- "$output")"
[[ "$filename" =~ ^[A-Za-z0-9._-]+\.dump$ ]] || { echo "Invalid backup filename" >&2; exit 2; }
mkdir -p -- "$directory"
directory="$(cd -- "$directory" && pwd -P)"
output="$directory/$filename"
checksum="$output.sha256"

if [[ -e "$output" || -L "$output" || -e "$checksum" || -L "$checksum" ]]; then
  echo "Backup or checksum already exists; refusing to overwrite" >&2
  exit 1
fi

temp="$(mktemp "$directory/.commender-backup.XXXXXXXX")"
sumtemp="$(mktemp "$directory/.commender-checksum.XXXXXXXX")"
published=0
cleanup() {
  rm -f -- "$temp" "$sumtemp"
  if ((published)); then rm -f -- "$output"; fi
}
trap cleanup EXIT

echo "Creating PostgreSQL custom-format backup..." >&2
docker compose exec -T postgres sh -c \
  'exec pg_dump --username=commender --dbname="$POSTGRES_DB" --format=custom --no-owner --no-acl' > "$temp"
[[ -s "$temp" ]] || { echo "Backup is empty" >&2; exit 1; }

# Validate archive structure before publishing; a dump is not a verified restore.
docker compose exec -T postgres pg_restore --list < "$temp" >/dev/null
(cd -- "$directory" && sha256sum "$(basename -- "$temp")") |
  sed "s@$(basename -- "$temp")\$@$filename@" > "$sumtemp"
chmod 600 "$temp" "$sumtemp"

# Hard links publish atomically and fail rather than overwrite an existing path.
ln -- "$temp" "$output"
published=1
ln -- "$sumtemp" "$checksum"
published=0
echo "Backup saved: $output" >&2
echo "SHA-256 sidecar: $checksum" >&2
