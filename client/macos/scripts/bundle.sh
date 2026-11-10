#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
configuration="${CONFIGURATION:-release}"
swift build -c "$configuration"
bin="$(swift build -c "$configuration" --show-bin-path)"
app="build/lulu.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin/Lulu" "$app/Contents/MacOS/Lulu"
cp Info.plist "$app/Contents/Info.plist"
icons="build/AppIcon.iconset"
rm -rf "$icons"
mkdir -p "$icons"
source="../ios/PiStack/Assets.xcassets/AppIcon.appiconset/icon.png"
for size in 16 32 128 256 512; do
  sips -z $size $size "$source" --out "$icons/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$source" --out "$icons/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$icons" -o "$app/Contents/Resources/AppIcon.icns"
rm -rf "$icons"
identity="${SIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk -F '"' '/Apple Development|Developer ID Application/ { print $2; exit }')}"
codesign --force --options runtime --timestamp=none --sign "${identity:--}" "$app"
codesign --verify --strict "$app"
echo "$app (${identity:-ad-hoc})"
