# lulu

A self-hosted personal AI assistant with durable conversations, memory, scheduled tasks, tool execution, and web, desktop, and iOS clients.

lulu builds on the Pi packages from Earendil. A Cloudflare Worker hosts the API and web app; SQLite-backed Durable Objects keep conversations, memory, and artifact metadata. E2B supplies optional execution environments, and S3-compatible storage holds artifact content.

This is an early-stage, single-user project. The API uses the fixed bot ID `main` and does not provide general user authentication or tenant isolation. Keep deployments behind an access boundary that protects HTTP and WebSocket traffic. `MCP_ADMIN_TOKEN` protects the MCP registry only. See [Security](SECURITY.md) before deploying.

## What it does

- Chat with models through Pi, with durable task recovery and delegated agents.
- Maintain memory across conversations and run scheduled work.
- Connect MCP services, including OAuth-backed services.
- Execute work in E2B sandboxes and deliver files through S3-compatible storage.
- Offer panels and small interactive spaces that users can choose to keep.
- Support voice calls through the Doubao integration.

Features that depend on external services require your own credentials and may incur usage charges.

## Start here

Prerequisites: Node.js 22.19 or newer, npm, and Go matching `client/desktop/go.mod` (currently 1.27.3). The root build includes the desktop client. iOS development additionally needs macOS, Xcode with the iOS 26 SDK, and Swift 6.2.

```sh
git clone https://github.com/iamludamn/lulu.git
cd lulu
npm ci
npm run build
```

This compiles the core, web app, and desktop binary; it does not deploy or build iOS. To run the service, follow [Local development and deployment](docs/deployment.md). A model credential is needed for chat; optional integrations are listed there. No credentials are needed to compile.

## Repository map

| Path | Responsibility |
| --- | --- |
| `core/src/` | Runtime-independent agent, conversation, memory, tools, and protocol |
| `apps/cf/` | Cloudflare Worker, Durable Object adapters, and bindings |
| `client/web/` | React/Vite web client and MCP administration page |
| `client/desktop/` | Go desktop client using mygo |
| `client/ios/` | SwiftUI app and the shared PiStackKit Swift package |
| `ops/observability/` | Collector configuration and Grafana dashboard |

Some client targets and internal names still use `PiStack`; the project is called lulu.

## Documentation

- [Architecture and extension boundaries](docs/ARCHITECTURE.md)
- [Development and contributions](docs/CONTRIBUTING.md)
- [Deployment and configuration](docs/deployment.md)
- [Telemetry and operations](docs/observability.md)
- [Security policy](SECURITY.md)
- [Community expectations](docs/CODE_OF_CONDUCT.md)

Use GitHub Issues for bugs and proposals. Maintainers may track follow-up work internally, but contributors do not need access to internal systems.

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses; the project license does not replace their terms.
