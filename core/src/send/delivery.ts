import { bindDelivery } from "../conversation/delivery-doc.js";
import { inputSubmission } from "../conversation/input.js";
import { InjectionBindings } from "../memory/doc.js";
import { entryRange } from "../conversation/view.js";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Harness, SubmissionId, SubmissionRecord } from "@earendil-works/pi-durable";
import { ChatDoc } from "../conversation/progress.js";
import { readSubmission, type SubmissionReader } from "../conversation/submissions.js";
import { DeliveryDoc } from "./doc.js";
import { sentIn } from "./sent.js";

const MAX_NUDGES = 2;

export const NUDGE_PROMPT =
  "[System reminder] Your previous turn ended without a send_to_user call, so the user received nothing and is still waiting. " +
  "Do not assume an earlier acknowledgement delivered the result. Deliver it now by actually calling send_to_user with end_turn true. " +
  "If you cannot tell what they last asked, say you may have missed it and ask them to resend; never claim work you cannot see.";

export type Entries = readonly { id?: unknown; kind?: unknown; model?: unknown }[];

export type Owed = { message: number; requestId: string | null };

async function silent(harness: Harness, record: SubmissionRecord | undefined, entries: Entries, context: Context): Promise<boolean> {
  if (record?.status !== "done") return false;
  const from = Number(record.entry);
  const to = Number(record.answer);
  if (entries.length === 0 || Number(entries[0].id) > from) entries = await entryRange(await harness.root(context), from, to, context);
  return sentIn(entries.filter((entry) => Number(entry.id) > from && Number(entry.id) <= to)).length === 0;
}

export async function owedDeliveries(
  harness: Harness,
  entries: Entries,
  context: Context,
  read: SubmissionReader = (id, ctx) => readSubmission(harness, id, ctx),
): Promise<Owed[]> {
  const chat = await harness.snapshot(ChatDoc, context);
  const delivery = await harness.snapshot(DeliveryDoc, context);
  const since = delivery?.since ?? Number.POSITIVE_INFINITY;
  const message = chat?.messages.filter((item) => item.id !== null).at(-1);
  if (message?.id == null || message.error || message.id <= since) return [];
  const chain = (delivery?.nudges ?? []).filter((nudge) => nudge.message === message.id);
  const last = chain.at(-1);
  if (last !== undefined && last.id === null) return [{ message: message.id, requestId: last.requestId }];
  const record = await read((last?.id ?? message.id) as SubmissionId, context);
  if (last !== undefined && (record?.status === "queued" || record?.status === "placed")) return [{ message: message.id, requestId: null }];
  if (chain.length >= MAX_NUDGES || !(await silent(harness, record, entries, context))) return [];
  return [{ message: message.id, requestId: `nudge:${message.id}#${chain.length}` }];
}

export async function chaseDeliveries(harness: Harness, root: Conversation, entries: Entries, run: (work: () => Promise<void>) => Promise<void>): Promise<void> {
  for (const owed of await owedDeliveries(harness, entries, BACKGROUND_CONTEXT)) {
    const { requestId } = owed;
    if (requestId === null) continue;
    await run(async () => {
      await harness.commit(async (tx) => {
        const delivery = await tx.doc(DeliveryDoc);
        if (!delivery.nudges.some((nudge) => nudge.requestId === requestId)) delivery.nudges.push({ message: owed.message, requestId, id: null });
      }, BACKGROUND_CONTEXT);
      await harness.commit(async (tx) => {
        const id = await root.submit(tx, inputSubmission({ kind: "delivery_retry", messageId: owed.message, content: NUDGE_PROMPT, requestId }));
        await bindDelivery(tx, [owed.message], id);
        const bindings = await tx.doc(InjectionBindings);
        const originalRequest = bindings.requests[String(owed.message)];
        if (originalRequest !== undefined) bindings.requests[String(id)] = originalRequest;
        const nudge = (await tx.doc(DeliveryDoc)).nudges.find((item) => item.requestId === requestId);
        if (nudge !== undefined) nudge.id = Number(id);
      }, BACKGROUND_CONTEXT);
      harness.resume();
    });
  }
}
