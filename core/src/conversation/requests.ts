import { BACKGROUND_CONTEXT, withTelemetry, type Context } from "@earendil-works/chord/context";
import {
  defineDoc, LiveDoc, ToolResultEntry,
  type Conversation, type ConversationId, type ConversationView, type DocumentReader, type EntryId, type EntryRecord,
  type Harness, type InputSubmissionDraft, type SubmissionId, type SubmissionRecord, type Tx,
} from "@earendil-works/pi-durable";
import type { TelemetryCarrier, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { STORED_DOC_KINDS } from "../durable-names.js";
import { bindInjection, inheritInjection, type MemoryInjection } from "../memory/doc.js";
import { bindNote, inheritNote } from "../notes/context.js";
import type { BusyMode } from "../protocol/contract.js";
import { SEND_TOOL } from "../protocol/send.js";
import type { ClientMessage, ReceiptSource } from "../protocol/wire.js";
import { entryRange, readSubmission, sentIn, type SubmissionReader } from "./transcript.js";

export const REQUEST_TIMEOUT_MS = 15 * 60_000;
const CHAT_DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ScheduleMessageSource = { kind: "schedule_message"; scheduleId: string; scheduledFor: number };

type RunInput = { requestId: string; content: string } & (
  | { kind: "user_message"; whenBusy: BusyMode }
  | ScheduleMessageSource
  | { kind: "space-monitor"; spaceId: string; eventId: string }
  | { kind: "delegate_result"; runId: string }
  | { kind: "internal"; action: "delivery_retry"; messageId: number }
  | { kind: "internal"; action: "widget_request"; origin: string }
);

export function inputSubmission({ requestId, content, ...source }: RunInput): InputSubmissionDraft {
  const draft = { type: "input", requestId, content } as const;
  if (source.kind === "user_message") return { ...draft, whenBusy: source.whenBusy };
  const kind = source.kind === "space-monitor" ? "lulu.space-monitor" : "lulu.input";
  return { ...draft, whenBusy: "followUp", entry: { kind, data: source } };
}

type ChatMessage = { requestId: string; id: number | null; text: string; after: number | null; at?: number; deadline?: number; error?: string };

const ChatDoc = defineDoc<{ messages: ChatMessage[] }>({
  kind: STORED_DOC_KINDS.chatMessages,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ messages: [] }),
});

const RequestDeadlinesDoc = defineDoc<{ pending: { id: number; until: number }[] }>({
  kind: "lulu.requests.deadlines",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ pending: [] }),
});

type ChatDelivery = {
  requestId: string;
  submissions: number[];
  release: string;
  trace?: TelemetryCarrier;
  acceptedAt: number;
  deadline: number;
  firstAt?: number;
  final?: { callId: string; at: number };
  receipt?: { at: number; source: ReceiptSource };
  cancelRequested?: boolean;
  terminal?: "cancelled" | "failed";
  deadlineReported?: boolean;
};

const ChatDeliveryDoc = defineDoc<{ through: number; requests: ChatDelivery[] }>({
  kind: "lulu.chat.delivery",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ through: 0, requests: [] }),
});

type Nudge = { message: number; requestId: string; id: number | null };

const DeliveryRetriesDoc = defineDoc<{ since: number | null; nudges: Nudge[] }>({
  kind: STORED_DOC_KINDS.delivery,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ since: null, nudges: [] }),
});

export const CHAT_ALARM_DOCUMENT_KINDS = [ChatDeliveryDoc.definition.kind, RequestDeadlinesDoc.definition.kind] as const;
export const CHAT_PROGRESS_DOCUMENT_KINDS: ReadonlySet<string> = new Set([
  ChatDoc.definition.kind, RequestDeadlinesDoc.definition.kind, DeliveryRetriesDoc.definition.kind,
]);

type ObservedRequest = Pick<ChatDelivery, "requestId" | "acceptedAt" | "trace" | "release" | "receipt">;

export async function admitPrompt(
  harness: Harness,
  root: Conversation,
  view: Pick<ConversationView, "entries">,
  command: Extract<ClientMessage, { type: "prompt.submit" }>,
  injection: MemoryInjection,
  delivery?: { release: string; span: TelemetrySpan },
): Promise<{ firstBinding: boolean; request?: ObservedRequest }> {
  if (injection.requestId !== command.requestId) throw new Error("Memory delivery request mismatch");
  const accepted = await harness.commit(async (tx) => {
    const chat = await tx.doc(ChatDoc);
    let message = chat.messages.find((item) => item.requestId === command.requestId);
    const ledger = !message && delivery ? await tx.doc(ChatDeliveryDoc) : undefined;
    if (ledger?.requests.length === 0) ledger.through = Number(await tx.latestEntryId(root.id) ?? 0);
    const id = await root.submit(tx, inputSubmission({
      kind: "user_message",
      content: command.content,
      requestId: command.requestId,
      whenBusy: command.whenBusy,
    }));
    const firstBinding = await bindInjection(tx, id, injection);
    if (!message) {
      if (command.noteRef) await bindNote(tx, id, command.noteRef);
      const now = Date.now();
      message = { requestId: command.requestId, id: Number(id), text: command.content, after: Number(view.entries.at(-1)?.id ?? 0), at: now, deadline: now + REQUEST_TIMEOUT_MS };
      chat.messages.push(message);
    } else message.id = Number(id);
    const deadlines = await tx.doc(RequestDeadlinesDoc);
    if (message.deadline !== undefined && !deadlines.pending.some((item) => item.id === Number(id))) deadlines.pending.push({ id: Number(id), until: message.deadline });
    if (!delivery || !ledger) return { firstBinding };
    const trace = delivery.span.propagation?.inject(delivery.span);
    const request = {
      requestId: command.requestId, submissions: [Number(id)], release: delivery.release,
      ...(trace === undefined ? {} : { trace }), acceptedAt: message.at!, deadline: message.deadline!,
    };
    ledger.requests.push(request);
    return { firstBinding, request };
  }, delivery ? withTelemetry(delivery.span, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT);
  harness.resume();
  return accepted;
}

export async function chatMessages(read: Pick<DocumentReader, "snapshot">, context: Context): Promise<readonly Readonly<ChatMessage>[]> {
  return (await read.snapshot(ChatDoc, context))?.messages ?? [];
}

export async function deadlineForDelegate(tx: Tx, origins: readonly SubmissionId[]): Promise<number> {
  const deadlines = (await tx.doc(ChatDoc)).messages
    .filter((message) => message.id !== null && origins.includes(message.id as SubmissionId))
    .flatMap((message) => message.deadline === undefined ? [] : [message.deadline]);
  return Math.min(Date.now() + REQUEST_TIMEOUT_MS, ...deadlines);
}

export async function requestDeadlineAt(harness: Harness): Promise<number | undefined> {
  const pending = (await harness.snapshot(RequestDeadlinesDoc, BACKGROUND_CONTEXT))?.pending ?? [];
  const finished: number[] = [];
  const deadlines: number[] = [];
  for (const item of pending) {
    const record = await readSubmission(harness, item.id as SubmissionId, BACKGROUND_CONTEXT);
    if (record?.status === "queued" || record?.status === "placed") deadlines.push(item.until);
    else finished.push(item.id);
  }
  if (finished.length > 0) await harness.commit(async (tx) => {
    const doc = await tx.doc(RequestDeadlinesDoc);
    doc.pending = doc.pending.filter((item) => !finished.includes(item.id));
  }, BACKGROUND_CONTEXT);
  return deadlines.length === 0 ? undefined : Math.min(...deadlines);
}

export async function expireRequests(harness: Harness, root: Conversation, now: number): Promise<void> {
  const messages = await chatMessages(harness, BACKGROUND_CONTEXT);
  const due = new Set(((await harness.snapshot(RequestDeadlinesDoc, BACKGROUND_CONTEXT))?.pending ?? []).filter((item) => item.until <= now).map((item) => item.id));
  for (const message of messages) {
    if (message.id === null || !due.has(message.id) || message.deadline === undefined || message.deadline > now) continue;
    const submission = await harness.submission(message.id as SubmissionId, BACKGROUND_CONTEXT);
    const record = await submission?.status(BACKGROUND_CONTEXT);
    if (!record || (record.status !== "queued" && record.status !== "placed")) continue;
    if (!message.error) await harness.commit(async (tx) => {
      const current = (await tx.doc(ChatDoc)).messages.find((item) => item.requestId === message.requestId);
      if (current) current.error = "Request exceeded its 15 minute deadline";
    }, BACKGROUND_CONTEXT);
    const result = await submission!.abort(BACKGROUND_CONTEXT);
    if (result === "already_placed") {
      const live = await harness.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT);
      if (live?.run?.inputs.includes(message.id as SubmissionId)) await harness.abortTask(live.run.taskId, BACKGROUND_CONTEXT);
    }
  }
}

export async function linkFollowup(tx: Tx, origins: readonly number[], submission: SubmissionId): Promise<void> {
  const delivery = await tx.doc(ChatDeliveryDoc);
  for (const request of delivery.requests) {
    if (request.submissions.some((id) => origins.includes(id)) && !request.submissions.includes(submission)) {
      request.submissions.push(submission);
    }
  }
  await inheritInjection(tx, origins, submission);
}

export async function requestIdsForReply(read: Pick<DocumentReader, "snapshot">, conversationId: ConversationId, context: Context): Promise<string[]> {
  const inputs = (await read.snapshot(LiveDoc, conversationId, context))?.run?.inputs ?? [];
  if (inputs.length === 0) return [];
  const delivery = await read.snapshot(ChatDeliveryDoc, context);
  return delivery?.requests
    .filter((request) => !request.final && inputs.some((id) => request.submissions.includes(id)))
    .map((request) => request.requestId) ?? [];
}

const MAX_NUDGES = 2;

const NUDGE_PROMPT =
  "[System reminder] Your previous turn ended without a send_to_user call, so the user received nothing and is still waiting. " +
  "Do not assume an earlier acknowledgement delivered the result. Deliver it now by actually calling send_to_user with end_turn true. " +
  "If you cannot tell what they last asked, say you may have missed it and ask them to resend; never claim work you cannot see.";

type Entries = readonly { id?: unknown; kind?: unknown; model?: unknown }[];

type PendingDelivery = { messageId: number; retryRequestId: string | null };

async function completedWithoutReply(harness: Harness, record: SubmissionRecord | undefined, entries: Entries, context: Context): Promise<boolean> {
  if (record?.status !== "done") return false;
  const from = Number(record.entry);
  const to = Number(record.answer);
  if (entries.length === 0 || Number(entries[0].id) > from) entries = await entryRange(await harness.root(context), from, to, context);
  return sentIn(entries.filter((entry) => Number(entry.id) > from && Number(entry.id) <= to)).length === 0;
}

async function pendingDelivery(
  harness: Harness,
  entries: Entries,
  context: Context,
  read: SubmissionReader = (id, ctx) => readSubmission(harness, id, ctx),
): Promise<PendingDelivery | undefined> {
  const chat = await harness.snapshot(ChatDoc, context);
  const delivery = await harness.snapshot(DeliveryRetriesDoc, context);
  const since = delivery?.since ?? Number.POSITIVE_INFINITY;
  const message = chat?.messages.filter((item) => item.id !== null).at(-1);
  if (message?.id == null || message.error || message.id <= since) return;
  const chain = (delivery?.nudges ?? []).filter((nudge) => nudge.message === message.id);
  const last = chain.at(-1);
  if (last !== undefined && last.id === null) return { messageId: message.id, retryRequestId: last.requestId };
  const record = await read((last?.id ?? message.id) as SubmissionId, context);
  if (last !== undefined && (record?.status === "queued" || record?.status === "placed")) return { messageId: message.id, retryRequestId: null };
  if (chain.length >= MAX_NUDGES || !(await completedWithoutReply(harness, record, entries, context))) return;
  return { messageId: message.id, retryRequestId: `nudge:${message.id}#${chain.length}` };
}

export async function chaseDeliveries(harness: Harness, root: Conversation, entries: Entries, run: (work: () => Promise<void>) => Promise<void>): Promise<void> {
  const pending = await pendingDelivery(harness, entries, BACKGROUND_CONTEXT);
  if (pending === undefined || pending.retryRequestId === null) return;
  const { messageId, retryRequestId: requestId } = pending;
  await run(async () => {
    await harness.commit(async (tx) => {
      const delivery = await tx.doc(DeliveryRetriesDoc);
      if (!delivery.nudges.some((nudge) => nudge.requestId === requestId)) delivery.nudges.push({ message: messageId, requestId, id: null });
    }, BACKGROUND_CONTEXT);
    await harness.commit(async (tx) => {
      const id = await root.submit(tx, inputSubmission({ kind: "internal", action: "delivery_retry", messageId, content: NUDGE_PROMPT, requestId }));
      await linkFollowup(tx, [messageId], id);
      await inheritNote(tx, messageId, id);
      const nudge = (await tx.doc(DeliveryRetriesDoc)).nudges.find((item) => item.requestId === requestId);
      if (nudge !== undefined) nudge.id = Number(id);
    }, BACKGROUND_CONTEXT);
    harness.resume();
  });
}

export async function initializeDeliveryRetries(harness: Harness): Promise<void> {
  await harness.commit(async (tx) => {
    const delivery = await tx.doc(DeliveryRetriesDoc);
    if (delivery.since !== null) return;
    delivery.since = Math.max(0, ...(await tx.doc(ChatDoc)).messages.map((message) => message.id ?? 0));
  }, BACKGROUND_CONTEXT);
}

export async function chatRequestProgress(harness: Harness, entries: Entries, context: Context, read: SubmissionReader) {
  const messages = await chatMessages(harness, context);
  const pendingDeliveryId = (await pendingDelivery(harness, entries, context, read))?.messageId;
  const pendingDeadlines = new Set(((await harness.snapshot(RequestDeadlinesDoc, context))?.pending ?? []).map((item) => item.id));
  return { messages, pendingDeliveryId, pendingDeadlines };
}

export async function deliveryRetryIds(read: Pick<DocumentReader, "snapshot">, context: Context): Promise<SubmissionId[]> {
  const delivery = await read.snapshot(DeliveryRetriesDoc, context);
  return (delivery?.nudges ?? []).flatMap(({ id }) => id === null ? [] : [id as SubmissionId]);
}

type Receipt = Extract<ClientMessage, { type: "prompt.receipts" }>;
type Stage = "accepted" | "first_reply" | "final_committed" | "delivered" | "cancelled" | "failed" | "missing_receipt" | "no_result";
type Observation = { request: ObservedRequest; stage: Stage; at: number };

function committedSend(entry: EntryRecord) {
  const message = entry.model?.[0];
  if (!ToolResultEntry.is(entry) || message?.role !== "toolResult" || message.toolName !== SEND_TOOL || message.isError) return;
  const details = message.details as { end?: boolean; requestIds?: string[] } | undefined;
  if (!details?.requestIds?.length) return;
  return { requestIds: details.requestIds, end: details.end === true, callId: message.toolCallId, at: message.timestamp };
}

export function observeDelivery(telemetry: TelemetryContext, bot: string, { request, stage, at }: Observation): void {
  const parent = telemetry.propagation?.extract(request.trace) ?? telemetry;
  void parent.startSpan({
    name: "chat.delivery." + stage,
    attributes: {
      "lulu.bot.id": bot,
      "lulu.request.id": request.requestId,
      "lulu.release": request.release,
      "lulu.delivery.outcome": stage,
      "lulu.delivery.elapsed_ms": Math.max(0, at - request.acceptedAt),
      "lulu.delivery.receipt_source": stage === "delivered" ? request.receipt?.source : undefined,
    },
  }, async () => undefined).catch(() => undefined);
}

export function reconcileDelivery(harness: Harness, root: Conversation, now: number, receipt?: Receipt): Promise<Observation[]> {
  return harness.commit(async (tx) => {
    const doc = await tx.doc(ChatDeliveryDoc);
    if (doc.requests.length === 0) return [];
    const cutoff = now - CHAT_DELIVERY_WINDOW_MS;
    if (doc.requests.some((request) => request.acceptedAt < cutoff)) {
      doc.requests = doc.requests.filter((request) => request.acceptedAt >= cutoff);
    }
    const pending = new Map(doc.requests.filter((request) => !request.final).map((request) => [request.requestId, request]));
    const events: Observation[] = [];
    const through = await tx.latestEntryId(root.id);
    if (through !== undefined && through > doc.through) {
      let cursor;
      while (pending.size > 0) {
        const page = await tx.scanEntries({ conversationId: root.id, minEntryId: (doc.through + 1) as EntryId, maxEntryId: through, order: "ascending" }, 200, cursor);
        for (const entry of page.items) {
          const send = committedSend(entry);
          if (!send) continue;
          for (const id of send.requestIds) {
            const request = pending.get(id);
            if (!request || send.at < request.acceptedAt) continue;
            if (request.firstAt === undefined) {
              request.firstAt = send.at;
              events.push({ request, stage: "first_reply", at: send.at });
            }
            if (send.end) {
              request.final = { callId: send.callId, at: send.at };
              pending.delete(id);
              events.push({ request, stage: "final_committed", at: send.at });
            }
          }
        }
        cursor = page.next;
        if (cursor === undefined) break;
      }
      doc.through = through;
    }
    for (const item of receipt?.receipts ?? []) {
      const request = doc.requests.find((candidate) => candidate.requestId === item.requestId);
      if (request && request.final?.callId === item.callId && !request.receipt && receipt) {
        request.receipt = { at: now, source: receipt.source };
        events.push({ request, stage: "delivered", at: now });
      }
    }
    for (const request of pending.values()) {
      if (request.terminal !== undefined) continue;
      const inputs = await Promise.all(request.submissions.map((id) => tx.submission(id as SubmissionId)));
      const last = inputs.at(-1);
      if (last?.status !== "unanswered" || inputs.some((input) => input?.status === "queued" || input?.status === "placed")) continue;
      const timedOut = last.reason === "aborted" && (await tx.doc(ChatDoc)).messages.some((message) => message.requestId === request.requestId && message.error !== undefined);
      request.terminal = last.reason === "aborted" && request.cancelRequested && !timedOut ? "cancelled" : "failed";
      events.push({ request, stage: request.terminal, at: now });
    }
    for (const request of doc.requests) {
      if (request.receipt || request.terminal === "cancelled" || request.deadline > now || request.deadlineReported) continue;
      request.deadlineReported = true;
      events.push({ request, stage: request.final ? "missing_receipt" : "no_result", at: request.deadline });
    }
    return events.map(({ request, stage, at }) => ({
      request: {
        requestId: request.requestId, acceptedAt: request.acceptedAt, trace: request.trace && { ...request.trace },
        release: request.release, receipt: request.receipt && { ...request.receipt },
      },
      stage, at,
    }));
  }, BACKGROUND_CONTEXT);
}

export async function markDeliveryCancellation(harness: Harness): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ChatDeliveryDoc);
    for (const request of doc.requests) {
      if (request.final || request.terminal) continue;
      for (const id of request.submissions) {
        const input = await tx.submission(id as SubmissionId);
        if (input?.status === "queued" || input?.status === "placed") {
          request.cancelRequested = true;
          break;
        }
      }
    }
  }, BACKGROUND_CONTEXT);
}

export async function nextDeliveryAlarm(harness: Harness): Promise<number | undefined> {
  const requests = (await harness.snapshot(ChatDeliveryDoc, BACKGROUND_CONTEXT))?.requests ?? [];
  return requests.reduce<number | undefined>((earliest, request) => {
    if (request.receipt || request.terminal === "cancelled" || request.deadlineReported) return earliest;
    return Math.min(earliest ?? Infinity, request.deadline);
  }, undefined);
}

export async function recoverChatDelivery(harness: Harness, root: Conversation, telemetry: TelemetryContext, bot: string): Promise<void> {
  if (await harness.snapshot(ChatDeliveryDoc, BACKGROUND_CONTEXT)) {
    for (const event of await reconcileDelivery(harness, root, Date.now())) observeDelivery(telemetry, bot, event);
  }
}

const METRIC = "lulu_chat_delivery_window";
const QUERY = /^lulu_chat_delivery_window\{measure="([a-z0-9_]+)",from="(\d{1,13})",to="(\d{1,13})"(?:,release="(all)")?\}$/;
const headers = { "Cache-Control": "no-store" };

function outcome(request: ChatDelivery, now: number): string {
  if (request.receipt) return "delivered";
  if (request.final) return request.deadline <= now ? "missing_receipt" : "awaiting_receipt";
  if (request.terminal) return request.terminal;
  return request.deadline <= now ? "no_result" : "pending";
}

function aggregate(requests: ChatDelivery[], measure: string, now: number): [string, number][] {
  if (measure === "accepted") return [["all", requests.length]];
  if (measure === "final_delivery_fraction") return [["all", requests.filter((item) => item.receipt).length / requests.length]];
  if (measure === "overdue") return [["all", requests.filter((item) => !item.receipt && item.terminal !== "cancelled" && item.deadline <= now).length]];
  if (measure === "first_reply_p95_seconds") {
    const latencies = requests.flatMap((item) => item.firstAt === undefined ? [] : [Math.max(0, item.firstAt - item.acceptedAt)]).sort((a, b) => a - b);
    return latencies.length > 0 ? [["all", latencies[Math.ceil(latencies.length * 0.95) - 1]! / 1000]] : [];
  }
  if (measure === "outcome") {
    const counts = new Map<string, number>();
    for (const item of requests) {
      const key = outcome(item, now);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts];
  }
  return [];
}

export async function chatDeliveryQuery(request: Request, read: DocumentReader): Promise<Response> {
  const match = QUERY.exec(new URL(request.url).searchParams.get("query") ?? "");
  const from = Number(match?.[2]);
  const to = Number(match?.[3]);
  if (!match || from >= to || to - from > CHAT_DELIVERY_WINDOW_MS) {
    return Response.json({ status: "error", errorType: "bad_data", error: "Select a window of up to seven days" }, { status: 400, headers });
  }
  const now = Date.now();
  const lower = Math.max(from, now - CHAT_DELIVERY_WINDOW_MS);
  const state = await read.snapshot(ChatDeliveryDoc, BACKGROUND_CONTEXT);
  const requests = (state?.requests ?? []).filter((item) => item.acceptedAt >= lower && item.acceptedAt < to);
  const groups = new Map<string, ChatDelivery[]>();
  if (match[4] === "all") {
    if (requests.length > 0) groups.set("all", requests);
  } else {
    for (const item of requests) {
      const group = groups.get(item.release) ?? [];
      group.push(item);
      groups.set(item.release, group);
    }
  }
  const measure = match[1]!;
  const result = [...groups].flatMap(([release, items]) =>
    aggregate(items, measure, now).map(([outcome, value]) => ({
      metric: { __name__: METRIC, measure, release, outcome },
      value: [now / 1000, String(value)],
    })));
  return Response.json({ status: "success", data: { resultType: "vector", result } }, { headers });
}
