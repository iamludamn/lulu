import { DelegateCapacityError } from "../delegate/limits.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness, SubmissionId, Tx } from "@earendil-works/pi-durable";
import { RunFamily, runIdOf, updateRun } from "../delegate/runs.js";
import { CronJobsDoc } from "./doc.js";
import { GRACE_MS, WATCHDOG_MS, nextRunAfter, type ScheduledJob } from "./schedule.js";

export type FireStart = (tx: Tx, job: ScheduledJob, runId: string, scheduledFor: number) => Promise<SubmissionId | void>;

const dueAt = (job: ScheduledJob, now: number): number | undefined =>
  job.state === "active" && job.nextRunAt !== null && job.nextRunAt <= now ? job.nextRunAt : undefined;

export async function fireDue(harness: Pick<Harness, "snapshot" | "commit">, now: number, start: FireStart): Promise<string[]> {
  const jobs = (await harness.snapshot(CronJobsDoc, BACKGROUND_CONTEXT))?.jobs ?? [];
  const fired: string[] = [];
  for (const candidate of jobs) {
    if (dueAt(candidate, now) === undefined) continue;
    try {
      const dispatched = await harness.commit(async (tx) => {
        const job = (await tx.doc(CronJobsDoc)).jobs.find((row) => row.id === candidate.id);
        if (job === undefined) return;
        const scheduledFor = dueAt(job, now);
        if (scheduledFor === undefined) return;
        if (now - scheduledFor > GRACE_MS) {
          job.nextRunAt = job.schedule.kind === "once" ? null : nextRunAfter(job.schedule, now);
          if (job.schedule.kind === "once") job.state = "missed";
          return;
        }
        const runId = await runIdOf("cron:" + job.id + ":" + scheduledFor);
        const submissionId = await start(tx, job, runId, scheduledFor);
        job.lastRun = submissionId === undefined ? { scheduledFor, runId } : { scheduledFor, submissionId };
        job.nextRunAt = nextRunAfter(job.schedule, scheduledFor);
        if (job.schedule.kind === "once") job.state = "done";
        return runId;
      }, BACKGROUND_CONTEXT);
      if (dispatched !== undefined) fired.push(dispatched);
    } catch (error) {
      if (error instanceof DelegateCapacityError) continue;
      throw error;
    }
  }
  return fired;
}

export async function expireRuns(tx: Tx, now: number): Promise<ConversationId[]> {
  const draft = await tx.doc(CronJobsDoc);
  const children: ConversationId[] = [];
  for (const job of draft.jobs) {
    if (job.lastRun === null || !("runId" in job.lastRun)) continue;
    const run = await tx.doc(RunFamily, job.lastRun.runId, { id: job.lastRun.runId, task: "", description: "", origin: [], agent: "", cwd: "" });
    if (run.status !== "running" || now - run.startedAt < WATCHDOG_MS) continue;
    if (run.conversationId !== null) children.push(run.conversationId);
    await updateRun(tx, job.lastRun.runId, { status: "failed", endedAt: now, error: "timeout" });
  }
  return children;
}

export function nextAlarm(jobs: readonly ScheduledJob[]): number | undefined {
  const times = jobs.filter((job) => job.state === "active" && job.nextRunAt !== null).map((job) => job.nextRunAt as number);
  return times.length === 0 ? undefined : Math.min(...times);
}
