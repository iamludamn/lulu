import { RequestDeadlinesDoc } from "./deadlines.js";
import type { Context } from "@earendil-works/chord/context";
import { type CommitPublication, type ConversationId, defineDoc, type Harness, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import type { MessageProgress, MessageState, SessionProgress, SubtaskProgress } from "../protocol/contract.js";
import { owedDeliveries, type Entries } from "../send/delivery.js";
import { DeliveryDoc, MakeDoc } from "../send/doc.js";
import { refusedIn, sentIn } from "../send/sent.js";
import { ProgressRuns } from "./progress-runs.js";
import { trackSubmissions, type SubmissionReader } from "./submissions.js";
import { STORED_DOC_KINDS } from "../durable-names.js";

export type ChatMessage = { requestId: string; id: number | null; text: string; after: number | null; at?: number; deadline?: number; error?: string };

export type ChatState = { messages: ChatMessage[] };

export const ChatDoc = defineDoc<ChatState>({
  kind: STORED_DOC_KINDS.chatMessages,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ messages: [] }),
});

const LIVE_TASK_STATES = new Set(["pending", "running", "waiting", "completing"]);

type ProgressInterest = {
  chatIds: Set<SubmissionId>;
  candidates: Set<SubmissionId>;
  submissions: Set<SubmissionId>;
  tasks: Set<TaskId>;
};

function stateOf(status: string | undefined, pending: boolean): MessageState {
  if (status === undefined || status === "queued") return "todo";
  if (status === "placed" || pending) return "processing";
  return "done";
}

async function computeProgress(
  harness: Harness,
  entries: Entries,
  context: Context,
  read: SubmissionReader,
  index: ProgressRuns,
  interest: ProgressInterest,
): Promise<SessionProgress> {
  const runNotices = await index.hiddenEntries(read, context);
  const readTracked: SubmissionReader = (id, ctx) => {
    interest.submissions.add(id);
    return read(id, ctx);
  };
  const chat = await harness.snapshot(ChatDoc, context);
  for (const { id } of chat?.messages ?? []) {
    if (id !== null) interest.chatIds.add(id as SubmissionId);
  }
  const owed = new Set((await owedDeliveries(harness, entries, context, readTracked)).map((item) => item.message));
  const messages: MessageProgress[] = [];
  const oldest = Number(entries[0]?.id ?? 0);
  const pendingRequests = new Set(((await harness.snapshot(RequestDeadlinesDoc, context))?.pending ?? []).map((item) => item.id));
  for (const message of chat?.messages ?? []) {
    if (message.id === null) continue;
    const id = message.id as SubmissionId;
    const runs = [...index.forSubmission(id)];
    const active = runs.some((run) => run.status === "running");
    const pendingNotice = runs.some((run) => index.noticePending(run.noticeId));
    const pendingDelivery = owed.has(message.id);
    const keep = active || pendingNotice || pendingDelivery;
    if (!keep && message.after !== null && message.after < oldest && !pendingRequests.has(message.id) && message !== chat?.messages.at(-1)) continue;
    interest.candidates.add(id);
    const record = await readTracked(id, context);
    if (!keep && (record?.status === "done" || record?.status === "unanswered") && record.entry !== undefined && Number(record.entry) < oldest) continue;
    const subtasks: SubtaskProgress[] = [];
    for (const run of runs) {
      if (run.status === "closed" || run.status === "failed") continue;
      if (run.waitTaskId !== null) interest.tasks.add(run.waitTaskId);
      const task = run.waitTaskId === null ? undefined : await harness.getTask(run.waitTaskId, context);
      subtasks.push({ id: run.id, description: run.description, running: task !== undefined && LIVE_TASK_STATES.has(task.state.status) });
    }
    const pending = pendingNotice || subtasks.some((subtask) => subtask.running);
    messages.push({
      id: message.id,
      requestId: message.requestId,
      at: message.at ?? null,
      entry: record?.entry ? String(record.entry) : null,
      answer: record?.answer ? String(record.answer) : null,
      text: message.text,
      after: message.after,
      state: message.error ? "done" : pendingDelivery ? "processing" : stateOf(record?.status, pending),
      error: message.error ?? (record?.status === "unanswered" && record.reason !== "aborted" ? record.reason : null),
      subtasks,
    });
  }
  const hiddenEntries: string[] = [];
  for (const nudge of (await harness.snapshot(DeliveryDoc, context))?.nudges ?? []) {
    if (nudge.id === null) continue;
    const record = await readTracked(nudge.id as SubmissionId, context);
    if (record?.entry !== undefined) hiddenEntries.push(String(record.entry));
  }
  for (const make of (await harness.snapshot(MakeDoc, context))?.makes ?? []) {
    if (make.id === null) continue;
    const record = await readTracked(make.id as SubmissionId, context);
    if (record?.entry !== undefined) hiddenEntries.push(String(record.entry));
  }
  return { messages, hiddenEntries: hiddenEntries.length === 0 ? runNotices : [...runNotices, ...hiddenEntries] };
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
  root: ConversationId,
  progress: { replace(context: Context, value: SessionProgress): void; pending?(): void },
  entries: () => Entries,
  context: Context,
  onError: (error: unknown) => void,
): () => void {
  const submissions = trackSubmissions(harness);
  const index = new ProgressRuns();
  let interest: ProgressInterest = { chatIds: new Set(), candidates: new Set(), submissions: new Set(), tasks: new Set() };
  let oldest: unknown;
  const stop = trackSnapshot(harness, async (ctx) => {
    await index.load(harness, ctx);
    const view = entries();
    oldest = view[0]?.id;
    interest = { chatIds: new Set(), candidates: new Set(), submissions: new Set(), tasks: new Set() };
    return computeProgress(harness, view, ctx, submissions.read, index, interest);
  }, progress, context, onError, (publication) => {
    const runsChanged = index.advance(publication, (run) => run.origin.some((id) =>
      interest.candidates.has(id) || (interest.chatIds.has(id) && (run.status === "running" || index.noticePending(run.noticeId))),
    ));
    return runsChanged || publication.changes.some((change) => {
      switch (change.type) {
        case "submission":
          return interest.submissions.has(change.value.id);
        case "task":
          return interest.tasks.has(change.value.id);
        case "entry":
          return change.value.conversationId === root &&
            (oldest !== entries()[0]?.id || sentIn([change.value]).length > 0 || refusedIn([change.value]).size > 0);
        case "document":
          return change.record.kind === ChatDoc.definition.kind || change.record.kind === RequestDeadlinesDoc.definition.kind ||
            change.record.kind === DeliveryDoc.definition.kind || change.record.kind === MakeDoc.definition.kind;
        default:
          return false;
      }
    });
  });
  return () => {
    stop();
    submissions.stop();
  };
}
