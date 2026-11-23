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

## Documentation

- [Architecture, repository map, and feature guides](docs/ARCHITECTURE.md)
- [Deployment and configuration](docs/deployment.md)
- [Telemetry and operations](docs/observability.md)
- [Security policy](SECURITY.md)

Use GitHub Issues for bugs and proposals. Maintainers may track follow-up work internally, but contributors do not need access to internal systems.

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses; the project license does not replace their terms.
