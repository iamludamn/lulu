#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
binary=$(mktemp -t lulu-ios-experience)
trap 'rm -f "$binary"' EXIT
swiftc client/ios/PiStack/Session/ChatBottomState.swift \
  client/ios/PiStack/Session/ChatDraft.swift \
  client/ios/Tests/ExperienceChecks.swift -o "$binary"
"$binary"
