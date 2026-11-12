# Observability

Telemetry is self-hosted on the omarchy machine. Honeycomb is no longer used.

## Data flow

1. The worker exports OTLP/HTTP JSON traces only (`core/src/telemetry/otlp.ts`). It emits no metrics.
2. Worker configuration:
   - `OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.ludamn.xyz`, a var in `apps/cf/wrangler.jsonc`.
   - `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>`, a secret that must be in the secrets file on deploy.
3. A Cloudflare Tunnel named `lulu-otel` routes `otel.ludamn.xyz` to the collector on omarchy.
4. The OpenTelemetry Collector (contrib) rejects requests without the bearer token, derives metrics from spans with the `span_metrics` and `signal_to_metrics` connectors, and forwards everything to `grafana/otel-lgtm` (Grafana, Tempo, Prometheus, Loki).

The stack lives in `~/observability/` on omarchy (`docker-compose.yml`, `otelcol.yaml`, `.env`, `grafana/`). The collector configuration is versioned at `ops/observability/otelcol.yaml`. Copy it to `~/observability/otelcol.yaml` and recreate the collector after reviewing local changes. Copy `ops/observability/lulu-cost.json` to `~/observability/grafana/dashboards/`; the existing file provider loads it automatically. Keep the compose file and secrets on the host.

## Reading the data

- Humans: the Grafana dashboard `lulu-overview`.
- Agents: the `grafana` MCP server (read-only service account). Use TraceQL for traces and PromQL for metrics.
- Metric names:
  - `lulu_span_calls_total`
  - `lulu_span_duration_milliseconds_{bucket,count,sum}`
  - `lulu_run_{turns,chats,tools,tool_errors,input_tokens,output_tokens,cost}_total`
  - `lulu_chat_{input_tokens,output_tokens,cache_read_tokens,cost}_total`
- Counters use delta temporality, because Prometheus runs with `otlp-native-delta-ingestion`. Query them with `sum_over_time`, not `rate` or `increase`.

## Span conventions

The span names and attributes are defined in code under `core/src/telemetry/` and at the call sites. Two rules matter for the derived metrics:

- Every span carries `lulu.bot.id`, `lulu.agent` and `lulu.conversation.kind` (`root` or `delegate`).
- A new attribute used as a dashboard dimension must also be listed in the collector connector config in `otelcol.yaml`, otherwise it is dropped from the derived metrics.

## Token costs

The `lulu-cost` dashboard uses chat spans to count root and delegate model calls once, including calls in runs that have not finished. It shows input, output, cache read and cache write tokens, model/provider cost, and the four cost components. Do not add run costs to chat costs: they summarize the same calls. Costs are USD estimates returned by pi using model pricing, not reconciled provider invoices; models with missing or zero pricing can report zero cost. Historical spans cannot populate newly added metric dimensions or cost components.

Chat metrics include `gen_ai.request.model`, `gen_ai.provider.name` and `lulu.agent` dimensions. Cost component counters are `lulu_chat_cost_{input,output,cache_read,cache_write}_total`; cache writes use `lulu_chat_cache_write_tokens_total` and `lulu_run_cache_write_tokens_total`.

## Memory diagnostics

`ops/observability/lulu-memory.json` adds the `lulu-memory` Grafana view. Install it through the same dashboard file provider as `lulu-cost.json`, and load the matching collector configuration. Worker instrumentation, collector dimensions and dashboards must be rolled out together; historical traces do not backfill metrics.

A committed `CompactionEntry` in the main conversation creates a durable background `pistack.memory.update` task. Failed, declined or summary-free compactions and delegate compactions do not trigger it. User messages no longer schedule memory, and there is no ten-minute window. Recovery scans the durable transcript and atomically advances a trigger Doc with task creation, so repeated publication/restart discovery does not enqueue the same compaction twice. The background task retries processing failures after one hour; its checkpoint drives the Bot recovery alarm. Legacy Memory DO alarms are cleared when delivered.

`memory.update` records processing latency, retry diagnostics, total episode count, batch count, source conversation ID and cursor target/checkpoint. Source reads are bounded by the committed compaction entry and paged in batches of 200 entries until that boundary is reached. Later conversation entries wait for a later compaction. Child `memory.remember` and `memory.consolidate` spans distinguish committed, replay, empty, unchanged, blocked and failed outcomes. Blocked-file counts also cover partially accepted commits. Cursor differences are not episode counts. Consolidation is checked during triggered processing, not by a daily cron; a failed consolidation is retried even after the episode cursor was checkpointed.

The internal Memory object's `/status` response contains the last successful update time, retry diagnostics and processing cursor. These diagnostics are not another work queue: the Bot's durable update task, the processing cursor and commit request IDs remain authoritative. Pending-age and lateness histograms are observations during processing, not continuously refreshed gauges; missing samples do not establish healthy inactivity.

`memory.recall` includes unconfigured, timeout and error fallbacks; `none` means a classifier decision. `memory.context.delivery` separately records refreshed/reused/empty/failed and actual availability. `inject=false` can still reuse a previously shown section. `memory.context.build` measures files, characters and clipped system files. Empty stores still supply the existing memory instruction wrapper. `memory.retrieve` records read/list/grep outcomes without queries, paths or passages. Success does not establish factual correctness or model use.

Memory model tokens and estimated USD use existing chat counters filtered by `lulu_agent="memory"`; never add run summaries. New metric dimensions are bounded outcomes and booleans. Bot/request/cursor correlation belongs in restricted traces and internal status, not additional metric dimensions. The forward connector copies traces into a metrics-only processing branch, where the transform removes bot IDs from memory spans and memory-agent activity before aggregation; exported traces retain their correlation attributes. No prompts, episodes, paths, commit summaries or raw processing errors are added by this instrumentation. Diagnostic status is a single overwritten record; each processing attempt adds a small fixed number of spans, plus context/retrieval spans on demand.

Grafana anonymous access is disabled on the host, OTLP requires bearer authentication, and service ports bind to loopback or the private network. Keep trace access restricted to operators. Trace retention and identity-level authorization are host settings, not configured by these repository files; verify the active Tempo retention before relying on any retention guarantee. The operational target is seven days for diagnostic traces with operator-only access; this change does not apply or claim those host settings. No alerts or automatic enforcement are enabled.

## Cloudflare resource and cost baseline (2026-11-12)

Read-only production queries ended at **2026-11-12 04:35:29 UTC**. November 12 is partial. The source is Cloudflare REST deployment/settings/subscriptions/billing APIs and GraphQL analytics, scoped to the `lulu` script and its namespaces. Analytics may be sampled and are not billing meters. Existing `lulu_chat_cost_total` and `lulu_run_cost_total` represent model pricing estimates, never Cloudflare infrastructure charges.

### Deployed inventory

| Resource | Deployment evidence |
| --- | --- |
| Worker `lulu` | Standard usage model, compatibility date `2026-10-06`, `nodejs_compat`; no explicit CPU limit returned. Standard does not independently establish the account's Paid subscription. |
| Bot SQLite DO | `BOTS`, namespace `5e8e206cdcdf43ada6b37dc6c076944e` |
| Memory SQLite DO | `MEMORY`, namespace `8052c218316c420ebdf7e9851f921977` |
| Artifact SQLite DO | `ARTIFACTS`, namespace `283988c20fc1447681c8075abf12b281` |
| KV | `LULU_MCP`, namespace `92e198ee66014ccdb1e69776615c880c` |
| Static assets | Deployed with SPA fallback; `/api/*` runs the Worker first. Direct static asset requests are free under the public pricing below. |
| Logs | Persistence and invocation logs enabled, head sampling 100%; Cloudflare traces and Logpush disabled. Application OTLP tracing is separate. |
| Artifact S3 | Endpoint and bucket are secret bindings. Provider unconfirmed; account-level R2 enablement is insufficient to attribute any R2 charge to Lulu. |

### Usage and coverage

Subscriptions returned a visible product cycle of **October 18–November 18**, but did not establish the Workers billing cycle. A query using the preceding complete reference cycle, **September 18–October 18**, returned no rows for the queried Worker, DO, SQLite and KV datasets. This is unavailable history, not proof of zero consumption. Querying all of October returned only October 31. Calendar month-to-date is shown separately from that reference cycle.

| Metric | November 1–12, to query cutoff | Unit |
| --- | ---: | --- |
| Worker requests | 857 | requests |
| Worker CPU | 5,230.651 | ms |
| Worker errors | 5 | errors |
| DO requests | 3,908 | requests, across three namespaces |
| DO duration | 4,235.465 | GB-s |
| SQLite reads | 14,550,987 | rows |
| SQLite writes | 172,277 | rows |
| KV reads / lists | 1,327 / 310 | operations |

KV writes/deletes returned no operation rows; no-row is not asserted as measured zero. KV daily storage returned 0 bytes and 0 keys despite read traffic, so it is not a reliable basis for declaring the namespace empty. October 31 returned 10 Worker requests, 27.54 CPU ms, 270 DO requests, 203.955 DO GB-s, 676,805 SQLite rows read, 37,592 written and 10 KV lists. Adaptive sample intervals included 10 on October 31; most November intervals were 1, with some higher. Do not treat these analytics as exact invoice quantities.

| DO | MTD requests | MTD rows read | MTD rows written | November 12 daily maximum storage, bytes |
| --- | ---: | ---: | ---: | ---: |
| Bot | 1,382 | 12,291,441 | 127,997 | 7,516,160 |
| Memory | 927 | 2,258,317 | 44,152 | 5,079,040 |
| Artifact | 1,599 | 1,229 | 128 | 61,440 |

Daily maximum storage is not time-integrated GB-month. The following UTC daily trends preserve missing rows as `n/a`; the final row is partial.

| Date (2026) | Worker requests | Worker CPU ms | DO requests | KV reads | KV lists |
| --- | ---: | ---: | ---: | ---: | ---: |
| Nov 01 | n/a | n/a | n/a | n/a | n/a |
| Nov 02 | 2 | 2.226 | 136 | 32 | 16 |
| Nov 03 | 87 | 749.851 | 542 | 46 | 23 |
| Nov 04 | 105 | 905.670 | 618 | 131 | 35 |
| Nov 05 | 7 | 64.404 | 39 | 24 | 6 |
| Nov 06 | 10 | 69.620 | 32 | 20 | 5 |
| Nov 07 | 58 | 272.652 | 271 | 79 | 14 |
| Nov 08 | 36 | 200.795 | 168 | 48 | 10 |
| Nov 09 | 231 | 1,330.269 | 928 | 556 | 127 |
| Nov 10 | 69 | 391.752 | 325 | 125 | 24 |
| Nov 11 | 249 | 1,211.636 | 834 | 258 | 48 |
| Nov 12 | 3 | 31.776 | 15 | 8 | 2 |

Read-only retained-log aggregate counts for November 6–11 were 43, 353, 204, 1,206, 502 and 1,128 events; November 9 included sampling. November 5 was already retention-truncated, so neither full MTD nor previous-cycle logs could be recovered. Retained log events are not the billed written-event meter. No message bodies were retrieved for this analysis.

### Pricing and reconciliation

Public reference prices checked November 12, 2026, in USD; the account's Workers Paid subscription/contract was not established by the returned subscription list. These are account-wide shared allowances, not allowances reserved for Lulu:

| Paid product | Monthly included usage | Public excess price |
| --- | --- | --- |
| Workers | 10M requests; 30M CPU ms | $0.30/M requests; $0.02/M CPU ms |
| DO compute | 1M requests; 400,000 GB-s | $0.15/M requests; $12.50/M GB-s |
| DO SQLite | 25B rows read; 50M rows written; 5 GB-month | $0.001/M rows read; $1/M rows written; $0.20/GB-month |
| KV | 10M reads; 1M each writes/deletes/lists; 1 GB | $0.50/M reads; $5/M each writes/deletes/lists; $0.50/GB-month |
| Workers Logs | 20M events; 7-day retention | $0.60/M events; announced Observability pricing starts December 1, 2026 |

Workers Paid has a $5 minimum monthly charge. Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/). Future logging prices must not be applied to this baseline.

`subscriptions` and `billing/history` were accessible but did not establish a Lulu-specific infrastructure total. V1 `billable-usage` returned account-level R2 for a period beginning October 18, without a Lulu dimension and without honoring the requested historical window. V2 `billable/usage` returned HTTP 403 / `1171 insufficient_permissions`. No actual Lulu billed total or allowance-adjusted estimate is reported. Reconciliation needs applicable account plan, product billing quantities for the correct cycle, other workloads' shared usage, and confirmed S3 provider. Summing retail prices against Lulu analytics alone would misallocate shared quotas and conceal missing products.

### Priorities and ongoing visibility

1. **Investigate Bot lifetime first.** Bot accounts for approximately 97.6% of returned DO duration, with approximately 32,287 active seconds versus 660 CPU seconds MTD. Check external-call waits, timers and hibernation eligibility. This is a measured concentration, not proof of a leak. Diagnostic effort is moderate; shortening legitimate waits or changing socket handling can affect recovery and reliability, so measure before changing behavior.
2. **Correlate Bot errors and retries.** Approximately 365 Bot errors were returned against 1,382 requests. Trace correlation should distinguish recovery, retries and terminal errors before attempting to reduce writes or invocations. This is a relatively small investigation with potentially useful reliability and duration benefits; no retry amplification has yet been established.
3. **Confirm storage and logging attribution.** Establish the deployed S3 provider/bucket privately before querying R2 usage. Track written log events before changing 100% persistence. Investigation effort is small; sampling logs prematurely can remove failure evidence. Current data does not establish either as a major cost driver.
4. **Defer SQLite/KV optimization.** Their measured volumes are small relative to the published Paid allowances; quantify account-wide contention before considering changes with durability or cache-consistency trade-offs. Keep model, E2B and other external-service charges separate.

The ongoing exporter and Grafana dashboard are described below. They use aggregate product/class trends; they do not invent per-user billed attribution. Log written-event metering and confirmed R2 attribution remain coverage gaps.

Initially flag failed collection and data older than two scheduled collections for operator review. Investigate daily usage above twice the median of the preceding seven complete, adequately covered days, only after sufficient history exists; low-volume ratios need absolute-volume context. These are proposed diagnostic thresholds, not spending limits or enabled alerts. Grafana is sufficient for this baseline; no end-user cost UI or automatic enforcement is justified by the available data.

## Actual memory injection counts

The top cards of `lulu-memory` count `lulu_memory_request_attempts_total` at the official `GenerationTask.beforeRequest` hook. The hook reads the effective `memory` section with pi-ai's transcript replay helper. A section render alone does not increment this counter: preparation can run again for compaction before a model request is attempted.

Coverage is `content` when rendered system files contain text beyond headings/frontmatter, `catalog` for descriptions of other files only, `template` for instructions or frontmatter-only seeds, `none` when the section is absent, and `unknown` for unrecognized historical formatting. This measures supplied content, not the correctness of a fact or proof the model used it. The existing section text and injection policy are preserved.

Each tool round, retry or recovered request attempt counts separately; these are model-request attempts, not unique user messages or exactly-once provider receipts. Section refresh/reuse remains a separate diagnostic. Use the dashboard time range for total counts. Missing metrics display **Not observed**, not zero; no historical injection count is inferred from alarm or retrieval counts. Deploy the worker and matching collector configuration before expecting these counters.

## Ongoing Cloudflare usage collection

`ops/observability/cloudflare.mjs` exports Cloudflare Analytics window gauges into the existing loopback Prometheus OTLP receiver at `http://127.0.0.1:9090/api/v1/otlp/v1/metrics`. The host already enables that receiver. No new public endpoint or collector restart is required for these metrics. `lulu-cloudflare.json` is the Grafana dashboard; copy it into the existing dashboard file-provider directory.

The exporter queries six datasets independently for the rolling 24 hours and previous complete UTC day: Worker invocation estimates, DO invocations, DO periodic usage, **durableObjectsSqlStorageGroups**, KV operations and KV storage. Namespaces/script filters are fixed to this Lulu deployment. Rows and CPU units come from the verified schema; microseconds are converted to seconds, and DO duration is already GB-s. Storage is the maximum observed value in a window. Average sample intervals are metadata: the returned sums are already extrapolated, so they are not multiplied again. Sources: [Cloudflare sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/) and [DO metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/).

All `lulu_cf_*` metrics are **gauges**, including requests and rows. Query the latest window value; do not use `rate`, `increase`, or sum repeated observations as additional usage. The dashboard uses a 45-minute lookback for the fifteen-minute collection interval. Separate window start/end timestamps identify the period being observed. No usage value is emitted for missing resource/action rows. `collection_success`, `data_present`, `sample_interval`, `data_timestamp`, and exporter health distinguish missing rows, failed API queries, stale data and credential-host failures. Usage panels hide the previous value when a new query fails or returns no resource row. KV storage zeros are displayed as the API observation with an explicit caveat, not proof of an empty namespace.

The omarchy user timer invokes `node ops/observability/cloudflare.mjs --remote` every fifteen minutes. It sends the source over SSH to the Mac, runs it under `op run --environment dwa4hq6cqvhqrxt3jywkaadhzy`, and receives only aggregate OTLP data. Cloudflare credentials stay in 1Password and the remote process environment; no secret is stored in the service file or omarchy repository. Only the local Prometheus loopback endpoint receives the result. The six datasets in two windows require twelve bounded GraphQL requests per collection. Requests timeout and failures are isolated by dataset; no account billing total is estimated.

Install `lulu-cloudflare.service` and `lulu-cloudflare.timer` from `ops/observability/` into `~/.config/systemd/user/`, run `systemctl --user daemon-reload`, then `systemctl --user enable --now lulu-cloudflare.timer`. The service expects this repository at `~/projects/lulu`, `mise` at `/usr/bin/mise`, and the configured linked Mac SSH identity. For a host with its own 1Password access, `op run --environment dwa4hq6cqvhqrxt3jywkaadhzy -- node ops/observability/cloudflare.mjs` collects directly. `CF_METRICS_ENDPOINT` optionally changes the loopback OTLP metrics URL; remote/public destinations are rejected.

This intentionally exposes the remaining credential availability gap: Mac sleep/offline status or 1Password authentication after restart can stop CF collection. A failed remote collection still exports local exporter health, while dataset freshness ages visibly. An initial collection succeeded, but subsequent unattended invocations exited with authorization timeout (code 9). The local timer was stopped after this observation. The service also stops its timer on future code-9 authorization failures to avoid repeated desktop prompts. After establishing unattended access, restart `lulu-cloudflare.timer`; simply having the desktop app running is insufficient. Moving credential access to an always-on host requires a supported unattended 1Password identity; it is not replaced with a plaintext token. The timer adds no alerts, budget enforcement or runtime changes to the Lulu Worker.

The primary memory card combines `content` and `catalog`, with separate cards for each. When another coverage value was observed in the selected range, an absent coverage category is shown as zero. When no request instrumentation was observed at all, every count remains **Not observed**. The previously deployed pipeline has no request coverage counter, so historical alarm or memory-read activity cannot establish how many model requests included memory.
