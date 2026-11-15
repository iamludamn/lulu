import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionEntry, defineDoc, defineTask, type Conversation, type EntryId, type Harness } from "@earendil-works/pi-durable";
import type { DurableHost } from "../host/types.js";
import { memoryRemember } from "./client.js";

export const MEMORY_UPDATE = "pistack.memory.update";
const RETRY_MS = 60 * 60 * 1000;

const MemoryTriggerDoc = defineDoc<{ scanned: number }>({
  kind: "lulu.memory.trigger",
  version: 1,
  scope: "conversation",
  checkpointWhen: () => false,
  history: "latest",
  fork: "initial",
  initial: () => ({ scanned: 0 }),
});

export function createMemoryUpdate(host: DurableHost) {
  return defineTask<{ through: number }, { phase: "send" } | { phase: "wait"; until: number }, { processed: true }>({
    name: MEMORY_UPDATE,
    version: 1,
    initial: () => ({ phase: "send" }),
    phases: {
      send: async (task, runtime, context) => {
        try {
          await memoryRemember(host, host.name, `compaction:${runtime.conversationId}:${task.input.through}`, String(runtime.conversationId), task.input.through);
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait", until: runtime.now() + RETRY_MS } }), context);
          return;
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { processed: true } } }), context);
      },
      wait: async (task, runtime, context) => {
        await runtime.sleepUntil(task.state.checkpoint.until, { phase: "send" }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "memory update stopped" } }), context);
    },
  });
}

export async function recoverMemoryUpdates(harness: Harness, root: Conversation, update: ReturnType<typeof createMemoryUpdate>): Promise<void> {
  const scanned = (await harness.snapshot(MemoryTriggerDoc, root.id, BACKGROUND_CONTEXT))?.scanned ?? 0;
  const compactions: number[] = [];
  let through = scanned;
  for (;;) {
    const page = await root.entries({ minEntryId: (through + 1) as EntryId, order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
    for (const entry of page.items) if (CompactionEntry.is(entry)) compactions.push(Number(entry.id));
    through = Number(page.items.at(-1)?.id ?? through);
    if (page.items.length < 200) break;
  }
  if (through === scanned) return;
  await harness.commit(async (tx) => {
    const trigger = await tx.doc(MemoryTriggerDoc, root.id);
    for (const id of compactions) {
      if (id <= trigger.scanned) continue;
      await tx.createTask(update, { through: id }, { ownership: { kind: "conversation" }, conversationId: root.id, background: true });
    }
    trigger.scanned = Math.max(trigger.scanned, through);
  }, BACKGROUND_CONTEXT);
}
