#!/bin/sh
# WECOMMANDER Management Center installer for macOS 13 or newer and Linux
# desktops (x86_64, WebKitGTK 4.1).
# Usage: curl -fsSL https://wecommander.app/install/center.sh | sh
#        curl -fsSL https://wecommander.app/install/center.sh | sh -s -- --dry-run
# Installs for the current user only (no administrator password).
#   macOS: downloads WECOMMANDER-Center-macos.zip (fixed tag macos-center-latest,
#          else the newest macos-preview-N release), puts "WECOMMANDER
#          Center.app" in ~/Applications and opens it.
#   Linux: downloads WECOMMANDER-Center-linux-x86_64.tar.gz (fixed tag
#          center-linux-latest, else the newest ubuntu-preview-N release), puts
#          it in ~/.local/share/wecommander-center with a menu entry and starts it.
# Each download is verified against its release's SHA256SUMS.txt. The app then
# signs in through the browser and starts at login.
set -eu

# Brand banner: the WECOMMANDER wordmark when the terminal is wide enough,
# else the icon with the name. Only block characters; no colors.
wecommander_banner() {
  cols="$( { stty size </dev/tty; } 2>/dev/null | cut -d' ' -f2)"
  case "$cols" in ""|*[!0-9]*) cols=80 ;; esac
  if [ "$cols" -ge 100 ]; then
    cat <<'WECOMMANDER_BANNER'
▄▄▄    ▄▄▄    ▄▄
▀███   ███   ███                                                                  ▄▄
 ███  ████▄  ███  ▄▄▄▄      ▄▄▄▄   ▄▄▄                                            ██
 ███  █████  ██▀ ▄█████▄   ██▀██▄ █████▄ ▄▄▄▄▄ ▄▄▄  ▄▄▄▄▄ ▄▄▄   ▄▄▄▄  ▄▄▄▄▄    ▄▄▄██  ▄▄▄   ▄▄▄▄
  ██▄ █████ ███ ▄██▀▀▀██  ██     ███████ ██▀████▀█▄ ███▀███▀██  █▀▀█▄ ███▀██  ██▀███ ▄█▀▀█▄ ███▀
  ██████ ██▄███ ███▄▄▄██  █      ███████ ██  ██  ██ ██  ▀█   █     ██ ██   █ ▄█   ██ ██  ██ ██
  ██████ █████▀ ████████  █      ███▀███ ██  ██  ██ ██   █   █  ██▀██ ██   █ ██   ██ ██▀▀▀▀ ██
   ████  ▀████  ███▄  ▄   █▄     ██ ▄ ██ ██  ██  ██ ██   █   █ ██  ██ ██   █  █▄ ▄██ ██  ▄  ██
   ████   ████   ██████▄  ▀█▄▄▄█▄▀ ███ ▀ ██  ██  ██ ██   █   █  █████ ██   █  ▀█████  ████  ██
   ▀██▀   ▀██     ▀███▀    ▀▀██▀  █████
                                 ▀▀▀▀▀▀▀
WECOMMANDER_BANNER
    printf '  %s\n' "$1"
  else
    sed -e 's/@TITLE@/W E C O M M A N D E R/' -e "s/@SUB@/$1/" <<'WECOMMANDER_BANNER'
       ▄███████▄
     ▄███████████
     █████████████       @TITLE@
     █████▀ ▀█████
     ▀██▀ ▄█▄ ▀██        @SUB@
        ▄█████
      ▄████████▄
WECOMMANDER_BANNER
  fi
  echo
}

REPO="orhanbal/webrising-commender"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

wecommander_banner "Management Center installer"

OS="$(uname -s)"
case "$OS" in
  Darwin)
    major="$(sw_vers -productVersion | cut -d. -f1)"
    if [ "$major" -lt 13 ]; then
      echo "WECOMMANDER Center needs macOS 13 (Ventura) or newer." >&2
      exit 1
    fi
    ASSET="WECOMMANDER-Center-macos.zip"
    FIXED_TAG="macos-center-latest"
    PREVIEW="macos-preview"
    ;;
  Linux)
    if [ "$(uname -m)" != "x86_64" ]; then
      echo "WECOMMANDER Center for Linux is built for x86_64 only for now." >&2
      exit 1
    fi
    ASSET="WECOMMANDER-Center-linux-x86_64.tar.gz"
    FIXED_TAG="center-linux-latest"
    PREVIEW="ubuntu-preview"
    ;;
  *)
    echo "This installer is for macOS and Linux. On Windows use: irm https://wecommander.app/install/center.ps1 | iex" >&2
    exit 1
    ;;
esac

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

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

prefix="https://github.com/$REPO/releases/download/"

# Fast path: the distribution workflows keep the newest app under a fixed tag,
# so no GitHub API call is needed (the API can time out).
tag="$FIXED_TAG"
app_url="${prefix}${tag}/${ASSET}"
sums_url="${prefix}${tag}/SHA256SUMS.txt"
echo "Checking the newest WECOMMANDER Center download..."
if ! download "$sums_url" "$tmp/SHA256SUMS.txt" 2>/dev/null; then
  tag=""
fi

if [ -z "$tag" ]; then
  echo "Looking up the newest WECOMMANDER Center release on GitHub..."
  : > "$tmp/releases.json"
  page=1
  while [ "$page" -le 5 ]; do
    if ! fetch "https://api.github.com/repos/$REPO/releases?per_page=30&page=$page" "$tmp/page.json"; then
      echo "Could not reach the GitHub releases API (page $page). Try again in a minute." >&2
      exit 1
    fi
    cat "$tmp/page.json" >> "$tmp/releases.json"
    grep -q "/$PREVIEW-[0-9]*/$ASSET\"" "$tmp/page.json" && break
    page=$((page + 1))
  done

  # Newest preview release (highest N) that has both the app and the
  # checksums. Only URLs under this repository's release downloads are used.
  tag=""
  for candidate in $(grep -o "\"browser_download_url\": *\"${prefix}$PREVIEW-[0-9]*/$ASSET\"" "$tmp/releases.json" \
      | sed -E "s#.*/download/($PREVIEW-[0-9]+)/.*#\\1#" | sort -t- -k3,3nr -u); do
    if grep -q "\"browser_download_url\": *\"${prefix}${candidate}/SHA256SUMS.txt\"" "$tmp/releases.json"; then
      tag="$candidate"
      break
    fi
  done
  if [ -z "$tag" ]; then
    echo "No preview release with the Management Center for this system yet. Check the latest successful GitHub CI and Releases." >&2
    exit 1
  fi
  app_url="${prefix}${tag}/${ASSET}"
  sums_url="${prefix}${tag}/SHA256SUMS.txt"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "WECOMMANDER Center dry run: would install $tag from $app_url"
  exit 0
fi

if [ "$OS" = "Linux" ] && ! ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4\.1\.so\.0'; then
  echo "WECOMMANDER Center needs WebKitGTK 4.1. On Ubuntu or Debian install it with:" >&2
  echo "  sudo apt install libwebkit2gtk-4.1-0 libayatana-appindicator3-1" >&2
  echo "then run this installer again." >&2
  exit 1
fi

echo "Downloading WECOMMANDER Center ($tag)..."
download "$app_url" "$tmp/$ASSET"
[ -s "$tmp/SHA256SUMS.txt" ] || download "$sums_url" "$tmp/SHA256SUMS.txt"
echo "Verifying the SHA-256 checksum..."
expected="$(awk -v f="$ASSET" '$2 == f || $2 == "*"f { print $1 }' "$tmp/SHA256SUMS.txt" | head -n 1)"
actual="$(sha256 "$tmp/$ASSET")"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "Checksum mismatch for $ASSET; nothing was installed." >&2
  exit 1
fi

if [ "$OS" = "Darwin" ]; then
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
  exit 0
fi

# Linux: a per-user install under ~/.local (XDG), no root needed.
mkdir -p "$tmp/app"
tar -xzf "$tmp/$ASSET" -C "$tmp/app"
src="$tmp/app/wecommander-center"
test -x "$src/wecommander-center"

data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
dest="$data_home/wecommander-center"
pkill -x wecommander-center >/dev/null 2>&1 || true
sleep 1
rm -rf "$dest"
mkdir -p "$dest" "$HOME/.local/bin" "$data_home/applications" "$data_home/icons/hicolor/256x256/apps"
cp -R "$src/." "$dest/"
ln -sf "$dest/wecommander-center" "$HOME/.local/bin/wecommander-center"
cp "$dest/wecommander-center.png" "$data_home/icons/hicolor/256x256/apps/wecommander-center.png"
sed "s#^Exec=.*#Exec=$dest/wecommander-center#" "$dest/wecommander-center.desktop" \
  > "$data_home/applications/wecommander-center.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$data_home/applications" >/dev/null 2>&1 || true

if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  nohup "$dest/wecommander-center" >/dev/null 2>&1 &
  echo "WECOMMANDER Center installed in $dest and started."
  echo "Click the WECOMMANDER icon in the system tray (or open it from the app menu) to sign in."
else
  echo "WECOMMANDER Center installed in $dest."
  echo "No desktop session found here; open \"WECOMMANDER Center\" from the app menu after you log in to the desktop."
fi
