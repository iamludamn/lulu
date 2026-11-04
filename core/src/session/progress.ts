import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationView, defineDoc, type Harness, type SubmissionId } from "@earendil-works/pi-durable";
import type { MessageProgress, MessageState, SessionProgress, SubtaskProgress } from "../protocol/contract.js";
import { DelegateIndex, RunFamily, type RunDoc } from "../delegate/runs.js";
import { DeliveryDoc, MakeDoc } from "../send/doc.js";

export type ChatMessage = { requestId: string; id: number | null; text: string; after: number | null; at: number };

export function lastEntryId(view: ConversationView | undefined): number | null {
  const last = view?.entries.at(-1);
  return last === undefined ? null : Number(last.id);
}

export type ChatState = { messages: ChatMessage[] };

export const ChatDoc = defineDoc<ChatState>({
  kind: "pistack.chat.messages",
  version: 1,
  scope: "session",
  initial: () => ({ messages: [] }),
});

export async function recordChatMessage(harness: Harness, view: { readonly value: ConversationView }, requestId: string, text: string): Promise<void> {
  await harness.commit(async (tx) => {
    const chat = await tx.doc(ChatDoc);
    if (chat.messages.some((message) => message.requestId === requestId)) return;
    chat.messages.push({ requestId, id: null, text, after: lastEntryId(view.value), at: Date.now() });
  }, BACKGROUND_CONTEXT);
}

export async function linkChatMessage(harness: Harness, requestId: string, id: number): Promise<void> {
  await harness.commit(async (tx) => {
    const chat = await tx.doc(ChatDoc);
    const message = chat.messages.find((entry) => entry.requestId === requestId);
    if (message !== undefined) message.id = id;
  }, BACKGROUND_CONTEXT);
}

const LIVE_TASK_STATES = new Set(["pending", "running", "waiting", "completing"]);

async function subtasksOf(harness: Harness, runs: readonly RunDoc[], message: SubmissionId, context: Context): Promise<SubtaskProgress[]> {
  const subtasks: SubtaskProgress[] = [];
  for (const run of runs) {
    if (!run.origin.includes(message) || run.status === "closed" || run.status === "failed") continue;
    const task = run.waitTaskId ? await harness.getTask(run.waitTaskId, context) : undefined;
    subtasks.push({ id: run.id, description: run.description, running: task !== undefined && LIVE_TASK_STATES.has(task.state.status) });
  }
  return subtasks;
}

async function noticePending(harness: Harness, runs: readonly RunDoc[], message: SubmissionId, context: Context): Promise<boolean> {
  for (const run of runs) {
    if (!run.origin.includes(message) || run.noticeId === null) continue;
    const notice = await harness.submission(run.noticeId, context);
    const record = notice ? await notice.status(context) : undefined;
    if (record?.status === "queued" || record?.status === "placed") return true;
  }
  return false;
}

function stateOf(status: string | undefined, pending: boolean): MessageState {
  if (status === undefined || status === "queued") return "todo";
  if (status === "placed" || pending) return "processing";
  return "done";
}

export async function computeProgress(harness: Harness, context: Context): Promise<SessionProgress> {
  const chat = await harness.snapshot(ChatDoc, context);
  const index = await harness.snapshot(DelegateIndex, context);
  const runs = (await Promise.all((index?.ids ?? []).map((id) => harness.snapshot(RunFamily, id, context)))).filter((run): run is RunDoc => run !== undefined);
  const messages: MessageProgress[] = [];
  for (const message of chat?.messages ?? []) {
    if (message.id === null) continue;
    const id = message.id as SubmissionId;
    const submission = await harness.submission(id, context);
    const record = submission ? await submission.status(context) : undefined;
    const subtasks = await subtasksOf(harness, runs, id, context);
    const pending = subtasks.some((subtask) => subtask.running) || (await noticePending(harness, runs, id, context));
    messages.push({
      id: message.id,
      requestId: message.requestId,
      at: message.at ?? null,
      entry: record?.entry ? String(record.entry) : null,
      answer: record?.answer ? String(record.answer) : null,
      text: message.text,
      after: message.after,
      state: stateOf(record?.status, pending),
      error: record?.status === "unanswered" && record.reason !== "aborted" ? record.reason : null,
      subtasks,
    });
  }
  const hiddenEntries: string[] = [];
  for (const run of runs) {
    if (run.noticeId === null) continue;
    const notice = await harness.submission(run.noticeId, context);
    const record = notice ? await notice.status(context) : undefined;
    if (record?.entry !== undefined) hiddenEntries.push(String(record.entry));
  }
  for (const nudge of (await harness.snapshot(DeliveryDoc, context))?.nudges ?? []) {
    if (nudge.id === null) continue;
    const submission = await harness.submission(nudge.id as SubmissionId, context);
    const record = submission ? await submission.status(context) : undefined;
    if (record?.entry !== undefined) hiddenEntries.push(String(record.entry));
  }
  for (const make of (await harness.snapshot(MakeDoc, context))?.makes ?? []) {
    if (make.id === null) continue;
    const submission = await harness.submission(make.id as SubmissionId, context);
    const record = submission ? await submission.status(context) : undefined;
    if (record?.entry !== undefined) hiddenEntries.push(String(record.entry));
  }
  return { messages, hiddenEntries };
}

export function trackSnapshot<T>(
  harness: Harness,
  compute: (context: Context) => Promise<T>,
  sink: { replace(context: Context, value: T): void },
  context: Context,
  onError: (error: unknown) => void,
): () => void {
  let queue: Promise<void> = Promise.resolve();
  const refresh = (): void => {
    queue = queue.then(async () => sink.replace(context, await compute(context))).catch(onError);
  };
  const unsubscribe = harness.subscribeCommits(() => setTimeout(refresh));
  refresh();
  return unsubscribe;
}

export function trackProgress(
  harness: Harness,
  progress: { replace(context: Context, value: SessionProgress): void },
  context: Context,
  onError: (error: unknown) => void,
): () => void {
  return trackSnapshot(harness, (ctx) => computeProgress(harness, ctx), progress, context, onError);
}
