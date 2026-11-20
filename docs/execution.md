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
