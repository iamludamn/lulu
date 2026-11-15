import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, EntryId, Harness } from "@earendil-works/pi-durable";

export async function observeView(harness: Harness, conversation: Conversation, changed: () => void): Promise<{ readonly value: ConversationView }> {
  const entries = new Map<EntryId, ConversationView["entries"][number]>();
  let value: ConversationView;
  let ready = false;
  const merge = (view: ConversationView): void => {
    for (const entry of view.entries) entries.set(entry.id, entry);
    value = { ...view, entries: [...entries.values()].sort((a, b) => Number(a.id) - Number(b.id)) };
  };
  const observation = await harness.observeConversation(conversation.id, {
    advance: (call) => {
      if (call.kind !== "value") return;
      merge(call.value);
      if (ready) changed();
    },
    end: () => {},
  }, BACKGROUND_CONTEXT);
  merge(observation.value);
  try {
    let after = 0;
    for (;;) {
      const page = await conversation.entries({ minEntryId: (after + 1) as EntryId, order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
      for (const entry of page.items) if (!entries.has(entry.id)) entries.set(entry.id, entry);
      if (page.items.length < 200) break;
      after = Number(page.items.at(-1)!.id);
    }
    merge(observation.value);
    ready = true;
    return { get value() { return value; } };
  } catch (error) {
    observation.detach();
    throw error;
  }
}
