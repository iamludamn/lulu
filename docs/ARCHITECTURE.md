# Architecture

lulu is a self-hosted personal AI assistant for persistent conversations, memory, delegated work, and scheduled tasks. The native clients expose [Panel](panel-and-assets.md), [Chat](chat.md), and [Assets](panel-and-assets.md).

## Repository map

| Path | Responsibility |
| --- | --- |
| [`core/`](../core) | Runtime-independent assistant logic built on Pi Durable, plus the shared protocol. |
| [`apps/cf/`](../apps/cf) | Cloudflare Worker API and SQLite-backed Durable Objects that host the core. |
| [`client/`](../client) | iOS and desktop apps, plus the web MCP administration UI. The iOS code retains the PiStack target and package names. |
| [`ops/observability/`](../ops/observability) | Telemetry collection and Grafana dashboards. |

## Core APIs

| API | Purpose |
| --- | --- |
| [`/api/bots/main/ws`](../core/src/protocol/wire.ts) | Chat, client state, and card actions. |
| [`/api/bots/main/*`](../core/src/server/api.ts) | HTTP access to schedules, memory, artifacts, Spaces, and MCP configuration. |
| [Pi Durable extensions](../core/src/agent/catalog.ts) | Register tools and model context. Persist recoverable state in Docs and use request IDs for replayable side effects. |

## Core entities

| Entity | Owns |
| --- | --- |
| [Bot](../core/src/conversation/bot.ts) | Root conversation, transcript, and [delegation and scheduling](execution.md). |
| [Memory](memory.md) | Published memory files, background processing, and request-scoped retrieval. |
| [Artifact](../core/src/artifact/object.ts) | File metadata and versions. S3-compatible storage holds file contents. |
| [MCP configuration](../core/src/agent/mcp-store.ts) | Encrypted connection configuration in Workers KV. Bot storage holds OAuth authorization. |

[Deployment](deployment.md) · [Observability](observability.md)
