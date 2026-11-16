import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineTask, type Harness, type ModelRef } from "@earendil-works/pi-durable";
import type { DurableHost } from "../host/types.js";
import type { MemorySource } from "./doc.js";
import { collectMemorySources, sourceVersion } from "./sources.js";

export const DREAMING_TASK = "lulu.memory.dreaming";
const RETRY_MS = 60 * 60_000;
export const DreamingTriggerDoc = defineDoc<{ revision: string; sequence: number; retryAt: number | null }>({
  kind: "lulu.memory.dreaming.trigger", version: 1, scope: "session", checkpointWhen: () => false,
  initial: () => ({ revision: "", sequence: 0, retryAt: null }),
});

export const createDreamingTask = (host: DurableHost) => defineTask<{ sources: MemorySource[]; revision: string; sequence: number; model: ModelRef }, { phase: "send" } | { phase: "wait"; until: number }, { processed: true }>({
  name: DREAMING_TASK, version: 1, initial: () => ({ phase: "send" }),
  phases: {
    send: async (task, runtime, context) => {
      try {
        const response = await host.objects.MEMORY.getByName(host.name).fetch("https://memory/dream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(task.input) });
        if (!response.ok) throw new Error("Source dreaming failed");
      } catch (error) {
        if (context.abortSignal?.aborted) throw error;
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait", until: runtime.now() + RETRY_MS } }), context);
        return;
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { processed: true } } }), context);
    },
    wait: (task, runtime, context) => runtime.sleepUntil(task.state.checkpoint.until, { phase: "send" }, context),
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "Source dreaming stopped" } }), context);
  },
});

export async function reconcileDreaming(harness: Harness, host: DurableHost, model: ModelRef): Promise<void> {
  let sources: MemorySource[];
  try { sources = await collectMemorySources(harness, host); }
  catch (error) {
    await harness.commit(async (tx) => { (await tx.doc(DreamingTriggerDoc)).retryAt = Date.now() + 60_000; }, BACKGROUND_CONTEXT);
    throw error;
  }
  const root = await harness.root(BACKGROUND_CONTEXT);
  const revision = await sourceVersion(sources);
  const task = createDreamingTask(host);
  await harness.commit(async (tx) => {
    const trigger = await tx.doc(DreamingTriggerDoc);
    trigger.retryAt = null;
    if (trigger.revision === revision) return;
    const initialEmpty = trigger.revision === "" && sources.length === 0;
    trigger.revision = revision;
    trigger.sequence++;
    if (!initialEmpty) await tx.createTask(task, { sources, revision, sequence: trigger.sequence, model }, { ownership: { kind: "conversation" }, conversationId: root.id, background: true });
  }, BACKGROUND_CONTEXT);
}
