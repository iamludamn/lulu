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

## Conversations and delivery progress

The WebSocket command `prompt.submit` carries a client-generated `requestId`, content, and a busy mode (`steer` or `followUp`). `BotSession` orders prompt submissions and prepares request-scoped memory through the decision gate and read-only Memory Agent retrieval. It atomically submits the prompt with its memory delivery, submission binding, `ChatDoc` record and deadline index. The stable request ID lets a retry find the same logical submission and delivery.

The important identities are different:

| Identity | Purpose |
| --- | --- |
| Client `requestId` | Correlate a command/result and deduplicate prompt submission |
| Submission ID | Track placement, answer, or an unanswered outcome |
| Transcript entry ID | Locate persisted conversation content |
| Durable task ID | Identify execution and derive repeatable feature operation IDs |

A successful `result` for prompt submission acknowledges acceptance, not a completed answer. `computeProgress` combines submission records, delegate runs, pending child notices, and owed deliveries into client progress. A model run can finish while the user is still waiting for a visible result. Do not derive completion from a stopped stream alone or assume every command uses prompt-submission deduplication.

On object initialization, lulu opens the stored Harness, installs its extension registry, resumes durable work, reopens/configures the root conversation, and attaches state observers. Promise queues, submission caches, socket bookkeeping, and broadcast timers coordinate a live instance; they are not durable checkpoints. Changing persisted Doc kinds, versions, extension names, or task inputs requires considering existing sessions and migrations.

Sources: [BotSession](../core/src/conversation/bot.ts), [progress records](../core/src/conversation/progress.ts), [submission reads](../core/src/conversation/submissions.ts), and [harness installation](../core/src/agent/catalog.ts).

## Memory: sources, dreaming, resources, injection, and retrieval

[Memory concepts and boundaries](memory.md) defines the vocabulary, persisted state, and implementation details.

Dialogue compactions schedule durable update tasks. The Memory Object reads fixed transcript ranges, runs a separate Memory Agent, commits file changes with request IDs, and advances its cursor. Source dreaming is a separate durable task over a versioned snapshot of accepted Spaces, assets, and saved Space state. Collection changes, state writes, and startup reconciliation discover source revisions. Processing retries retain their source manifest; sequence checks reject obsolete source work.

The background agent owns memory writes and receives source-reading tools bound to its own durable submission. The main agent registers no memory read, search, resource-listing, or source-reading tools; it only receives the request-bound memory section delivered by read-only Memory Agent. Delegates inherit this passive boundary. Dreaming, retrieval, and the main agent have separate Harness registries.

Published resources are derived from one committed Markdown snapshot and expose identity, type, summary, provenance, commit version, and content reference. Clef gates whether retrieval is needed. Read-only Memory Agent reads exact versions and calls `inject_memory` to deliver organized context and provenance. The preparation snapshot and gate decision are persisted before retrieval, and final delivery is bound atomically with prompt admission. The memory section resolves this request binding, including delegate origins and related delivery notices. Empty or failed decisions clear the active section; old `RecallDoc` booleans and unconditional collection injection are no longer used.

The classifier uses `@cf/cloudflare/clef-flash` through the Workers AI `AI` binding; a missing binding or classification failure records an empty selection rather than injecting all memories. Current selection limits, source-reading limits, unbound scheduled-work behavior, and compatibility details are documented in [memory.md](memory.md).

## Delegated work and execution environments

`RunFamily` holds each delegate's status, child conversation, origin submissions, generation, durable wait task, output/error, and parent notice. `DelegateIndex` lists the run IDs. Spawning derives a stable run ID from the invoking tool task, then creates the run, ownership anchor, child conversation, and wait task in a transaction. An existing child ID prevents replay from creating another child for that run.

`DelegateWait` submits to the child using a repeatable request ID and waits for settlement. It atomically sends a result notice to the parent with a repeatable notice request ID, binds its memory context, and commits the run outcome. It rechecks whether the run is still active so a late result does not overwrite a cancellation. Aborting the wait aborts the child and marks the run `closed`; completed or failed runs can be resumed with a new generation, while closed runs cannot. Parent progress follows both child execution and the resulting notice.

The main agent delegates file/command work. Child tool wrappers enforce preset permissions and prevent children from delegating again or sending directly to the user. A child returns its answer to the parent, which owns user delivery.

Execution resources are tracked separately in the conversation-scoped `SandboxDoc`: backend/ref, owner, workspace epoch, active task leases, pending operation/request ID, and lifecycle task. A delegate binding resolves through its owner, so child conversations can share the parent's workspace; a new child is not necessarily a fresh isolated filesystem.

The lifecycle task persists `check`, `wait`, and `apply` phases. It renews resources while tasks use them, idles unused resources, and destroys them after the retention interval. External operations are reserved before calling the provider, and results are accepted only if the operation and workspace epoch still match. `WorkspaceLost` marks loss explicitly; stale results must not silently resurrect or replace a newer workspace. Startup recovery recreates a missing lifecycle task for an existing binding. Resource timing constants and backend behavior remain defined in code.

Sources: [run records](../core/src/delegate/runs.ts), [spawn transaction](../core/src/delegate/spawn.ts), [wait/settlement](../core/src/delegate/wait.ts), [tool guards](../core/src/delegate/extension.ts), [sandbox state](../core/src/sandbox/doc.ts), [workspace reservations](../core/src/sandbox/workspace.ts), and [lifecycle](../core/src/sandbox/lifecycle.ts).

## Scheduling and alarm recovery

`CronJobsDoc` stores job IDs, prompts, schedule definitions, state, `nextRunAt`, and the latest run reference. The supported schedules are a single timestamp and daily local time with an IANA time zone. Pausing/resuming changes the persisted job; process timers are not the schedule authority.

On alarm delivery, `fireDue` creates delegated work and advances the job in the same Harness transaction. Its run ID is derived from the job ID and scheduled occurrence, allowing a repeated alarm to address the same occurrence. A one-shot job marked `done` has been dispatched; consult the linked `RunFamily` for execution success or failure.

Late delivery is bounded by a grace period. Beyond it, a one-shot job becomes `missed`, and a recurring job advances to a future occurrence instead of replaying every missed occurrence. The watchdog marks overdue running jobs failed and requests child abortion when evaluated; it is not a hard real-time execution deadline.

The Bot's single alarm also supports durable-task recovery, memory-update retries, and sandbox lifecycle wakeups. `nextAlarmAt` chooses among scheduled work and task recovery deadlines; relevant committed changes trigger alarm reconciliation. A schedule-processing error schedules a recovery retry. New alarm users must participate in this arbitration rather than independently overwriting the Bot alarm. Memory processing retries use this arbitration rather than a separate Memory object alarm.

Sources: [schedule structures and time calculation](../core/src/cron/schedule.ts), [schedule tool](../core/src/cron/tool.ts), [dispatch/watchdog](../core/src/cron/engine.ts), and [alarm arbitration](../core/src/cron/alarm.ts).

## Sending, artifacts, and user acceptance

The chat UI renders successful `send_to_user` calls, not arbitrary assistant text. A text send contains a short bubble and an optional Markdown body; a widget send offers a single card. Artifact/space cards are checked against stored references before delivery. `end_turn` terminates the model run after the send; it does not imply the user accepted a card.

For the latest tracked user message, `DeliveryDoc` records bounded reminder submissions when a completed run produced no send. The reminders have stable request IDs and are reconciled against submissions and transcript entries. This is recovery from a silent assistant turn, not a client read receipt or proof the user saw the message.

Artifacts use versioned `artifact://name@version` references. The Artifact object reserves an upload/version, stores bytes through the S3 adapter, and commits metadata after verifying the object exists. Provided request IDs map retries to the same reservation, and recommitting an upload returns its existing version. Object storage and Durable Object metadata are not one distributed transaction; preserve the reserve/upload/commit boundary when adding write paths.

Card delivery and keeping are separate state changes. `widget.keep` resolves a delivered offer, then updates `AssetsDoc` or `PanelDoc`. Space revisions retain the widget ID and require acceptance; stored receipts prevent an old/retried offer from rolling back a newer accepted revision. Generating a file, delivering its card, and adding it to a user's assets or panel must not be conflated.

Sources: [send validation](../core/src/send/tool.ts), [delivery recovery](../core/src/send/delivery.ts), [artifact storage](../core/src/artifact/object.ts), [acceptance](../core/src/send/keep.ts), and [space receipts](../core/src/send/space-offers.ts).

## Clients and protocol

`core/src/protocol/` defines the shared wire structures. The web and desktop clients implement the same assistant experience; `client/ios/PiStackKit` contains the Swift protocol and session layer. Protocol changes need corresponding client changes.

A client sends `hello` after connecting. The server replies with model configuration and a full current state. Subsequent state frames include the complete entry `order` but only changed entry bodies; consumers merge bodies by entry ID and use `order` for membership and ordering. An empty `entries` array in an update does not clear the transcript. Reconnecting and sending `hello` obtains a fresh full state, rather than replaying a durable socket-event log. Local client caches and command acknowledgements are not the authoritative conversation state.

The wire contract is in [wire.ts](../core/src/protocol/wire.ts); frame validation is in [frame.ts](../core/src/conversation/frame.ts). Changes to frame shapes or Pi's serialized conversation view need review across web, desktop, and Swift consumers, including snapshot/merge behavior.

The public router uses `/api/bots/main/`. WebSockets carry conversation activity; HTTP routes expose memory, schedules, artifacts, spaces, and MCP administration. The current fixed bot identity is a single-user convention, not an authorization boundary. See [Security](../SECURITY.md).

## Integrations

Model registration and selection live in `core/src/agent/models.ts`. Sandbox selection lives in `core/src/sandbox/backends.ts`; the implemented backend type is E2B. MCP configuration, encryption, and authorization live under `core/src/agent/mcp*.ts`. Voice transport lives under `core/src/voice/`.

Telemetry is exported as OTLP/HTTP traces and converted into metrics by the external collector. [Observability](observability.md) describes deployment requirements and query conventions. Neither the collector nor external services are part of the Worker deployment.
