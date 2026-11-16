import { RequestDeadlinesDoc } from "./deadlines.js";
import { REQUEST_TIMEOUT_MS } from "../delegate/limits.js";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type CommitPublication, type ConversationView, defineDoc, type Harness, type SubmissionId } from "@earendil-works/pi-durable";
import type { MessageProgress, MessageState, SessionProgress, SubtaskProgress } from "../protocol/contract.js";
import { DelegateIndex, RunFamily, type RunDoc } from "../delegate/runs.js";
import { owedDeliveries, type Entries } from "../send/delivery.js";
import { DeliveryDoc, MakeDoc } from "../send/doc.js";
import { readSubmission, trackSubmissions, type SubmissionReader } from "./submissions.js";

export type ChatMessage = { requestId: string; id: number | null; text: string; after: number | null; at?: number; deadline?: number; error?: string };

export function lastEntryId(view: ConversationView | undefined): number | null {
  const last = view?.entries.at(-1);
  return last === undefined ? null : Number(last.id);
}

export type ChatState = { messages: ChatMessage[] };

export const ChatDoc = defineDoc<ChatState>({
  kind: "pistack.chat.messages",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ messages: [] }),
});

export async function recordChatMessage(harness: Harness, view: { readonly value: ConversationView }, requestId: string, text: string): Promise<void> {
  await harness.commit(async (tx) => {
    const chat = await tx.doc(ChatDoc);
    if (chat.messages.some((message) => message.requestId === requestId)) return;
    chat.messages.push({ requestId, id: null, text, after: lastEntryId(view.value), at: Date.now(), deadline: Date.now() + REQUEST_TIMEOUT_MS });
  }, BACKGROUND_CONTEXT);
}

export async function linkChatMessage(harness: Harness, requestId: string, id: number): Promise<void> {
  await harness.commit(async (tx) => {
    const chat = await tx.doc(ChatDoc);
    const message = chat.messages.find((entry) => entry.requestId === requestId);
    if (message !== undefined) {
      message.id = id;
      const deadlines = await tx.doc(RequestDeadlinesDoc);
      if (message.deadline !== undefined && !deadlines.pending.some((item) => item.id === id)) deadlines.pending.push({ id, until: message.deadline });
    }
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

async function noticePending(read: SubmissionReader, runs: readonly RunDoc[], message: SubmissionId, context: Context): Promise<boolean> {
  for (const run of runs) {
    if (!run.origin.includes(message) || run.noticeId === null) continue;
    const record = await read(run.noticeId, context);
    if (record?.status === "queued" || record?.status === "placed") return true;
  }
  return false;
}

function stateOf(status: string | undefined, pending: boolean): MessageState {
  if (status === undefined || status === "queued") return "todo";
  if (status === "placed" || pending) return "processing";
  return "done";
}

export async function computeProgress(
  harness: Harness,
  entries: () => Entries,
  context: Context,
  read: SubmissionReader = (id, ctx) => readSubmission(harness, id, ctx),
): Promise<SessionProgress> {
  const chat = await harness.snapshot(ChatDoc, context);
  const index = await harness.snapshot(DelegateIndex, context);
  const runs = (await Promise.all((index?.ids ?? []).map((id) => harness.snapshot(RunFamily, id, context)))).filter((run): run is RunDoc => run !== undefined);
  const owed = new Set((await owedDeliveries(harness, entries(), context, read)).map((item) => item.message));
  const messages: MessageProgress[] = [];
  const oldest = Number(entries()[0]?.id ?? 0);
  const pendingRequests = new Set(((await harness.snapshot(RequestDeadlinesDoc, context))?.pending ?? []).map((item) => item.id));
  const active = new Set(runs.filter((run) => run.status === "running").flatMap((run) => run.origin));
  for (const message of chat?.messages ?? []) {
    if (message.id === null) continue;
    const id = message.id as SubmissionId;
    if (message.after !== null && message.after < oldest && !pendingRequests.has(message.id) && !active.has(id) && message !== chat?.messages.at(-1)) continue;
    const record = await read(id, context);
    if ((record?.status === "done" || record?.status === "unanswered") && record.entry !== undefined && Number(record.entry) < oldest && !runs.some((run) => run.status === "running" && run.origin.includes(id))) continue;
    const subtasks = await subtasksOf(harness, runs, id, context);
    const pending = subtasks.some((subtask) => subtask.running) || (await noticePending(read, runs, id, context));
    messages.push({
      id: message.id,
      requestId: message.requestId,
      at: message.at ?? null,
      entry: record?.entry ? String(record.entry) : null,
      answer: record?.answer ? String(record.answer) : null,
      text: message.text,
      after: message.after,
      state: message.error ? "done" : owed.has(message.id) ? "processing" : stateOf(record?.status, pending),
      error: message.error ?? (record?.status === "unanswered" && record.reason !== "aborted" ? record.reason : null),
      subtasks,
    });
  }
  const hiddenEntries: string[] = [];
  for (const run of runs) {
    if (run.noticeId === null) continue;
    const record = await read(run.noticeId, context);
    if (record?.entry !== undefined) hiddenEntries.push(String(record.entry));
  }
  for (const nudge of (await harness.snapshot(DeliveryDoc, context))?.nudges ?? []) {
    if (nudge.id === null) continue;
    const record = await read(nudge.id as SubmissionId, context);
    if (record?.entry !== undefined) hiddenEntries.push(String(record.entry));
  }
  for (const make of (await harness.snapshot(MakeDoc, context))?.makes ?? []) {
    if (make.id === null) continue;
    const record = await read(make.id as SubmissionId, context);
    if (record?.entry !== undefined) hiddenEntries.push(String(record.entry));
  }
  return { messages, hiddenEntries };
}

export function trackSnapshot<T>(
  harness: Harness,
  compute: (context: Context) => Promise<T>,
  sink: { replace(context: Context, value: T): void; pending?(): void },
  context: Context,
  onError: (error: unknown) => void,
  relevant: (publication: CommitPublication) => boolean = () => true,
): () => void {
  let dirty = false;
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (): Promise<void> => {
    timer = undefined;
    running = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        try {
          const value = await compute(context);
          if (!stopped && !dirty) sink.replace(context, value);
        } catch (error) {
          if (!stopped) onError(error);
        }
      }
    } finally {
      running = false;
    }
  };
  const refresh = (): void => {
    if (stopped) return;
    dirty = true;
    sink.pending?.();
    if (!running && timer === undefined) timer = setTimeout(() => void run());
  };
  const unsubscribe = harness.observeCommits({ advance: (publication) => {
    if (relevant(publication)) refresh();
  }, end: () => {} });
  const stop = (): void => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe.detach();
    unsubscribeClose();
  };
  const unsubscribeClose = harness.subscribeClose(stop);
  refresh();
  return stop;
}

export function trackProgress(
  harness: Harness,
  progress: { replace(context: Context, value: SessionProgress): void; pending?(): void },
  entries: () => Entries,
  context: Context,
  onError: (error: unknown) => void,
): () => void {
  const submissions = trackSubmissions(harness);
  const stop = trackSnapshot(harness, (ctx) => computeProgress(harness, entries, ctx, submissions.read), progress, context, onError);
  return () => {
    stop();
    submissions.stop();
  };
}
