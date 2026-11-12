import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";
import { memorySpan } from "./telemetry.js";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { defineExtension, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { contextCoverage } from "./context.js";
import { RecallDoc } from "./doc.js";
import type { ReadableFiles } from "./files.js";
import { createReadTools } from "./tools.js";
import type { createMemoryUpdate } from "./schedule.js";

export function createMemoryExtension(context: () => Promise<string>, files: ReadableFiles, telemetry: TelemetryContext = NOOP_TELEMETRY_CONTEXT, update?: ReturnType<typeof createMemoryUpdate>) {
  return defineExtension({
    name: "pistack.memory",
    tools: createReadTools(files, telemetry),
    tasks: update === undefined ? [] : [update],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api) => {
          const text = getCurrentSystemMessage(messages)?.sections?.memory ?? undefined;
          await memorySpan(telemetry, "memory.request", {
            "lulu.conversation.id": String(api.conversationId),
            "lulu.task.id": String(api.taskId),
            "lulu.memory.coverage": contextCoverage(text),
            "lulu.memory.characters": text?.length ?? 0,
          }, async () => undefined);
        },
      }),
    ],
    sections: [
      section(
        "memory",
        async (input, scope) => {
          return memorySpan(telemetry, "memory.context.delivery", {}, async (span) => {
            const shown = input.shown.memory;
            const recall = await input.read.snapshot(RecallDoc, scope);
            span.setAttributes({ "lulu.memory.request_id": recall?.requestId, "lulu.recall.inject": recall?.inject ?? false });
            let value = shown;
            let outcome = shown ? "reused" : "empty";
            if (recall?.inject === true) {
              try {
                const refreshed = await context();
                value = refreshed || shown;
                outcome = refreshed ? "refreshed" : shown ? "reused" : "empty";
              } catch {
                outcome = "failed";
                span.setStatus({ status: "error", error: { name: "MemoryError", message: "memory context refresh failed" } });
              }
            }
            const coverage = contextCoverage(value);
            span.setAttributes({ "lulu.memory.outcome": outcome, "lulu.memory.coverage": coverage, "lulu.memory.available": coverage === "content" || coverage === "catalog", "lulu.memory.characters": value?.length ?? 0 });
            return value;
          });
        },
        { tag: false },
      ),
    ],
  });
}
