import type { Context } from "@earendil-works/chord/context";
import type { CommitPublication, Harness, SubmissionId, SubmissionRecord } from "@earendil-works/pi-durable";
import { DelegateIndex, RunFamily, type RunDoc } from "../delegate/runs.js";
import type { SubmissionReader } from "./submissions.js";

type RunProgress = Pick<RunDoc, "id" | "origin" | "description" | "status" | "waitTaskId" | "noticeId">;
type Notice = { links: number; entry?: string; pending: boolean };

function projectRun({ id, origin, description, status, waitTaskId, noticeId }: RunDoc): RunProgress {
  return { id, origin, description, status, waitTaskId: waitTaskId ?? null, noticeId: noticeId ?? null };
}

export class ProgressRuns {
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
