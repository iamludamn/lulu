import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ToolResultEntry, type Conversation, type EntryId, type EntryRecord, type Harness, type SubmissionId } from "@earendil-works/pi-durable";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { SEND_TOOL } from "../protocol/send.js";
import type { ClientMessage } from "../protocol/wire.js";
import { CHAT_DELIVERY_WINDOW_MS, ChatDeliveryDoc, type ChatDelivery } from "./delivery-doc.js";
import { ChatDoc } from "./progress.js";

type Receipt = Extract<ClientMessage, { type: "prompt.receipts" }>;
type Stage = "accepted" | "first_reply" | "final_committed" | "delivered" | "cancelled" | "failed" | "missing_receipt" | "no_result";
type Observation = { request: Pick<ChatDelivery, "requestId" | "acceptedAt" | "trace" | "release" | "receipt">; stage: Stage; at: number };

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
