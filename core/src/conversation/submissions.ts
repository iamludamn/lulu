import type { Context } from "@earendil-works/chord/context";
import type { Harness, SubmissionId, SubmissionRecord } from "@earendil-works/pi-durable";

export type SubmissionReader = (id: SubmissionId, context: Context) => Promise<SubmissionRecord | undefined>;

export async function readSubmission(harness: Harness, id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
  const submission = await harness.submission(id, context);
  return submission?.status(context);
}

export function trackSubmissions(harness: Harness): { read: SubmissionReader; stop(): void } {
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
