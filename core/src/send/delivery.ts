import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Harness, SubmissionId } from "@earendil-works/pi-durable";
import { ChatDoc } from "../session/progress.js";
import { DeliveryDoc } from "./doc.js";
import { sentIn } from "./sent.js";

const MAX_NUDGES = 2;

export const NUDGE_PROMPT =
  "[System reminder] Your previous turn ended without a send_to_user call, so the user received nothing and is still waiting. " +
  "Do not assume an earlier acknowledgement delivered the result. Deliver it now by actually calling send_to_user with end_turn true. " +
  "If you cannot tell what they last asked, say you may have missed it and ask them to resend; never claim work you cannot see.";

export type Entries = readonly { id?: unknown; kind?: unknown; model?: unknown }[];

export type Owed = { message: number; requestId: string };

async function silent(harness: Harness, id: number, entries: Entries, context: Context): Promise<boolean> {
  const submission = await harness.submission(id as SubmissionId, context);
  const record = submission ? await submission.status(context) : undefined;
  if (record?.status !== "done") return false;
  const from = Number(record.entry);
  const to = Number(record.answer);
  return sentIn(entries.filter((entry) => Number(entry.id) > from && Number(entry.id) <= to)).length === 0;
}

export async function owedDeliveries(harness: Harness, entries: Entries, context: Context): Promise<Owed[]> {
  const chat = await harness.snapshot(ChatDoc, context);
  const delivery = await harness.snapshot(DeliveryDoc, context);
  const since = delivery?.since ?? Number.POSITIVE_INFINITY;
  const message = chat?.messages.filter((item) => item.id !== null).at(-1);
  if (message?.id == null || message.id <= since) return [];
  const chain = (delivery?.nudges ?? []).filter((nudge) => nudge.message === message.id);
  const last = chain.at(-1);
  if (last !== undefined && last.id === null) return [{ message: message.id, requestId: last.requestId }];
  if (chain.length >= MAX_NUDGES || !(await silent(harness, last?.id ?? message.id, entries, context))) return [];
  return [{ message: message.id, requestId: `nudge:${message.id}#${chain.length}` }];
}

export async function chaseDeliveries(harness: Harness, root: Conversation, entries: Entries): Promise<void> {
  for (const owed of await owedDeliveries(harness, entries, BACKGROUND_CONTEXT)) {
    await harness.commit(async (tx) => {
      const delivery = await tx.doc(DeliveryDoc);
      if (!delivery.nudges.some((nudge) => nudge.requestId === owed.requestId)) delivery.nudges.push({ message: owed.message, requestId: owed.requestId, id: null });
    }, BACKGROUND_CONTEXT);
    const submission = await root.submit({ type: "input", content: NUDGE_PROMPT, requestId: owed.requestId, whenBusy: "followUp" }, BACKGROUND_CONTEXT);
    await harness.commit(async (tx) => {
      const nudge = (await tx.doc(DeliveryDoc)).nudges.find((item) => item.requestId === owed.requestId);
      if (nudge !== undefined) nudge.id = submission.id as number;
    }, BACKGROUND_CONTEXT);
  }
}
