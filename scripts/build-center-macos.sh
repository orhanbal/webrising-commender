#!/bin/bash
# Builds the WECOMMANDER Management Center for macOS (center-macos/) as a
# universal (Apple silicon + Intel) app bundle, ad-hoc signed, and zips it.
# Usage: scripts/build-center-macos.sh <version> <out-dir>
# Output: <out-dir>/WECOMMANDER-Center-macos.zip containing
#         "WECOMMANDER Center.app" (bundle id app.wecommander.center).
set -euo pipefail

VERSION="${1:?version}"
OUT="${2:?out dir}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/center-macos"
APP_NAME="WECOMMANDER Center"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# One architecture at a time, then lipo: the multi-arch build goes through
# the Xcode build system, which cannot resolve SwiftTerm's build plugin.
for triple in arm64-apple-macosx13.0 x86_64-apple-macosx13.0; do
  swift build -c release --package-path "$PKG" --triple "$triple"
done
BIN="$WORK/WecommanderCenter"
lipo -create -output "$BIN" \
  "$PKG/.build/arm64-apple-macosx/release/WecommanderCenter" \
  "$PKG/.build/x86_64-apple-macosx/release/WecommanderCenter"
test -x "$BIN"
lipo -archs "$BIN" | grep -q arm64
lipo -archs "$BIN" | grep -q x86_64

APP="$WORK/$APP_NAME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/WecommanderCenter"
# The shared Rust app core (SSH, SFTP, tunnels), built by CI as a universal
# binary: CORE_BIN or center-macos/core/wecommander-core.
CORE_BIN="${CORE_BIN:-$PKG/core/wecommander-core}"
test -x "$CORE_BIN" || { echo "wecommander-core missing at $CORE_BIN" >&2; exit 1; }
lipo -archs "$CORE_BIN" | grep -q arm64
lipo -archs "$CORE_BIN" | grep -q x86_64
cp "$CORE_BIN" "$APP/Contents/MacOS/wecommander-core"
# The agent the app pairs and runs itself (universal): AGENT_BIN or
# center-macos/core/webrising-commender. Same version as the app.
AGENT_BIN="${AGENT_BIN:-$PKG/core/webrising-commender}"
test -x "$AGENT_BIN" || { echo "webrising-commender (agent) missing at $AGENT_BIN" >&2; exit 1; }
lipo -archs "$AGENT_BIN" | grep -q arm64
lipo -archs "$AGENT_BIN" | grep -q x86_64
"$AGENT_BIN" --version | grep -q "${VERSION}$" || { echo "agent version is not ${VERSION}" >&2; exit 1; }
cp "$AGENT_BIN" "$APP/Contents/MacOS/webrising-commender"
cp "$PKG/Resources/menubar.png" "$PKG/Resources/menubar@2x.png" \
   "$PKG/Resources/wordmark-dark-text.png" "$PKG/Resources/wordmark-light-text.png" \
   "$APP/Contents/Resources/"

# App icon from the 256 px brand icon.
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 64 128 256 512; do
  sips -z "$size" "$size" "$PKG/Resources/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
done
cp "$ICONSET/icon_32x32.png" "$ICONSET/icon_16x16@2x.png"
cp "$ICONSET/icon_64x64.png" "$ICONSET/icon_32x32@2x.png"
cp "$ICONSET/icon_256x256.png" "$ICONSET/icon_128x128@2x.png"
cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_256x256@2x.png"
rm "$ICONSET/icon_64x64.png"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>app.wecommander.center</string>
  <key>CFBundleName</key><string>WECOMMANDER Center</string>
  <key>CFBundleDisplayName</key><string>WECOMMANDER</string>
  <key>CFBundleExecutable</key><string>WecommanderCenter</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleDevelopmentRegion</key><string>tr</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSUserNotificationAlertStyle</key><string>alert</string>
  <key>NSHumanReadableCopyright</key><string>WECOMMANDER</string>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist"

# Ad-hoc signature: no paid certificate. Installed from the terminal (curl
# sets no quarantine flag), so Gatekeeper does not block it.
codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/wecommander-core"
codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/webrising-commender"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict --verbose=2 "$APP"

"$APP/Contents/MacOS/WecommanderCenter" --version | grep -q "WECOMMANDER Center ${VERSION}"

rm -f "$OUT/WECOMMANDER-Center-macos.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/WECOMMANDER-Center-macos.zip"
ls -l "$OUT/WECOMMANDER-Center-macos.zip"
