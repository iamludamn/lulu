# Architecture

lulu is a self-hosted personal AI assistant for persistent conversations, memory, delegated work, and scheduled tasks. The native clients expose [Panel](panel-and-assets.md), [Chat](chat.md), and [Assets](panel-and-assets.md).

## Repository map

The assistant logic and shared protocol live in [`core/`](../core) and use Pi Durable. [`apps/cf/`](../apps/cf) hosts the core on a Cloudflare Worker and SQLite-backed Durable Objects. [`client/`](../client) contains the iOS and desktop apps and the web MCP administration UI. The iOS target and package retain the PiStack name. Telemetry collection and Grafana dashboards live in [`ops/observability/`](../ops/observability).

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

## Source comments

Keep design rationale in [architecture decision records](adr/) and track workarounds in GitHub issues. The `no-comments` check runs as part of `npm run lint` locally and in CI. It uses syntax trees to detect comments in repository JavaScript, TypeScript, HTML, CSS, Go, Swift, Metal, Python, and shell source, including tests and scripts.

The [baseline](../scripts/comment-baseline.json) records each remaining directive by exact text and path. Removing a directive requires removing its matching entry. Pull request CI also checks that entries have only been removed relative to the base branch. Use `npm run lint:comments` to run the rule on its own, or `node scripts/lint-comments.mjs --inventory` to review the parsed comments. The [delete-comment skill](../.agents/skills/delete-comment/SKILL.md) describes the audit and cleanup workflow.
