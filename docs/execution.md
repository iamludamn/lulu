# Delegation and scheduling

## Core APIs

| API | Purpose |
| --- | --- |
| [`delegate`](../core/src/delegate/tool.ts) | Run work in a child conversation and report the result to its parent. |
| [`schedule`](../core/src/cron/tool.ts) | Create and manage a one-time or daily job. |
| [`GET /api/bots/main/schedules`](../core/src/server/api.ts) | List current jobs and their latest run status. |
| [`BotAlarm`](../core/src/conversation/alarm.ts) | Wake the Bot for the earliest application deadline or Pi Durable recovery. |

## Core entities

| Entity | Identity and purpose |
| --- | --- |
| Delegate Run | `runId` in `RunFamily`. Tracks the child, status, and result delivery to the parent. |
| Scheduled Job | `jobId` in `CronJobsDoc`. Stores the schedule and the latest run reference. A one-time job marked `done` has been dispatched. |
| Sandbox Workspace | `SandboxDoc` tracks the owner, provider reference, and workspace epoch. Child conversations can share the owner's E2B workspace. |
