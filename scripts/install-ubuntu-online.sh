#!/usr/bin/env bash
# Direct Ubuntu installer; fetches the newest verified-main CI preview from GitHub Releases.
# No ZIP extraction and no third-party pipe-to-root shell execution.
set -euo pipefail
set +x
umask 077
REPO="orhanbal/webrising-commender"
API="https://api.github.com/repos/$REPO/releases?per_page=30"
PACKAGE_ONLY=0
if [[ "${1:-}" == --package-only ]]; then PACKAGE_ONLY=1; shift; fi
(($# == 0)) || { echo "Usage: sudo bash install-ubuntu-online.sh [--package-only]" >&2; exit 2; }
[[ $EUID == 0 ]] || { echo "Run with sudo." >&2; exit 1; }
[[ "$(dpkg --print-architecture)" == amd64 ]] || { echo "This installer supports Ubuntu amd64 (x86_64) only." >&2; exit 1; }
for command in curl python3 dpkg-deb sha256sum apt-get; do
  command -v "$command" >/dev/null || { echo "Missing dependency: $command" >&2; exit 1; }
done
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
curl --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 30 --fail --silent --show-error \
  -H 'Accept: application/vnd.github+json' "$API" -o "$TMP/releases.json"

python3 - "$TMP/releases.json" "$REPO" > "$TMP/asset-urls" <<'PY'
import json,re,sys
releases=json.load(open(sys.argv[1],encoding="utf-8"))
repo=sys.argv[2]
for release in releases:
    tag=release.get("tag_name","")
    if release.get("draft") or not release.get("prerelease") or not re.fullmatch(r"ubuntu-preview-[0-9]+",tag):
        continue
    assets=release.get("assets",[])
    package=next((a for a in assets if re.fullmatch(r"wecommander-agent_[0-9][0-9a-z.+~-]*_amd64\.deb",a["name"])),None)
    sums=next((a for a in assets if a["name"]=="SHA256SUMS.txt"),None)
    if not package or not sums:
        continue
    prefix=f"https://github.com/{repo}/releases/download/{tag}/"
    if not package["browser_download_url"].startswith(prefix) or not sums["browser_download_url"].startswith(prefix):
        continue
    print(package["name"])
    print(package["browser_download_url"])
    print(sums["browser_download_url"])
    print(tag)
    break
else:
    sys.exit("No published Ubuntu preview package exists yet. Wait for the release CI to finish.")
PY
mapfile -t info < "$TMP/asset-urls"
PACKAGE_NAME="${info[0]}"
PACKAGE_URL="${info[1]}"
SUMS_URL="${info[2]}"
TAG="${info[3]}"
echo "WECOMMANDER release: $TAG"
echo "Fetching Debian package and checksum..."
curl --proto '=https' --tlsv1.2 --retry 3 --fail --silent --show-error \
  --location --output "$TMP/$PACKAGE_NAME" "$PACKAGE_URL"
curl --proto '=https' --tlsv1.2 --retry 3 --fail --silent --show-error \
  --location --output "$TMP/SHA256SUMS.txt" "$SUMS_URL"
EXPECTED="$(awk -v filename="$PACKAGE_NAME" '$2 == filename {print $1}' "$TMP/SHA256SUMS.txt")"
[[ "$EXPECTED" =~ ^[[:xdigit:]]{64}$ ]] || { echo "Checksum not found for $PACKAGE_NAME." >&2; exit 1; }
printf '%s  %s\n' "$EXPECTED" "$TMP/$PACKAGE_NAME" | sha256sum --check --status || {
  echo "SHA256 mismatch. Installation aborted." >&2; exit 1;
}
[[ "$(dpkg-deb -f "$TMP/$PACKAGE_NAME" Package)" == wecommander-agent ]] || { echo "Unexpected package." >&2; exit 1; }
[[ "$(dpkg-deb -f "$TMP/$PACKAGE_NAME" Architecture)" == amd64 ]] || { echo "Wrong architecture." >&2; exit 1; }
echo "Checksum verified. Installing Debian package..."
DEBIAN_FRONTEND=noninteractive apt-get install -y "$TMP/$PACKAGE_NAME"
if ((PACKAGE_ONLY)); then
  echo "Package installed. To connect later: sudo wecommander-setup"
else
  echo "Starting account-approved Ubuntu enrollment..."
  exec /usr/bin/wecommander-setup
fi
