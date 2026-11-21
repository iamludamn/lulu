#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
binary=$(mktemp -t lulu-ios-experience)
trap 'rm -f "$binary"' EXIT
swiftc client/ios/Lulu/Session/ChatBottomState.swift \
  client/ios/Lulu/Session/AppPreferences.swift \
  client/ios/Lulu/Session/ChatDraft.swift \
  client/ios/Tests/ExperienceChecks.swift -o "$binary"
"$binary"
