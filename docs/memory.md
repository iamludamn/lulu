# Memory

## Core APIs

| API | Purpose |
| --- | --- |
| [`GET /api/bots/main/memory` and `/memory/file`](../core/src/server/api.ts) | List and read published memory files. |
| [`/remember` and `/dream`](../core/src/memory/object.ts) | Memory Object entry points for committed dialogue and accepted Space or Asset sources. |
| [`/catalog` and `/retrieve`](../core/src/memory/client.ts) | Load published resources and run read-only retrieval when Clef selects retrieval for a prompt. |
| [`memory_read` and `inject_memory`](../core/src/memory/retrieval.ts) | Read exact resource versions and deliver request-scoped context to the main agent. |

## Core entities

| Entity | Identity and purpose |
| --- | --- |
| Memory Source | Versioned dialogue, accepted Space or Asset, or saved Space state used as input. |
| Dreaming | Background Memory Agent work that turns sources into published Markdown. |
| Memory Resource | `memory:<path>` at a published commit, with a summary and source references. |
| Memory Injection | Context bound to a Chat `requestId` and delivered through the `memory` section. |
