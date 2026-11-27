# lulu

A self-hosted personal AI assistant with an iOS app, durable conversations, memory, scheduled tasks, and tool execution. Use the web interface to configure MCP services.

lulu builds on the Pi packages from Earendil. A Cloudflare Worker serves the API and web configuration interface. Durable Objects keep conversations and memory, D1 stores artifact and application metadata, and an S3-compatible bucket holds artifact content. E2B supplies optional execution environments.

This is an early-stage, single-user project. The API uses the fixed bot ID `main` and does not provide general user authentication or tenant isolation. Keep deployments behind an access boundary that protects HTTP and WebSocket traffic. `MCP_ADMIN_TOKEN` protects the MCP registry only. See [Security](SECURITY.md) before deploying.

## What it does

- Chat with models through Pi, with durable task recovery and delegated agents.
- Maintain memory across conversations and run scheduled work.
- Connect MCP services, including OAuth-backed services.
- Execute work in E2B sandboxes and deliver files through S3-compatible storage.
- Send cards in Chat that users can accept as Widgets on Panel or files in Assets. A Space is an interactive Widget.
- Support voice calls through the Doubao integration.

Features that depend on external services require your own credentials and may incur usage charges.

## Start here

The service build requires Node.js 22.19 or newer and npm. iOS development uses macOS and Xcode with the iOS 26 SDK and Swift 6.2 or newer.

```sh
git clone https://github.com/iamludamn/lulu.git
cd lulu
npm ci
npm run build
```

This builds the core and Web configuration assets. Follow [Local development and deployment](docs/deployment.md) to run the Worker. Chat requires a model credential, and the deployment guide lists optional integrations.

Open [Lulu.xcodeproj](client/ios/Lulu.xcodeproj) in Xcode to build the iOS app with the Lulu scheme. Run `swift test --package-path client/ios/LuluKit` and `scripts/test-ios-experience.sh` from the repository root to check the client.

## Checks

Run `npm run check` and `npm run lint` locally. The first command checks TypeScript across the workspaces and e2e suite, and uses ast-grep to keep `node:` and `cloudflare:` imports out of `core/src`. Put runtime-specific imports in the host adapter. The second command runs type-aware lint and rejects source comments in JS, TS, Metal, shell, Python, HTML, SVG, CSS, JSONC, and YAML. Run `scripts/lint-swift.sh` on macOS to check Swift source comments. Keep the SwiftPM tools-version directive and script shebangs at the start of their files.

The e2e.com browser tests require Node.js 24.8 or newer on the 24 line, or Node.js 22.22.3 or newer on the 22 line. On Linux, install Chromium and its system dependencies before the first run.

```sh
npm exec -- e2e-web install chromium --with-deps
npm run test:e2e
```

On macOS, omit `--with-deps`. The suite builds the production Web assets and opens them through a loopback-only Wrangler Worker with a fresh D1 database and fixture credentials. MCP access and locking use the real Worker. Catalog search uses intercepted responses so the suite runs without a model, an account, or access to the public MCP registry.

The iOS e2e suite uses the same local Worker and a disposable simulator. Build Lulu for iOS Simulator, boot the simulator, and install the app before running the suite. Pick the simulator UDID from `xcrun simctl list devices booted`. The tests clear Lulu app data on the selected simulator.

```sh
xcodebuild -project client/ios/Lulu.xcodeproj -scheme Lulu -configuration Debug \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath .e2e/ios-build CODE_SIGNING_ALLOWED=NO build
xcrun simctl install "$E2E_IOS_DEVICE" .e2e/ios-build/Build/Products/Debug-iphonesimulator/Lulu.app
npm run test:e2e:ios
```

Set and export `E2E_IOS_DEVICE` before running those commands. The iOS tests use local port 9178. They cover first launch, connecting, switching to Assets, and opening a draft from the board without sending a model request.

The GitHub Actions `Check` job summarizes static checks, unit tests and the Worker bundle, iOS checks and build, and both e2e suites. The workflow runs on pull requests and pushes to `main` or `t3/**`. Each e2e job uploads its JUnit output, structured report, and diagnostic artifacts.

Confirmed bugs have separate reproduction tests under `tests/bugbash/`. To reproduce the current failures after building, run the following command.

```sh
npx e2e run tests/bugbash/mcp-accessibility.e2e.ts tests/bugbash/mcp-duplicate.e2e.ts --config e2e.bugbash.config.ts --trace on
npx e2e run --config e2e.ios.bugbash.config.ts --trace on
```

## Documentation

- [Repository overview](docs/ARCHITECTURE.md)
- [Domain glossary](docs/GLOSSARY.md)
- [Deployment and configuration](docs/deployment.md)
- [Telemetry and operations](docs/observability.md)
- [Security policy](SECURITY.md)

Use GitHub Issues for bugs and proposals. Maintainers may track follow-up work internally, but contributors do not need access to internal systems.

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses; the project license does not replace their terms.
