import { DelegateCapacityError } from "../delegate/limits.js";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { RunFamily, runIdOf, updateRun } from "../delegate/runs.js";
import { CronJobsDoc } from "./doc.js";
import { GRACE_MS, WATCHDOG_MS, nextRunAfter, type ScheduledJob } from "./schedule.js";

export type FireStart = (tx: Tx, job: ScheduledJob, runId: string) => Promise<unknown>;

export async function fireDue(tx: Tx, now: number, start: FireStart): Promise<string[]> {
  const draft = await tx.doc(CronJobsDoc);
  const fired: string[] = [];
  for (const job of draft.jobs) {
    if (job.state !== "active" || job.nextRunAt === null || job.nextRunAt > now) continue;
    const scheduledFor = job.nextRunAt;
    if (now - scheduledFor > GRACE_MS) {
      job.nextRunAt = job.schedule.kind === "once" ? null : nextRunAfter(job.schedule, now);
      if (job.schedule.kind === "once") job.state = "missed";
      continue;
    }
    const runId = await runIdOf("cron:" + job.id + ":" + scheduledFor);
    try {
      await start(tx, job, runId);
    } catch (error) {
      if (error instanceof DelegateCapacityError) continue;
      throw error;
    }
    fired.push(runId);
    job.lastRun = { scheduledFor, runId };
    job.nextRunAt = nextRunAfter(job.schedule, scheduledFor);
    if (job.schedule.kind === "once") job.state = "done";
  }
  return fired;
}

export async function expireRuns(tx: Tx, now: number): Promise<ConversationId[]> {
  const draft = await tx.doc(CronJobsDoc);
  const children: ConversationId[] = [];
  for (const job of draft.jobs) {
    if (job.lastRun === null) continue;
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
