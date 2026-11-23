#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
swift_binary=$(xcrun --find swift)
swift_host="${swift_binary%/bin/swift}/lib/swift/host"
exec "$swift_binary" -I "$swift_host" -L "$swift_host" -Xlinker -rpath -Xlinker "$swift_host" \
  scripts/no-swift-comments.swift client/ios
