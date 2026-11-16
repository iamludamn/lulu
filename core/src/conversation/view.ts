import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, EntryId, EntryRecord, Harness } from "@earendil-works/pi-durable";

export const HISTORY_PAGE_SIZE = 200;

export async function observeView(harness: Harness, conversation: Conversation, changed: () => void): Promise<{ readonly value: ConversationView }> {
  let value: ConversationView;
  const observation = await harness.observeConversation(conversation.id, {
    advance: (call) => {
      if (call.kind !== "value") return;
      value = call.value;
      changed();
    },
    end: () => {},
  }, BACKGROUND_CONTEXT, { min: HISTORY_PAGE_SIZE, max: HISTORY_PAGE_SIZE * 2 });
  value = observation.value;
  return { get value() { return value; } };
}

export async function entryRange(conversation: Conversation, after: number, through: number | undefined, context: Context): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor;
  do {
    const page = await conversation.entries({ minEntryId: (after + 1) as EntryId, ...(through === undefined ? {} : { maxEntryId: through as EntryId }), order: "ascending" }, HISTORY_PAGE_SIZE, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
}
