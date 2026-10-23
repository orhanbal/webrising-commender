#!/bin/bash
# WECOMMANDER: direct terminal installer for Intel and Apple Silicon macOS.
set -euo pipefail
set +x
umask 077
[[ "$(uname -s)" == Darwin ]] || { echo "macOS required" >&2; exit 1; }
case "$(uname -m)" in arm64|x86_64) ;; *) echo "Unsupported Mac architecture." >&2; exit 1 ;; esac
(( EUID != 0 )) || { echo "Run in your Mac user session without sudo; installation will request it." >&2; exit 1; }
INSTALL_ONLY=0
if [[ "${1:-}" == '--install-only' ]]; then INSTALL_ONLY=1; shift; fi
(($# == 0)) || { echo "Usage: bash install-macos-online.sh [--install-only]" >&2; exit 2; }
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
REPO="orhanbal/webrising-commender"
API="https://api.github.com/repos/$REPO/releases?per_page=30"
curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
  --connect-timeout 10 --max-time 30 -H 'Accept: application/vnd.github+json' \
  "$API" -o "$TMP/releases.json"
# macOS includes JavaScript for Automation, so no Homebrew/jq/Python dependency.
json_lines="$(/usr/bin/osascript -l JavaScript -e '
function run(argv) {
 ObjC.import("Foundation");
 var raw = $.NSData.dataWithContentsOfFile(argv[0]);
 if (!raw) throw Error("Cannot load release metadata");
 var body = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(raw, $.NSUTF8StringEncoding));
 var releases = JSON.parse(body);
 var repo = argv[1], name = "WECOMMANDER-macos-universal.pkg";
 for (var i=0;i<releases.length;i++) {
   var release=releases[i];
   if (release.draft || !release.prerelease || !/^ubuntu-preview-[0-9]+$/.test(release.tag_name)) continue;
   var packageAsset=null, sums=null;
   for(var j=0;j<release.assets.length;j++) {
     var a=release.assets[j];
     if(a.name === name) packageAsset=a;
     if(a.name === "SHA256SUMS.txt") sums=a;
   }
   if (!packageAsset || !sums) continue;
   var prefix="https://github.com/"+repo+"/releases/download/"+release.tag_name+"/";
   if (!packageAsset.browser_download_url.startsWith(prefix) || !sums.browser_download_url.startsWith(prefix)) continue;
   return [packageAsset.browser_download_url,sums.browser_download_url,release.tag_name].join("\n");
 }
 throw Error("No complete macOS installer release yet. Check GitHub CI/Releases.");
}' "$TMP/releases.json" "$REPO")"
PACKAGE_URL="$(printf '%s\n' "$json_lines" | sed -n '1p')"
CHECKSUM_URL="$(printf '%s\n' "$json_lines" | sed -n '2p')"
TAG="$(printf '%s\n' "$json_lines" | sed -n '3p')"
PACKAGE="WECOMMANDER-macos-universal.pkg"
echo "Downloading WECOMMANDER $TAG for macOS..."
curl --proto '=https' --tlsv1.2 --retry 3 --fail --silent --show-error \
 --location "$PACKAGE_URL" -o "$TMP/$PACKAGE"
curl --proto '=https' --tlsv1.2 --retry 3 --fail --silent --show-error \
 --location "$CHECKSUM_URL" -o "$TMP/SHA256SUMS.txt"
EXPECTED="$(awk -v filename="$PACKAGE" '$2 == filename {print $1}' "$TMP/SHA256SUMS.txt")"
[[ "$EXPECTED" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "No matching SHA256 checksum." >&2; exit 1; }
ACTUAL="$(shasum -a 256 "$TMP/$PACKAGE" | awk '{print $1}')"
[[ "$EXPECTED" == "$ACTUAL" ]] || { echo "Checksum mismatch; refusing installation." >&2; exit 1; }
echo "Checksum verified. macOS may request your administrator password to install package files."
sudo /usr/sbin/installer -pkg "$TMP/$PACKAGE" -target /
echo "WECOMMANDER package installed."
if ((INSTALL_ONLY)); then
  echo "To pair later: /usr/local/bin/wecommander-setup"
else
  /usr/local/bin/wecommander-setup
fi
