# Architecture

## Runtime boundaries

`apps/cf/src/worker.ts` delegates requests to `core/src/server/api.ts`. `apps/cf/src/host.ts` implements the host interfaces in `core/src/host/types.ts`: storage, alarms, WebSockets, object addressing, telemetry, and execution services. `apps/cf/src/objects.ts` exports the Cloudflare Durable Object classes.

The core uses Pi's extension and tool APIs. `core/src/agent/catalog.ts` maps persisted extension names to implementations and installs the harness. Sessions persist extension and tool names rather than executable code. Prefer official package extension points and existing modules when adding behavior.

The Durable path must remain independent of the operating system and filesystem. Host-specific work belongs in an adapter or execution environment. The root `check` command enforces the existing ban on `node:` and `cloudflare:` imports in the core.

## State and recovery

| Owner | State |
| --- | --- |
| Bot Durable Object | Conversation runtime, transcripts, scheduled work, MCP authorization |
| Memory Durable Object | Cross-conversation memory files and processing state |
| Artifact Durable Object | Artifact metadata and versions |
| S3-compatible storage | Artifact bytes |
| `LULU_MCP` KV | Encrypted MCP server configuration and legacy authorization data |

Pi Durable tasks can replay. Recoverable extension state belongs in a Doc committed atomically with the transcript. Model-visible state uses `section`. Tools explicitly declare their replay behavior. External side effects need request-ID-based idempotency; in-memory flags cannot protect a retry after recovery.

`core/src/conversation/` coordinates submissions and bot activity. Feature modules such as `memory`, `delegate`, `cron`, `sandbox`, `artifact`, `panel`, and `send` own their data and extensions. Add to these boundaries before introducing another layer.

## Clients and protocol

`core/src/protocol/` defines the shared wire structures. The web and desktop clients implement the same assistant experience; `client/ios/PiStackKit` contains the Swift protocol and session layer. Protocol changes need corresponding client changes.

The public router uses `/api/bots/main/`. WebSockets carry conversation activity; HTTP routes expose memory, schedules, artifacts, spaces, and MCP administration. The current fixed bot identity is a single-user convention, not an authorization boundary. See [Security](SECURITY.md).

## Integrations

Model registration and selection live in `core/src/agent/models.ts`. Sandbox selection lives in `core/src/sandbox/backends.ts`; the implemented backend type is E2B. MCP configuration, encryption, and authorization live under `core/src/agent/mcp*.ts`. Voice transport lives under `core/src/voice/`.

Telemetry is exported as OTLP/HTTP traces and converted into metrics by the external collector. [Observability](docs/observability.md) describes deployment requirements and query conventions. Neither the collector nor external services are part of the Worker deployment.
