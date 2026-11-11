import { SEND_TOOL, type SendInput } from "../protocol/send.js";

export type Sent = { id: string; entry: number; input: SendInput };

type Block = { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };

type Result = { role?: unknown; toolCallId?: unknown; isError?: unknown };

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

export function sentIn(entries: readonly { id?: unknown; kind?: unknown; model?: unknown }[], refused: ReadonlySet<string> = refusedIn(entries)): Sent[] {
  const sent: Sent[] = [];
  for (const entry of entries) {
    if (entry.kind !== "pi.assistant" || !Array.isArray(entry.model)) continue;
    for (const message of entry.model as { content?: unknown }[]) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Block[]) {
        if (block.type !== "toolCall" || block.name !== SEND_TOOL || typeof block.id !== "string" || refused.has(block.id)) continue;
        sent.push({ id: block.id, entry: Number(entry.id), input: block.arguments as SendInput });
      }
    }
  }
  return sent;
}

export const sentOf = (entries: readonly { id?: unknown; kind?: unknown; model?: unknown }[], origin: string): Sent | undefined =>
  sentIn(entries).find((sent) => sent.id === origin);

const quoted = (input: SendInput): string | undefined => [input.content?.trim(), input.body?.trim()].filter((part) => part).join("\n\n") || undefined;

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

export function spokenText(sent: readonly Sent[]): string {
  return sent
    .flatMap((item) => (item.input.type === "text" && typeof item.input.content === "string" ? [item.input.content.trim()] : []))
    .filter((text) => text !== "")
    .join("\n\n");
}
