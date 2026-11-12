import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";

export function recordModelUsage(span: TelemetrySpan, assistant: AssistantMessage): void {
  const prompt = assistant.usage.input + assistant.usage.cacheRead + assistant.usage.cacheWrite;
  span.setAttributes({
    "gen_ai.provider.name": assistant.provider,
    "gen_ai.request.model": assistant.model,
    "gen_ai.response.model": assistant.responseModel ?? assistant.model,
    "gen_ai.response.id": assistant.responseId,
    "gen_ai.response.finish_reasons": [assistant.stopReason],
    "gen_ai.usage.input_tokens": assistant.usage.input,
    "gen_ai.usage.output_tokens": assistant.usage.output,
    "gen_ai.usage.cache_read.input_tokens": assistant.usage.cacheRead,
    "gen_ai.usage.cache_creation.input_tokens": assistant.usage.cacheWrite,
    "lulu.usage.total_tokens": assistant.usage.totalTokens,
    "lulu.usage.prompt_tokens": prompt,
    "lulu.usage.cost": assistant.usage.cost.total,
    "lulu.usage.cost_status": assistant.usage.cost.total > 0 ? "estimated" : "unpriced_or_free",
    "lulu.usage.cost.input": assistant.usage.cost.input,
    "lulu.usage.cost.output": assistant.usage.cost.output,
    "lulu.usage.cost.cache_read": assistant.usage.cost.cacheRead,
    "lulu.usage.cost.cache_write": assistant.usage.cost.cacheWrite,
    "lulu.usage.cache_hit_ratio": prompt > 0 ? assistant.usage.cacheRead / prompt : undefined,
  });
}
