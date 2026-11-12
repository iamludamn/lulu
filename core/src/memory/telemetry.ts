import type { SpanAttributes, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";

export function memorySpan<T>(telemetry: TelemetryContext, name: string, attributes: SpanAttributes, task: (span: TelemetrySpan) => Promise<T>): Promise<T> {
  return telemetry.startSpan({ name, attributes: { "lulu.agent": "memory", ...attributes } }, async (span) => {
    try {
      return await task(span);
    } catch (error) {
      span.setAttributes({ "lulu.memory.outcome": "failed" });
      span.setStatus({ status: "error", error: { name: "MemoryError", message: "memory operation failed" } });
      throw error;
    }
  });
}

export function memoryTelemetry(telemetry: TelemetryContext, botId: string, requestId?: string, conversationId?: string): TelemetryContext {
  return {
    startSpan: (options, task) => telemetry.startSpan({ ...options, attributes: { "lulu.bot.id": botId, "lulu.memory.request_id": requestId, "lulu.conversation.id": conversationId, ...options.attributes } }, task),
  };
}
