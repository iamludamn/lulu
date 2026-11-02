import { LIVE_DOC, SEND_TOOL, type ConversationView, type LiveState, type MessageProgress, type SendInput, type SessionProgress, type SubtaskProgress, type ToolSlot } from "../protocol";

export interface ChatEntry {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface Live {
  readonly busy: boolean;
  readonly tools: readonly string[];
}

function messageText(model: readonly unknown[] | undefined): string {
  if (model === undefined) return "";
  const parts: string[] = [];
  for (const message of model) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        const part = block as { type?: string; text?: unknown };
        if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
      }
    }
  }
  return parts.join("").trim();
}

function sentText(model: readonly unknown[] | undefined): string {
  const parts: string[] = [];
  for (const message of model ?? []) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const call = block as { type?: string; name?: string; arguments?: SendInput };
      if (call.type !== "toolCall" || call.name !== SEND_TOOL || call.arguments === undefined) continue;
      const input = call.arguments;
      if (input.type === "text" && input.content !== undefined) parts.push(input.content);
      else if (input.widget?.kind === "panel") parts.push(`〔组件〕${input.widget.panel.title}`);
      else if (input.widget?.kind === "asset") parts.push(`〔资产〕${input.widget.title}`);
    }
  }
  return parts.join("\n\n").trim();
}

const ATTRIBUTION = /^\[([^\]\n]*)\]\n/;

export function splitAttribution(text: string): { readonly author?: string; readonly body: string } {
  const match = ATTRIBUTION.exec(text);
  return match === null ? { body: text } : { author: match[1], body: text.slice(match[0].length) };
}

export function chatEntries(view: ConversationView | undefined, hidden: readonly string[]): ChatEntry[] {
  const entries: ChatEntry[] = [];
  const skipped = new Set(hidden);
  let turn: { id: string; model: readonly unknown[] | undefined }[] = [];
  const close = (settled: boolean) => {
    const sent = turn.flatMap((item) => {
      const text = sentText(item.model);
      return text === "" ? [] : [{ id: item.id, role: "assistant" as const, text }];
    });
    const last = turn.findLast((item) => messageText(item.model) !== "");
    if (sent.length > 0) entries.push(...sent);
    else if (settled && last !== undefined) entries.push({ id: last.id, role: "assistant", text: messageText(last.model) });
    turn = [];
  };
  for (const entry of view?.entries ?? []) {
    const id = String(entry.id);
    if (skipped.has(id)) continue;
    if (entry.kind === "pi.assistant") {
      turn.push({ id, model: entry.model });
    } else if (entry.kind === "pi.user") {
      close(true);
      const text = messageText(entry.model);
      if (text !== "") entries.push({ id, role: "user", text });
    }
  }
  close(!liveOf(view).busy);
  return entries;
}

export type TimelineItem =
  | { readonly kind: "entry"; readonly entry: ChatEntry }
  | { readonly kind: "prompt"; readonly message: MessageProgress };

export function timeline(entries: readonly ChatEntry[], messages: readonly MessageProgress[]): TimelineItem[] {
  const placed = new Set(messages.flatMap((message) => (message.entry === null ? [] : [message.entry])));
  const items: TimelineItem[] = [];
  let next = 0;
  const promptsBefore = (limit: number) => {
    while (next < messages.length && (messages[next]!.after ?? -Infinity) < limit) {
      items.push({ kind: "prompt", message: messages[next]! });
      next += 1;
    }
  };
  for (const entry of entries) {
    if (entry.role === "user" && placed.has(entry.id)) continue;
    promptsBefore(Number(entry.id));
    items.push({ kind: "entry", entry });
  }
  promptsBefore(Infinity);
  return items;
}

export function subtasksOf(progress: SessionProgress | undefined): SubtaskProgress[] {
  const unique = new Map<string, SubtaskProgress>();
  for (const message of progress?.messages ?? []) {
    for (const subtask of message.subtasks) unique.set(subtask.id, subtask);
  }
  return [...unique.values()];
}

export function liveOf(view: ConversationView | undefined): Live {
  const live = view?.docs[LIVE_DOC] as LiveState | undefined;
  const tools = (live?.tools ?? []).filter((slot: ToolSlot) => slot.status !== "done" && slot.name !== SEND_TOOL).map((slot) => slot.name);
  return { busy: live?.run !== undefined, tools };
}
