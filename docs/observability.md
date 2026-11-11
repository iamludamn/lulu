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
