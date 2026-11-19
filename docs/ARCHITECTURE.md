# Architecture

lulu runs on a Cloudflare Worker with SQLite-backed Durable Objects. The native clients use the Worker API and WebSocket. The Worker also serves the web app for MCP administration at `/mcp`.

## Runtime boundaries

`apps/cf/src/worker.ts` delegates requests to `core/src/server/api.ts`. `apps/cf/src/host.ts` implements the host interfaces in `core/src/host/types.ts`: storage, alarms, WebSockets, object addressing, telemetry, and execution services. `apps/cf/src/objects.ts` exports the Cloudflare Durable Object classes.

The core uses Pi's extension and tool APIs. `core/src/agent/catalog.ts` maps persisted extension names to implementations and installs the harness. Sessions persist extension and tool names rather than executable code. Use Pi's extension points and the existing feature modules when adding behavior.

The Durable path must remain independent of the operating system and filesystem. Host-specific work belongs in an adapter or execution environment. The root `check` command enforces the existing ban on `node:` and `cloudflare:` imports in the core.

The API is rooted at `/api/bots/main/`. WebSockets carry conversation activity. HTTP routes expose memory, schedules, artifacts, spaces, and MCP administration. See [Security](../SECURITY.md) for the access boundary for the fixed `main` bot.

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

## Feature guides

| Guide | Scope |
| --- | --- |
| [Chat](chat.md) | Messages, request identity, delivery, and WebSocket state |
| [Panel and Assets](panel-and-assets.md) | Widgets, cards, Spaces, and artifact storage |
| [Delegation and scheduling](execution.md) | Delegate runs, sandbox workspaces, scheduled jobs, and alarm recovery |
| [Memory](memory.md) | Sources, dreaming, published resources, and request-scoped injection |

## Integrations

Pi calls the configured model provider. Workers AI supplies the memory decision model. E2B provides optional sandboxes, S3-compatible storage holds artifact bytes, and the Bot connects to MCP servers and the voice provider. See [Deployment](deployment.md) for configuration and [Observability](observability.md) for telemetry.
