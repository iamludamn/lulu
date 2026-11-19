# Delegation and scheduling

A delegate run executes in a child conversation. Scheduled jobs create delegate runs, and file or command work can use an E2B workspace.

## Delegate runs

`RunFamily` holds each delegate's status, child conversation, origin submissions, generation, durable wait task, output/error, and parent notice. `DelegateIndex` lists the run IDs. Spawning derives a stable run ID from the invoking tool task, then creates the run, ownership anchor, child conversation, and wait task in a transaction. An existing child ID prevents replay from creating another child for that run.

`DelegateWait` submits to the child using a repeatable request ID and waits for settlement. It atomically sends a result notice to the parent with a repeatable notice request ID, binds its memory context, and commits the run outcome. It rechecks whether the run is still active so a late result does not overwrite a cancellation. Aborting the wait aborts the child and marks the run `closed`; completed or failed runs can be resumed with a new generation, while closed runs cannot. Parent progress follows both child execution and the resulting notice.

The main agent delegates file/command work. Child tool wrappers enforce preset permissions and prevent children from delegating again or sending directly to the user. A child returns its answer to the parent, which owns user delivery.

## Sandbox workspaces

Execution resources are tracked separately in the conversation-scoped `SandboxDoc`: backend/ref, owner, workspace epoch, active task leases, pending operation/request ID, and lifecycle task. A delegate binding resolves through its owner, so child conversations can share the parent's workspace; the owner determines which workspace a new child uses.

The lifecycle task persists `check`, `wait`, and `apply` phases. It renews resources while tasks use them, idles unused resources, and destroys them after the retention interval. External operations are reserved before calling the provider, and results are accepted only if the operation and workspace epoch still match. `WorkspaceLost` marks loss explicitly; stale results must not silently resurrect or replace a newer workspace. Startup recovery recreates a missing lifecycle task for an existing binding. Resource timing constants and backend behavior remain defined in code.

Sources: [run records](../core/src/delegate/runs.ts), [spawn transaction](../core/src/delegate/spawn.ts), [wait/settlement](../core/src/delegate/wait.ts), [tool guards](../core/src/delegate/extension.ts), [sandbox state](../core/src/sandbox/doc.ts), [workspace reservations](../core/src/sandbox/workspace.ts), and [lifecycle](../core/src/sandbox/lifecycle.ts).

## Scheduled jobs and alarm recovery

`CronJobsDoc` stores job IDs, prompts, schedule definitions, state, `nextRunAt`, and the latest run reference. The supported schedules are a single timestamp and daily local time with an IANA time zone. Pause and resume update the persisted job, which determines when it will run.

On alarm delivery, `fireDue` creates delegated work and advances the job in the same Harness transaction. Its run ID is derived from the job ID and scheduled occurrence, allowing a repeated alarm to address the same occurrence. A one-shot job marked `done` has been dispatched; consult the linked `RunFamily` for execution success or failure.

Late delivery is bounded by a grace period. Beyond it, a one-shot job becomes `missed`, and a recurring job advances to a future occurrence instead of replaying every missed occurrence. The watchdog marks overdue running jobs failed and requests child abortion when evaluated; it is not a hard real-time execution deadline.

The Bot uses one Durable Object alarm for application deadlines and Pi Durable recovery. `BotAlarm` chooses the earliest time from the application deadline, the Harness wake time, and the recovery deadline. Application deadlines cover scheduled jobs, running delegate and request deadlines, memory dreaming retries, Space refresh, push retries, and Chat delivery. Use the Bot alarm for new wakeups so they participate in the same arbitration. Memory processing retries resume through the Harness wake time.

Sources: [schedule structures and time calculation](../core/src/cron/schedule.ts), [schedule tool](../core/src/cron/tool.ts), [dispatch/watchdog](../core/src/cron/engine.ts), [schedule deadlines](../core/src/cron/alarm.ts), and [Bot alarm arbitration](../core/src/conversation/alarm.ts).
