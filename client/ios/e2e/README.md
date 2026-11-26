# Lulu iOS end-to-end tests

These smoke tests cover the first-launch server form, when the Connect button is enabled, and the offline message after a connection attempt. They use a dedicated app bundle on an iOS simulator and need no live Lulu backend, credentials, or model.

Build from the repository root on a Mac with Xcode and the iOS 26 SDK. Choose a simulator that is available for testing.

```sh
xcodebuild -project client/ios/Lulu.xcodeproj -scheme Lulu \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath client/ios/build/e2e \
  PRODUCT_BUNDLE_IDENTIFIER=com.zenlix.pistack.e2e CODE_SIGNING_ALLOWED=NO build
xcrun simctl install "$SIMULATOR_UDID" \
  client/ios/build/e2e/Build/Products/Debug-iphonesimulator/Lulu.app
```

Open that simulator in T3's Device panel. Run the suite wherever T3 provided the device-bound `agent-device` executable, using Node.js 22.22.3+ on the 22.x line or Node.js 24.8+.

```sh
cd client/ios/e2e
npm ci
export LULU_AGENT_DEVICE=/absolute/path/to/the/device-bound/agent-device
npx e2e doctor
npm run test:e2e
```

The e2e runner sends UI actions through that executable so the run is visible in T3 and stays on the selected simulator. Each case launches the test bundle with a blank server preference. The offline case uses the simulator's loopback address on port 1, which should have no listener. The report and traces are under `.e2e/`.
