import type { Message } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineEntry, type Conversation, type ConversationView, type EntryId, type EntryRecord, type Harness, type SubmissionId, type SubmissionRecord } from "@earendil-works/pi-durable";
import type { Episode } from "../memory/doc.js";
import { SCHEDULE_OFFER_KIND, SCHEDULE_ORIGIN_PREFIX } from "../protocol/panel.js";
import { SEND_TOOL, isScheduleOverviewRequest, type ScheduleOverviewRequest, type SendCard, type SendDetails, type SendInput } from "../protocol/send.js";

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

export type SubmissionReader = (id: SubmissionId, context: Context) => Promise<SubmissionRecord | undefined>;

export async function readSubmission(harness: Harness, id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
  const submission = await harness.submission(id, context);
  return submission?.status(context);
}

export type Sent = { id: string; entry: number; input: SendInput };
export const LegacyScheduleOfferEntry = defineEntry<{ widget: Extract<SendCard, { kind: "panel" }>; at: number }>(SCHEDULE_OFFER_KIND);

type RecordedSendInput = Omit<SendInput, "widget"> & { widget?: SendCard | ScheduleOverviewRequest | { kind: "schedule_overview" } };
type SendCall = { id: string; entry: number; input: RecordedSendInput };

type Block = { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };

type Result = { role?: unknown; toolName?: unknown; toolCallId?: unknown; isError?: unknown; details?: SendDetails };

export function refusedIn(entries: readonly { model?: unknown }[]): Set<string> {
  const refused = new Set<string>();
  for (const entry of entries) {
    if (!Array.isArray(entry.model)) continue;
    for (const message of entry.model as Result[]) {
      if (message.role === "toolResult" && message.isError === true && typeof message.toolCallId === "string") refused.add(message.toolCallId);
    }
  }
  return refused;
}

export function sentIn(entries: readonly { id?: unknown; kind?: unknown; model?: unknown }[], refused: ReadonlySet<string> = refusedIn(entries)): SendCall[] {
  const sent: SendCall[] = [];
  for (const entry of entries) {
    if (entry.kind !== "pi.assistant" || !Array.isArray(entry.model)) continue;
    for (const message of entry.model as { content?: unknown }[]) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Block[]) {
        if (block.type !== "toolCall" || block.name !== SEND_TOOL || typeof block.id !== "string" || refused.has(block.id) ||
            !block.arguments || typeof block.arguments !== "object") continue;
        sent.push({ id: block.id, entry: Number(entry.id), input: block.arguments as RecordedSendInput });
      }
    }
  }
  return sent;
}

const sentOf = (entries: readonly { id?: unknown; kind?: unknown; model?: unknown }[], origin: string): SendCall | undefined =>
  sentIn(entries).find((sent) => sent.id === origin);

const quoted = (input: Pick<SendInput, "content" | "body">): string | undefined => [input.content?.trim(), input.body?.trim()].filter((part) => part).join("\n\n") || undefined;

export function assistantText(entries: readonly { id?: unknown; kind?: unknown; model?: unknown }[], origin: string): string | undefined {
  const sent = sentOf(entries, origin);
  if (sent !== undefined) return sent.input.type === "text" && typeof sent.input.content === "string" ? quoted(sent.input) : undefined;
  const entry = entries.find((item) => item.kind === "pi.assistant" && String(item.id) === origin && Array.isArray(item.model));
  if (entry === undefined) return undefined;
  const text = (entry.model as { content?: unknown }[])
    .flatMap((message) => (Array.isArray(message.content) ? (message.content as Block[]) : []))
    .flatMap((block) => (block.type === "text" && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text.trim()] : []))
    .filter((part) => part !== "")
    .join("\n\n");
  return text === "" ? undefined : text;
}

export function spokenText(sent: readonly SendCall[]): string {
  return sent
    .flatMap((item) => (item.input.type === "text" && typeof item.input.content === "string" ? [item.input.content.trim()] : []))
    .filter((text) => text !== "")
    .join("\n\n");
}

// An unfinished or failed send is not an actionable offer.
export function deliveredSentIn(entries: readonly EntryRecord[]): Sent[] {
  const delivered = new Map<string, Result>();
  for (const entry of entries) {
    if (entry.kind !== "pi.tool-result" || !Array.isArray(entry.model)) continue;
    for (const message of entry.model as Result[]) {
      if (message.role === "toolResult" && message.isError !== true && typeof message.toolCallId === "string") delivered.set(message.toolCallId, message);
    }
  }
  const refused = refusedIn(entries);
  return entries.flatMap((entry): Sent[] => {
    if (LegacyScheduleOfferEntry.is(entry) && entry.data?.widget !== undefined) {
      return [{ id: SCHEDULE_ORIGIN_PREFIX + entry.id, entry: Number(entry.id), input: { type: "widget", widget: entry.data.widget } }];
    }
    return sentIn([entry], refused).flatMap(({ input: call, ...sent }): Sent[] => {
      const result = delivered.get(sent.id);
      if (result === undefined) return [];
      const { widget: requested, ...input } = call;
      const prepared = input.type === "widget" && result.toolName === SEND_TOOL ? result.details?.widget : undefined;
      if (requested?.kind === "schedule_overview" || isScheduleOverviewRequest(requested)) {
        if (prepared?.kind !== "panel" || prepared.panel.body.kind !== "schedules") return [];
        return [{ ...sent, input: { ...input, widget: prepared } }];
      }
      const widget = prepared ?? requested;
      return [{ ...sent, input: { ...input, ...(widget && { widget }) } }];
    });
  });
}

const EPISODE_CHARACTERS = 2000;

const textOf = (message: Message | undefined): string => {
  if (message === undefined) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
};

const episodeOf = (entry: EntryRecord, refused: ReadonlySet<string>): Episode | undefined => {
  const role = entry.kind === "pi.user" ? "user" : entry.kind === "pi.assistant" ? "assistant" : undefined;
  if (role === undefined) return undefined;
  const text = (role === "assistant" ? spokenText(sentIn([entry], refused)) : textOf(entry.model?.[0]).trim()).slice(0, EPISODE_CHARACTERS);
  return text === "" ? undefined : { id: Number(entry.id), role, text };
};

export function episodesOf(entries: readonly EntryRecord[]): Episode[] {
  const refused = refusedIn(entries);
  return entries.flatMap((entry) => {
    const episode = episodeOf(entry, refused);
    return episode === undefined ? [] : [episode];
  });
}
