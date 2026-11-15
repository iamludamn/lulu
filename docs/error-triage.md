# Error triage

Use the cross-project triage process from agent-home; keep lulu-specific queries and tooling in this repository.

## Scope and telemetry

- Repository: `iamludamn/lulu`; integration branch: `main`; Linear team: `LUD`, project: `lulu`.
- Read [Observability](observability.md) for the current self-hosted Grafana stack, TraceQL/PromQL queries, metric names, access and span conventions. Honeycomb is no longer used.
- For the scheduled triage window, inspect prior completed T3 runs whose title contains `lulu 遥测`, excluding the current run, and use the most recent completed run's `startedAt`. Fall back to the last 24 hours if unavailable. Read the schedule for its actual timing.
- Inspect error spans and application failure events, including `lulu.retry` and `lulu.task_failed` where emitted by the current code. Errors may exist only in events, so compare traces with runtime state and verify actual event fields at their call sites.

## Runtime state

Run `node ops/observability/lulu-state.mjs <24h | ISO-time>` from the repository root. `LULU_WS` overrides the default worker WebSocket URL.

The script waits for a state message with conversation entries and prints MCP connectivity, model/tool/delegate failures, progress errors and a compact conversation transcript. Large states may take several seconds; the timeout is 90 seconds. Keep the output in the current diagnostic session; do not copy raw conversations into tickets, PRs or persisted reports. Use only necessary redacted evidence.

Build and deployment requirements remain in AGENTS.md and [Deployment](deployment.md); do not deploy as part of a read-only triage task.
