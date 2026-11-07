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

swift build -c release --package-path "$PKG" --arch arm64 --arch x86_64
BIN="$PKG/.build/apple/Products/Release/WecommanderCenter"
test -x "$BIN"
lipo -archs "$BIN" | grep -q arm64
lipo -archs "$BIN" | grep -q x86_64

APP="$WORK/$APP_NAME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/WecommanderCenter"
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
  <key>CFBundleDisplayName</key><string>WECOMMANDER Yönetim Merkezi</string>
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
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict --verbose=2 "$APP"

"$APP/Contents/MacOS/WecommanderCenter" --version | grep -q "WECOMMANDER Center ${VERSION}"

rm -f "$OUT/WECOMMANDER-Center-macos.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/WECOMMANDER-Center-macos.zip"
ls -l "$OUT/WECOMMANDER-Center-macos.zip"
