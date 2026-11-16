import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, LiveDoc, type Conversation, type Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { ChatDoc } from "./progress.js";

export const RequestDeadlinesDoc = defineDoc<{ pending: { id: number; until: number }[] }>({
  kind: "lulu.requests.deadlines",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ pending: [] }),
});

export async function requestDeadlineAt(harness: Harness, now: number): Promise<number | undefined> {
  const pending = (await harness.snapshot(RequestDeadlinesDoc, BACKGROUND_CONTEXT))?.pending ?? [];
  const finished: number[] = [];
  const deadlines: number[] = [];
  for (const item of pending) {
    const submission = await harness.submission(item.id as SubmissionId, BACKGROUND_CONTEXT);
    const record = await submission?.status(BACKGROUND_CONTEXT);
    if (record?.status === "queued" || record?.status === "placed") deadlines.push(Math.max(now + 1000, item.until));
    else finished.push(item.id);
  }
  if (finished.length > 0) await harness.commit(async (tx) => {
    const doc = await tx.doc(RequestDeadlinesDoc);
    doc.pending = doc.pending.filter((item) => !finished.includes(item.id));
  }, BACKGROUND_CONTEXT);
  return deadlines.length === 0 ? undefined : Math.min(...deadlines);
}

export async function expireRequests(harness: Harness, root: Conversation, now: number): Promise<void> {
  const messages = (await harness.snapshot(ChatDoc, BACKGROUND_CONTEXT))?.messages ?? [];
  const due = new Set(((await harness.snapshot(RequestDeadlinesDoc, BACKGROUND_CONTEXT))?.pending ?? []).filter((item) => item.until <= now).map((item) => item.id));
  for (const message of messages) {
    if (message.id === null || !due.has(message.id)) continue;
    if (message.id === null || message.deadline === undefined || message.deadline > now) continue;
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
