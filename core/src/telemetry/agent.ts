import { RunFamily, type RunDoc } from "../delegate/runs.js";
import { SandboxDoc } from "../sandbox/doc.js";
import { defineExtension, GenerationTask, hook, type Harness, type ConversationId } from "@earendil-works/pi-durable";
import type { SpanAttributes, TelemetryContext } from "@earendil-works/pi-telemetry";
import { recordModelUsage } from "./model.js";

export function scopedTelemetry(telemetry: TelemetryContext, attributes: SpanAttributes): TelemetryContext {
  return {
    metrics: telemetry.metrics,
    propagation: telemetry.propagation === undefined ? undefined : {
      inject: (context) => telemetry.propagation!.inject(context),
      extract: (carrier) => scopedTelemetry(telemetry.propagation!.extract(carrier), attributes),
    },
    startSpan: (options, callback) => telemetry.startSpan({ ...options, attributes: { ...attributes, ...options.attributes } }, callback),
  };
}

export function createHarnessTelemetry(telemetry: TelemetryContext, attributes: SpanAttributes, root: () => ConversationId | undefined) {
  const scope = (id: ConversationId): SpanAttributes => ({
    ...attributes,
    "lulu.conversation.id": String(id),
    "lulu.conversation.kind": root() === undefined || id === root() ? "root" : "delegate",
  });
  return {
    context: scopedTelemetry(telemetry, attributes),
    extension: defineExtension({
      name: "lulu.telemetry",
      hooks: [hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          const binding = await api.snapshot(SandboxDoc, api.conversationId, context);
          const run = binding?.key ? await api.snapshot(RunFamily, binding.key, context) : undefined;
          context.telemetry.setAttributes({ ...scope(api.conversationId), "lulu.delegate.run.id": run?.id, "lulu.delegate.generation": run?.generation });
        },
        afterResponse: async (message, api, context) => {
          if (message.stopReason === "pending" || message.stopReason === "deferred") return;
          await context.telemetry.startSpan({ name: "chat.usage", attributes: { ...scope(api.conversationId), "lulu.task.id": String(api.taskId), "gen_ai.operation.name": "chat" } }, async (span) => {
            recordModelUsage(span, message);
            if (message.stopReason === "error") {
              console.error("Model request failed", { provider: message.provider, model: message.model });
              span.setStatus({ status: "error", error: { name: "ModelError", message: "model request failed" } });
            }
          });
        },
      })],
    }),
  };
}

export function observeDelegateTiming(harness: Harness, telemetry: TelemetryContext): void {
  harness.observeCommits({
    advance: (publication) => {
      for (const change of publication.changes) {
        if (change.type !== "document" || change.kind !== "change" || change.record.kind !== RunFamily.definition.kind) continue;
        const run = change.value as unknown as RunDoc;
        if (run.endedAt === null || run.status === "running") continue;
        void telemetry.startSpan({ name: "delegate.run", attributes: {
          "lulu.delegate.run.id": run.id,
          "lulu.delegate.generation": run.generation,
          "lulu.conversation.id": String(run.conversationId),
          "lulu.conversation.kind": "delegate",
          "lulu.delegate.status": run.status,
          "lulu.delegate.started_at": run.startedAt,
          "lulu.delegate.ended_at": run.endedAt,
          "lulu.delegate.duration_ms": Math.max(0, run.endedAt - run.startedAt),
        } }, async () => undefined).catch(() => undefined);
      }
    },
    end: () => {},
  });
}
