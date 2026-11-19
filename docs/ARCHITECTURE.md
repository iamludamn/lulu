# Architecture

The Cloudflare Worker serves the API and MCP administration. Pi Durable runs in SQLite-backed Durable Objects. The native clients expose [Panel](panel-and-assets.md), [Chat](chat.md), and [Assets](panel-and-assets.md).

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
