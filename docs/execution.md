# Delegation and scheduling

Each new delegate starts a fresh conversation. The task supplies the context the child needs. Resuming a delegate continues its existing conversation.

## Core APIs

| API | Purpose |
| --- | --- |
| [`delegate`](../core/src/delegate/tool.ts) | Run work in a child conversation and report the result to its parent. |
| [`schedule`](../core/src/cron/tool.ts) | Create and manage a one-time or daily job. Use `mode: "reminder"` for a user Alarm. The default task mode and jobs saved before this field use delegated execution. |
| [`GET /api/bots/main/schedules`](../core/src/server/api.ts) | List current jobs and their latest run status. |
| [`BotAlarm`](../core/src/conversation/alarm.ts) | Wake the Bot for the earliest application deadline or Pi Durable recovery. |

## Core entities

| Entity | Identity and purpose |
| --- | --- |
| Delegate Run | `runId` in `RunFamily`. Tracks the child, status, and result delivery to the parent. |
| Scheduled Job | `jobId` in `CronJobsDoc`. Stores the schedule and the latest run or submission reference. A one-time job marked `done` has been dispatched. |
| Alarm | A reminder job. At its due time the Bot durably queues a schedule event in the main conversation, and Lulu delivers the reminder in Chat through `send_to_user`. The Schedule Overview shows its job alongside scheduled tasks. |
| Sandbox Workspace | `SandboxDoc` tracks the owner, provider reference, and workspace epoch. Child conversations can share the owner's E2B workspace. |

Cloudflare Cron triggers daily schedules, including scheduled Space pulls, and one-time reminders with enough lead time. The Worker checks the saved jobs and forwards the occurrence to the existing Bot. The Bot admits the reminder or delegated run and advances the job in the same Pi Durable commit. Expired occurrences are dropped. A consumed one-time rule is removed when no other job needs that rule.

The Bot alarm handles short reminders and time during Cron propagation or registration failure. It also wakes Pi Durable for task recovery, request deadlines, provider retries, and immediate Space actions.

## Schedule end-to-end verification

Submit the test request through Chat on `/api/bots/main/ws` and wait for its confirmation. Read back the job ID, state, and `nextRunAt` from `GET /api/bots/main/schedules`. After triggering, reconnect and check that the matching reminder or task result appears in the conversation history. Give each request a unique visible marker so a replayed frame can be distinguished from a second durable message. Run reminders and delegated tasks separately so the trace can identify which path admitted the occurrence.

### Local tests for pull requests

Run the actual Worker, Bot DO, and Pi Durable SQLite under Wrangler or Miniflare. Use a deterministic model fixture that calls the real Schedule and Send tools. Stub the Cloudflare schedules API and the private object bucket. Record the complete rule set on each management API write. Use the normal Chat and HTTP routes for setup and inspection.

Use Wrangler's [`createTestHarness()`](https://developers.cloudflare.com/workers/testing/test-harness/interact-with-workers/) to dispatch `scheduled()` with the exact rule and UTC occurrence. [Local Explorer's scheduled endpoint](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally) supports manual reproduction. `scheduledTime` sets the event's timestamp. Test-clock cases also need to advance the application clock in both the Worker and Bot isolates. For the cleanup case, advance past expiry and fire the alarm already armed by the Bot using [`runDurableObjectAlarm()`](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/#testing-alarms). Use a separate real-clock short-timer case to verify that Cloudflare's local alarm runtime wakes the Bot itself.

| Case | How to exercise it | Pass criteria |
| --- | --- | --- |
| One-time Cron | Create a reminder at least 20 minutes ahead with a nonzero seconds component. Confirm registration, advance to the rounded UTC minute, and inject the same event twice concurrently. | One admission and one durable Chat reminder. The job is `done`, `nextRunAt` is null, and the rule is removed. An early event and the same calendar rule a year later produce no reminder. |
| Daily reminder and shared rule | Create two independent jobs that resolve to the same daily UTC rule. Deliver that tick, replay it, then deliver the following day's tick. Pause or delete each job in turn. | One registered rule while either job needs it. One reminder per job per valid day. `nextRunAt` follows each job's local time. Paused/deleted jobs produce no side effect even if an in-flight tick arrives. Remove the rule after its last active user leaves. |
| Time zone and delayed event | Exercise a fixed-offset zone and a DST zone on both sides of an offset transition. Inject the alternate UTC rule at the wrong local time. Replay a recurring tick more than five minutes late, then deliver the next valid occurrence. | Only the correct local occurrence runs. An expired tick produces no reminder or run. The next valid one runs once, with no accumulated backfill. |
| Short timer and failed registration | Create a one-minute reminder and leave its real DO alarm armed. Separately return an error from the control plane for a daily job and retry after it recovers. | The short timer delivers without acquiring a temporary Cron rule. The daily job has a local wake during registration failure and hands off after registration and propagation. Delivering both wake paths for one occurrence produces only one result. |
| Missing/expired one-time event | Register a one-time reminder, omit its event, and let the expiry cleanup run. Replay the event afterward. Also exercise an event received after the grace window. | The job becomes `missed`, there is no Chat message or task run, and the rule disappears. The late replay does not recreate the job or rule. |
| Delegated task and daily Space pull | Schedule a task that runs a deterministic subagent operation and a Space that fetches a versioned fixture once per day. Replay their Cron event. | One completed delegated run with a durable result. The Space makes one data fetch for the occurrence and exposes the expected version/status through `GET /spaces/refresh`. |
| Disconnected client and recovery | Disconnect Chat before firing. Restart the local runtime with its native store, then replay the event. In a separate fixture, restore schedules from external storage into a fresh Bot store before delivering a future tick. | The first result is visible once after reconnect. Completed occurrences stay completed after replay. Restored schedules retain their IDs, state, and time zones and can execute their next valid occurrence. |

### Real Cloudflare release check

Use an isolated Worker with its own Bot namespace, private object bucket, and Cron credentials. The management API replaces the script's Cron list. Create a short timer, a daily reminder, a one-time Cron reminder, and a delegated task through Chat. Put the Cron cases at distinct UTC minutes at least 20 minutes ahead so registration has time to propagate. Record the rule list after creation, close Chat before the scheduled minutes, and let Cloudflare deliver the events. Reconnect to verify the persisted results and read the rule list again to confirm one-time cleanup. Also pause a separate reminder before its due time and confirm it produces no output.

Capture `jobId`, scheduled occurrence, registered UTC rule, handler start, persisted result, and first Chat observation. Use the Worker Cron invocation and `bot.cron` trace to prove the long-lead cases took the Cron path. Verify the short timer via `bot.alarm`. An on-time message alone can also be produced by the fallback.

Measure Cron lateness from the expected Cron minute to the Worker entry, admission latency from Worker entry to the durable submission or run, and delivery latency from admission to the Chat result. Use one minute as the release target for Cron arrival and five minutes from the job occurrence as the current expiry boundary. Report delivery latency separately from scheduling latency. A missing result, duplicate admission, unexpected wake path, early execution, or remaining one-time rule fails the check. Recheck the management rule list after the cleanup write and allow up to 15 minutes for the deletion to propagate globally. [Cloudflare Cron Trigger behavior](https://developers.cloudflare.com/workers/configuration/cron-triggers/#2-update-configuration)
