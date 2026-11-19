import { defineDoc, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import type { TelemetryCarrier } from "@earendil-works/pi-telemetry";
import type { ReceiptSource } from "../protocol/wire.js";

export const CHAT_DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ChatDelivery = {
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

export const ChatDeliveryDoc = defineDoc<{ through: number; requests: ChatDelivery[] }>({
  kind: "lulu.chat.delivery",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ through: 0, requests: [] }),
});

export async function bindDelivery(tx: Tx, origins: readonly number[], submission: SubmissionId): Promise<void> {
  const delivery = await tx.doc(ChatDeliveryDoc);
  for (const request of delivery.requests) {
    if (request.submissions.some((id) => origins.includes(id)) && !request.submissions.includes(submission)) {
      request.submissions.push(submission);
    }
  }
}
