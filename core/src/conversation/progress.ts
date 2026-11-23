import type { Context } from "@earendil-works/chord/context";
import type { CommitPublication, ConversationId, Harness, SubmissionId, SubmissionRecord, TaskId } from "@earendil-works/pi-durable";
import { DelegateIndex, RunFamily, type RunDoc } from "../delegate/runs.js";
import type { MessageProgress, MessageState, SessionProgress, SubtaskProgress } from "../protocol/contract.js";
import { MakeDoc } from "../send/make.js";
import { CHAT_PROGRESS_DOCUMENT_KINDS, chatRequestProgress, deliveryRetryIds } from "./requests.js";
import { readSubmission, refusedIn, sentIn, type SubmissionReader } from "./transcript.js";

type Entries = readonly { id?: unknown; kind?: unknown; model?: unknown }[];

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
  const { messages: requests, pendingDeliveryId, pendingDeadlines } = await chatRequestProgress(harness, entries, context, readTracked);
  for (const { id } of requests) {
    if (id !== null) interest.chatIds.add(id as SubmissionId);
  }
  const messages: MessageProgress[] = [];
  const oldest = Number(entries[0]?.id ?? 0);
  for (const message of requests) {
    if (message.id === null) continue;
    const id = message.id as SubmissionId;
    const runs = [...index.forSubmission(id)];
    const active = runs.some((run) => run.status === "running");
    const pendingNotice = runs.some((run) => index.noticePending(run.noticeId));
    const pendingDelivery = message.id === pendingDeliveryId;
    const keep = active || pendingNotice || pendingDelivery;
    if (!keep && message.after !== null && message.after < oldest && !pendingDeadlines.has(message.id) && message !== requests.at(-1)) continue;
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
  for (const id of await deliveryRetryIds(harness, context)) {
    const record = await readTracked(id, context);
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
          return CHAT_PROGRESS_DOCUMENT_KINDS.has(change.record.kind) || change.record.kind === MakeDoc.definition.kind;
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

function trackSubmissions(harness: Harness): { read: SubmissionReader; stop(): void } {
  const records = new Map<SubmissionId, Promise<SubmissionRecord | undefined>>();
  let stopped = false;
  const unsubscribe = harness.observeCommits({ advance: (publication) => {
    if (stopped) return;
    for (const change of publication.changes) {
      if (change.type === "submission" && records.has(change.value.id)) {
        records.set(change.value.id, Promise.resolve(change.value));
      }
    }
  }, end: () => {} });
  const stop = (): void => {
    stopped = true;
    unsubscribe.detach();
    unsubscribeClose();
    records.clear();
  };
  const unsubscribeClose = harness.subscribeClose(stop);
  return {
    read: (id, context) => {
      if (stopped) return readSubmission(harness, id, context);
      const cached = records.get(id);
      if (cached !== undefined) return cached;
      const pending = readSubmission(harness, id, context).catch((error: unknown) => {
        if (records.get(id) === pending) records.delete(id);
        throw error;
      });
      records.set(id, pending);
      return pending;
    },
    stop,
  };
}

type RunProgress = Pick<RunDoc, "id" | "origin" | "description" | "status" | "waitTaskId" | "noticeId">;
type Notice = { links: number; entry?: string; pending: boolean };

function projectRun({ id, origin, description, status, waitTaskId, noticeId }: RunDoc): RunProgress {
  return { id, origin, description, status, waitTaskId: waitTaskId ?? null, noticeId: noticeId ?? null };
}

class ProgressRuns {
  readonly #runs = new Map<string, RunProgress>();
  readonly #bySubmission = new Map<SubmissionId, Map<string, RunProgress>>();
  readonly #notices = new Map<SubmissionId, Notice>();
  readonly #unreadNotices = new Set<SubmissionId>();
  #duringLoad: Map<string, RunProgress | undefined> | undefined = new Map();
  #hiddenEntries: string[] | undefined;

  async load(harness: Harness, context: Context): Promise<void> {
    if (this.#duringLoad === undefined) return;
    const index = await harness.snapshot(DelegateIndex, context);
    const runs = await Promise.all((index?.ids ?? []).map(async (key) => {
      const run = await harness.snapshot(RunFamily, key, context);
      return [key, run === undefined ? undefined : projectRun(run)] as const;
    }));
    for (const [key, run] of runs) {
      this.#replace(key, this.#duringLoad.has(key) ? this.#duringLoad.get(key) : run);
      this.#duringLoad.delete(key);
    }
    for (const [key, run] of this.#duringLoad) this.#replace(key, run);
    this.#duringLoad = undefined;
  }

  forSubmission(id: SubmissionId): Iterable<RunProgress> {
    return this.#bySubmission.get(id)?.values() ?? [];
  }

  noticePending(id: SubmissionId | null): boolean {
    return id !== null && this.#notices.get(id)?.pending === true;
  }

  async hiddenEntries(read: SubmissionReader, context: Context): Promise<string[]> {
    await Promise.all([...this.#unreadNotices].map(async (id) => {
      const notice = this.#notices.get(id);
      const record = await read(id, context);
      if (this.#unreadNotices.has(id) && this.#notices.get(id) === notice) this.#updateNotice(id, record);
    }));
    return this.#hiddenEntries ??= [...this.#notices.values()].flatMap((notice) => notice.entry === undefined ? [] : [notice.entry]);
  }

  advance(publication: CommitPublication, interested: (run: RunProgress) => boolean): boolean {
    let relevant = false;
    for (const change of publication.changes) {
      if (change.type !== "document" || change.record.kind !== RunFamily.definition.kind || change.record.key === undefined) continue;
      const key = change.record.key;
      const next = change.kind === "retire" ? undefined : projectRun(change.value as RunDoc);
      if (this.#duringLoad !== undefined) {
        this.#duringLoad.set(key, next);
        relevant = true;
        continue;
      }
      const previous = this.#runs.get(key);
      if (previous && next && previous.status === next.status && previous.description === next.description &&
          previous.waitTaskId === next.waitTaskId && previous.noticeId === next.noticeId &&
          previous.origin.length === next.origin.length && previous.origin.every((id, i) => id === next.origin[i])) continue;
      this.#replace(key, next);
      if ((previous?.noticeId ?? null) !== (next?.noticeId ?? null) || (previous && interested(previous)) || (next && interested(next))) relevant = true;
    }
    for (const change of publication.changes) {
      if (change.type === "submission" && this.#updateNotice(change.value.id, change.value)) relevant = true;
    }
    return relevant;
  }

  #replace(key: string, next: RunProgress | undefined): void {
    const previous = this.#runs.get(key);
    for (const id of previous?.origin ?? []) {
      if (next?.origin.includes(id)) continue;
      const runs = this.#bySubmission.get(id);
      runs?.delete(key);
      if (runs?.size === 0) this.#bySubmission.delete(id);
    }
    if (next === undefined) this.#runs.delete(key);
    else {
      this.#runs.set(key, next);
      for (const id of next.origin) {
        const runs = this.#bySubmission.get(id) ?? new Map<string, RunProgress>();
        runs.set(key, next);
        this.#bySubmission.set(id, runs);
      }
    }
    const previousNotice = previous?.noticeId ?? null;
    const nextNotice = next?.noticeId ?? null;
    if (previousNotice === nextNotice) return;
    if (previousNotice !== null) {
      const notice = this.#notices.get(previousNotice);
      if (notice !== undefined && --notice.links === 0) {
        if (notice.entry !== undefined) this.#hiddenEntries = undefined;
        this.#notices.delete(previousNotice);
        this.#unreadNotices.delete(previousNotice);
      }
    }
    if (nextNotice !== null) {
      const notice = this.#notices.get(nextNotice);
      if (notice !== undefined) notice.links++;
      else {
        this.#notices.set(nextNotice, { links: 1, pending: false });
        this.#unreadNotices.add(nextNotice);
      }
    }
  }

  #updateNotice(id: SubmissionId, record: SubmissionRecord | undefined): boolean {
    const notice = this.#notices.get(id);
    if (notice === undefined) return false;
    this.#unreadNotices.delete(id);
    const entry = record?.entry === undefined ? undefined : String(record.entry);
    const pending = record?.status === "queued" || record?.status === "placed";
    const changed = notice.entry !== entry || notice.pending !== pending;
    if (notice.entry !== entry) this.#hiddenEntries = undefined;
    notice.entry = entry;
    notice.pending = pending;
    return changed;
  }
}
