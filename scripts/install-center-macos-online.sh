#!/bin/sh
# WECOMMANDER Management Center installer for macOS 13 or newer.
# Usage: curl -fsSL https://wecommander.app/install/center.sh | sh
#        curl -fsSL https://wecommander.app/install/center.sh | sh -s -- --dry-run
# Installs for the current user only (no administrator password): downloads
# the newest macOS preview release's WECOMMANDER-Center-macos.zip from GitHub,
# verifies it against that release's SHA256SUMS.txt, puts "WECOMMANDER
# Center.app" in ~/Applications (replacing an earlier copy) and opens it. The
# app then signs in through the browser and starts at login.
set -eu

REPO="orhanbal/webrising-commender"
ASSET="WECOMMANDER-Center-macos.zip"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS. On Windows use: irm https://wecommander.app/install/center.ps1 | iex" >&2
  exit 1
fi
major="$(sw_vers -productVersion | cut -d. -f1)"
if [ "$major" -lt 13 ]; then
  echo "WECOMMANDER Center needs macOS 13 (Ventura) or newer." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Retries ride out short GitHub or CDN hiccups (504/502); each step says what
# it fetches, so a failure points at the right request.
fetch() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors --connect-timeout 15 \
      -H "Accept: application/vnd.github+json" -H "User-Agent: WECOMMANDER-Center-Installer" \
      -H "Authorization: Bearer $GITHUB_TOKEN" "$1" -o "$2"
  else
    curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors --connect-timeout 15 \
      -H "Accept: application/vnd.github+json" -H "User-Agent: WECOMMANDER-Center-Installer" "$1" -o "$2"
  fi
}

download() {
  curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors --connect-timeout 15 \
    -H "User-Agent: WECOMMANDER-Center-Installer" "$1" -o "$2"
}

echo "Looking up the newest WECOMMANDER Center release on GitHub..."
: > "$tmp/releases.json"
page=1
while [ "$page" -le 5 ]; do
  if ! fetch "https://api.github.com/repos/$REPO/releases?per_page=30&page=$page" "$tmp/page.json"; then
    echo "Could not reach the GitHub releases API (page $page). Try again in a minute." >&2
    exit 1
  fi
  cat "$tmp/page.json" >> "$tmp/releases.json"
  grep -q "/macos-preview-[0-9]*/$ASSET\"" "$tmp/page.json" && break
  page=$((page + 1))
done

# Newest macos-preview-N release (highest N, published by macos-distribution.yml)
# that has both the app and the checksums. Only URLs under this repository's release downloads are used.
prefix="https://github.com/$REPO/releases/download/"
tag=""
for candidate in $(grep -o "\"browser_download_url\": *\"${prefix}macos-preview-[0-9]*/$ASSET\"" "$tmp/releases.json" \
    | sed -E 's#.*/download/(macos-preview-[0-9]+)/.*#\1#' | sort -t- -k3,3nr -u); do
  if grep -q "\"browser_download_url\": *\"${prefix}${candidate}/SHA256SUMS.txt\"" "$tmp/releases.json"; then
    tag="$candidate"
    break
  fi
done
if [ -z "$tag" ]; then
  echo "No preview release with the macOS Management Center yet. Check the latest successful GitHub CI and Releases." >&2
  exit 1
fi
app_url="${prefix}${tag}/${ASSET}"
sums_url="${prefix}${tag}/SHA256SUMS.txt"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "WECOMMANDER Center dry run: would install $tag from $app_url"
  exit 0
fi

echo "Downloading WECOMMANDER Center ($tag)..."
download "$app_url" "$tmp/$ASSET"
download "$sums_url" "$tmp/SHA256SUMS.txt"
echo "Verifying the SHA-256 checksum..."
expected="$(awk -v f="$ASSET" '$2 == f || $2 == "*"f { print $1 }' "$tmp/SHA256SUMS.txt" | head -n 1)"
actual="$(shasum -a 256 "$tmp/$ASSET" | awk '{print $1}')"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "Checksum mismatch for $ASSET; nothing was installed." >&2
  exit 1
fi

ditto -x -k "$tmp/$ASSET" "$tmp/app"
src="$tmp/app/WECOMMANDER Center.app"
test -d "$src"

dest_dir="$HOME/Applications"
dest="$dest_dir/WECOMMANDER Center.app"
mkdir -p "$dest_dir"
# Quit a running copy before replacing it.
osascript -e 'tell application id "app.wecommander.center" to quit' >/dev/null 2>&1 || true
pkill -x WecommanderCenter >/dev/null 2>&1 || true
sleep 1
rm -rf "$dest"
ditto "$src" "$dest"
xattr -dr com.apple.quarantine "$dest" >/dev/null 2>&1 || true

open "$dest"
echo "WECOMMANDER Center installed in $dest and started."
echo "Click the WECOMMANDER icon in the menu bar to sign in. When macOS asks to allow notifications, choose Allow."
