import type { DurableHost } from "../host/types.js";
import { contextCoverage } from "./context.js";
import { injectionContext } from "./injection.js";
import { createDreamingTask } from "./dreaming.js";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { defineExtension, GenerationTask, hook, LiveDoc, section } from "@earendil-works/pi-durable";
import { memorySpan, memoryTelemetry } from "./telemetry.js";
import { InjectionBindings, InjectionFamily, injectionRequest } from "./doc.js";
import { SandboxDoc } from "../sandbox/doc.js";
import { RunFamily } from "../delegate/runs.js";
import { createMemoryUpdate } from "./schedule.js";
import { RENAMED_TASKS, STORED_EXTENSION_NAMES, withPreviousTaskName } from "../durable-names.js";

export type MemoryExtensionOptions = {
  telemetry?: TelemetryContext;
  update?: ReturnType<typeof createMemoryUpdate>;
  dreaming?: ReturnType<typeof createDreamingTask>;
};

export function createMemoryExtension({ telemetry = NOOP_TELEMETRY_CONTEXT, update, dreaming }: MemoryExtensionOptions) {
  return defineExtension({
    name: STORED_EXTENSION_NAMES.memory,
    tasks: [
      ...(update === undefined ? [] : withPreviousTaskName(update, RENAMED_TASKS.memoryUpdate.previous)),
      ...(dreaming === undefined ? [] : [dreaming]),
    ],
    hooks: [hook(GenerationTask, {
      beforeRequest: async ({ messages }, api) => {
        const text = getCurrentSystemMessage(messages)?.sections?.memory;
        await memorySpan(telemetry, "memory.request", { "lulu.conversation.id": String(api.conversationId), "lulu.task.id": String(api.taskId), "lulu.memory.characters": text?.length ?? 0, "lulu.memory.coverage": contextCoverage(text ?? undefined) }, async () => undefined);
      },
    })],
    sections: [section("memory", async (input, context) => memorySpan(telemetry, "memory.context.delivery", { "lulu.memory.available": false, "lulu.memory.coverage": "none" }, async (span) => {
      try {
        const binding = await input.read.snapshot(SandboxDoc, input.conversationId, context);
        const child = binding?.key ? await input.read.snapshot(RunFamily, binding.key, context) : undefined;
        const inputs = child?.conversationId === input.conversationId ? child.origin : (await input.read.snapshot(LiveDoc, input.conversationId, context))?.run?.inputs ?? [];
        const bindings = await input.read.snapshot(InjectionBindings, context);
        const requestId = injectionRequest(bindings?.requests, inputs);
        const injection = requestId === undefined ? undefined : await input.read.snapshot(InjectionFamily, requestId, context);
        span.setAttributes({ "lulu.memory.request_id": requestId, "lulu.memory.outcome": injection?.outcome ?? "empty", "lulu.memory.selected": injection?.selected.length ?? 0 });
        const text = injection === undefined ? undefined : injectionContext(injection);
        const coverage = contextCoverage(text);
        span.setAttributes({ "lulu.memory.available": coverage === "content" || coverage === "catalog", "lulu.memory.coverage": coverage, "lulu.memory.characters": text?.length ?? 0, "lulu.memory.missing": injection?.selected.filter((item) => item.text === null).length ?? 0 });
        return text;
      } catch {
        span.setAttributes({ "lulu.memory.outcome": "failed" });
        span.setStatus({ status: "error", error: { name: "MemoryError", message: "Request memory selection unavailable" } });
        return undefined;
      }
    }), { tag: false })],
  });
}

export function memoryExtensionFor(host: DurableHost) {
  return createMemoryExtension({
    telemetry: memoryTelemetry(host.telemetry, host.name),
    update: createMemoryUpdate(host),
    dreaming: createDreamingTask(host),
  });
}
