import { defineEntry, type EntryRecord } from "@earendil-works/pi-durable";
import { SCHEDULE_OFFER_KIND, SCHEDULE_ORIGIN_PREFIX } from "../protocol/panel.js";
import { SEND_TOOL, isScheduleOverviewRequest, type ScheduleOverviewRequest, type SendCard, type SendDetails, type SendInput } from "../protocol/send.js";

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

export const sentOf = (entries: readonly { id?: unknown; kind?: unknown; model?: unknown }[], origin: string): SendCall | undefined =>
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
      if (requested?.kind === "schedule_overview" || isScheduleOverviewRequest(requested)) {
        const widget = result.details?.widget;
        if (result.toolName !== SEND_TOOL || widget?.kind !== "panel" || widget.panel.body.kind !== "schedules") return [];
        return [{ ...sent, input: { ...input, widget } }];
      }
      return [{ ...sent, input: { ...input, ...(requested && { widget: requested }) } }];
    });
  });
}
