# Chat

Chat is the native client page for user and assistant messages. The Bot Durable Object owns the root conversation and exposes its state over WebSocket.

## Prompt submission and progress

The WebSocket command `prompt.submit` carries a client-generated `requestId`, content, and a busy mode (`steer` or `followUp`). `BotSession` orders prompt submissions and prepares request-scoped memory through the decision gate and read-only Memory Agent retrieval. It atomically submits the prompt with its memory delivery, submission binding, `ChatDoc` record and deadline index. The stable request ID lets a retry find the same logical submission and delivery.

Use the ID that matches the operation.

| Identity | Purpose |
| --- | --- |
| Client `requestId` | Correlate a command/result and deduplicate prompt submission |
| Submission ID | Track placement, answer, or an unanswered outcome |
| Transcript entry ID | Locate persisted conversation content |
| Durable task ID | Identify execution and derive repeatable feature operation IDs |

A successful `result` for prompt submission acknowledges acceptance. The visible answer arrives through Chat delivery. `computeProgress` combines submission records, delegate runs, pending child notices, and owed deliveries into client progress. A model run can finish while the user is still waiting for a visible result. Do not derive completion from a stopped stream alone or assume every command uses prompt-submission deduplication.

On object initialization, lulu opens the stored Harness, installs its extension registry, resumes durable work, reopens/configures the root conversation, and attaches state observers. Promise queues, submission caches, socket bookkeeping, and broadcast timers coordinate a live instance. Durable state provides the checkpoints for recovery. Changing persisted Doc kinds, versions, extension names, or task inputs requires considering existing sessions and migrations.

Sources: [BotSession](../core/src/conversation/bot.ts), [progress records](../core/src/conversation/progress.ts), [submission reads](../core/src/conversation/submissions.ts), and [harness installation](../core/src/agent/catalog.ts).

## Delivery

Use `send_to_user` to deliver text or a card. Text contains a short bubble and an optional Markdown body. A card offers a Widget or Asset through the [acceptance flow](panel-and-assets.md). `end_turn` terminates the model run after delivery.

For the latest tracked user message, `DeliveryDoc` records bounded reminder submissions when a completed run produced no send. The reminders have stable request IDs and are reconciled against submissions and transcript entries. Use client delivery receipts to observe whether the client received a reply.

See [send validation](../core/src/send/tool.ts) and [delivery recovery](../core/src/send/delivery.ts).

## WebSocket state

A client sends `hello` after connecting and receives model configuration and a full snapshot. For clients that opt into incremental updates, a frame with `order` specifies entry membership and order. Merge changed entry bodies by ID and clear the local view on an explicit reset. Reconnect and send `hello` to refresh the snapshot. Local caches and command acknowledgements are client projections.

The wire contract is in [wire.ts](../core/src/protocol/wire.ts); frame validation is in [frame.ts](../core/src/conversation/frame.ts). Changes to frame shapes or Pi's serialized conversation view need review across desktop and Swift consumers, including snapshot/merge behavior.
