# Observability

## Set up telemetry

The Worker sends OTLP traces and metrics to an authenticated OpenTelemetry Collector. The [collector config](../ops/observability/otelcol.yaml) also derives metrics from spans and forwards to Tempo and Prometheus through LGTM.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to your collector's HTTPS base URL and inject `OTEL_EXPORTER_OTLP_HEADERS` with the bearer token that matches the collector's `OTLP_TOKEN`. Import the dashboard JSON from [ops/observability](../ops/observability). New dashboard dimensions must also be configured in the collector.

## Find the right data

| Question | Where to look |
| --- | --- |
| Which request or tool failed? | Use TraceQL in Tempo. Filter by `lulu.bot.id`, `lulu.agent`, or `lulu.conversation.kind`. |
| How much model or service activity occurred? | [Cost](../ops/observability/lulu-cost.json) and [Services](../ops/observability/lulu-services.json) use delta metrics. Query with `sum_over_time`. Model costs are estimates. |
| Did memory reach the model? | [Memory](../ops/observability/lulu-memory.json) tracks injection on model-request attempts. |
| Did replies reach clients? How long were sandboxes ready? | [Chat Delivery](../ops/observability/lulu-chat-delivery.json) and [Sandbox Occupancy](../ops/observability/lulu-sandbox-occupancy.json) read the Bot's durable ledger. |
| What usage did providers report? | [Cloudflare](../ops/observability/lulu-cloudflare.json) and [Services](../ops/observability/lulu-services.json) show sampled window gauges. Use the latest value and check collection freshness. |

For ledger dashboards, configure a server-side Prometheus data source with UID `lulu-sandbox-accounting`, HTTP method `GET`, and URL `<private Worker origin>/api/bots/main/observability`. Use `Authorization: Bearer <LULU_OBSERVABILITY_TOKEN>` and set the matching Worker secret.

## Check the collectors

The [Cloudflare](../ops/observability/lulu-cloudflare.service) and [service account](../ops/observability/lulu-service-accounts.service) user timers collect every 15 minutes using the encrypted `op-token` credential configured in their service units. They send metrics to the local Prometheus OTLP receiver.

```sh
systemctl --user list-timers 'lulu-*'
journalctl --user -u lulu-cloudflare.service -u lulu-service-accounts.service -n 50
```

For a Bot snapshot, run `node ops/observability/lulu-state.mjs 24h` with `LULU_WS` and any required `LULU_CHAT_TOKEN` supplied through the environment. Treat transcript output as private.
