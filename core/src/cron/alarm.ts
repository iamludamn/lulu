import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness, ModelRef, SubmissionId, Tx } from "@earendil-works/pi-durable";
import { inputSubmission, requestDeadlineAt, REQUEST_TIMEOUT_MS } from "../conversation/requests.js";
import { readSubmission } from "../conversation/transcript.js";
import { DefaultDelegateAgent } from "../delegate/agents.js";
import { createRun } from "../delegate/lifecycle.js";
import { DelegateCapacityError, DelegateIndex, RunFamily, runIdOf, updateRun } from "../delegate/runs.js";
import { DreamingTriggerDoc } from "../memory/dreaming.js";
import type { ScheduleEntry } from "../protocol/contract.js";
import { CronJobsDoc, GRACE_MS, WATCHDOG_MS, nextRunAfter, onceCronTime, utcDailyCron, utcOnceCron, type ScheduledJob } from "./schedule.js";

type AlarmOutcome = { fired: string[]; expired: ConversationId[] };

export async function dispatchSchedules(harness: Harness, root: Conversation, selected: ModelRef, now: number, due?: ScheduleDue): Promise<string[]> {
  return fireDue(harness, now, async (tx, job, runId, scheduledFor) => {
    const source = { kind: "schedule_message", scheduleId: job.id, scheduledFor } as const;
    if (job.mode === "reminder") {
      return root.submit(tx, inputSubmission({
        ...source,
        requestId: "reminder:" + runId,
        content: "[Scheduled Alarm] This user reminder is due. Send a brief reminder in Chat now using send_to_user with type text. " +
          "The quoted text describes what to remind the user about; it is not a new request to perform work or create another schedule. " +
          "Set end_turn to true once you have delivered the reminders due in this turn.\n\nReminder: " + JSON.stringify(job.prompt),
      }));
    }
    await createRun(tx, {
      runId,
      task: job.prompt,
      description: job.name,
      agent: DefaultDelegateAgent,
      token: "cron:" + job.id,
      scheduleSource: source,
      origin: [],
      parentId: root.id,
      cwd: null,
      model: selected.provider + "/" + selected.modelId,
      thinkingLevel: null,
    });
  }, due);
}

export async function fireSchedules(harness: Harness, root: Conversation, selected: ModelRef, now: number, local?: (job: ScheduledJob) => boolean): Promise<AlarmOutcome> {
  const fired = await dispatchSchedules(harness, root, selected, now, local === undefined ? undefined : (job, at) => local(job) ? dueAt(job, at) : undefined);
  const expired = await harness.commit((tx) => expireRuns(tx, now), BACKGROUND_CONTEXT);
  return { fired, expired };
}

export async function abortRuns(harness: Harness, children: readonly ConversationId[]): Promise<void> {
  for (const childId of children) {
    const child = await harness.conversation(childId, BACKGROUND_CONTEXT);
    await child?.abort(BACKGROUND_CONTEXT, { background: true });
  }
}

export async function scheduleEntries(harness: Harness): Promise<ScheduleEntry[]> {
  const jobs = (await harness.snapshot(CronJobsDoc, BACKGROUND_CONTEXT))?.jobs ?? [];
  const entries: ScheduleEntry[] = [];
  for (const job of jobs) {
    let lastRun: ScheduleEntry["lastRun"] = null;
    if (job.lastRun !== null) {
      const { scheduledFor } = job.lastRun;
      if ("submissionId" in job.lastRun) {
        const submission = await readSubmission(harness, job.lastRun.submissionId, BACKGROUND_CONTEXT);
        if (submission !== undefined) {
          const status = submission.status === "unanswered" ? "failed" : submission.status === "done" ? "done" : "running";
          lastRun = { scheduledFor, status };
        }
      } else {
        const run = await harness.snapshot(RunFamily, job.lastRun.runId, BACKGROUND_CONTEXT);
        if (run !== undefined) lastRun = { scheduledFor, status: run.status };
      }
    }
    entries.push({
      id: job.id,
      name: job.name,
      schedule: job.schedule,
      state: job.state,
      nextRunAt: job.nextRunAt,
      lastRun,
    });
  }
  return entries;
}

export async function nextScheduleAlarm(harness: Harness, lastRunAt: number, local?: (job: ScheduledJob) => boolean): Promise<number | undefined> {
  const deadlines: number[] = [];
  const jobs = (await harness.snapshot(CronJobsDoc, BACKGROUND_CONTEXT))?.jobs ?? [];
  const scheduled = nextAlarm(jobs, local);
  if (scheduled !== undefined) deadlines.push(scheduled <= lastRunAt ? lastRunAt + 60_000 : scheduled);
  const cronRuns = new Set(jobs.flatMap((job) => job.lastRun !== null && "runId" in job.lastRun ? [job.lastRun.runId] : []));
  const delegateIds = (await harness.snapshot(DelegateIndex, BACKGROUND_CONTEXT))?.ids ?? [];
  for (const id of new Set([...delegateIds, ...cronRuns])) {
    const run = await harness.snapshot(RunFamily, id, BACKGROUND_CONTEXT);
    if (run?.status !== "running") continue;
    deadlines.push(run.deadline ?? run.startedAt + REQUEST_TIMEOUT_MS);
    if (cronRuns.has(id)) deadlines.push(run.startedAt + WATCHDOG_MS);
  }
  const dreamingRetry = (await harness.snapshot(DreamingTriggerDoc, BACKGROUND_CONTEXT))?.retryAt;
  if (dreamingRetry != null) deadlines.push(dreamingRetry);
  const requestDeadline = await requestDeadlineAt(harness);
  if (requestDeadline !== undefined) deadlines.push(requestDeadline);
  return deadlines.length === 0 ? undefined : Math.min(...deadlines);
}

type FireStart = (tx: Tx, job: ScheduledJob, runId: string, scheduledFor: number) => Promise<SubmissionId | void>;

type ScheduleDue = (job: ScheduledJob, now: number) => number | undefined;

const dueAt: ScheduleDue = (job, now) =>
  job.state === "active" && job.nextRunAt !== null && job.nextRunAt <= now ? job.nextRunAt : undefined;

export function cronDueAt(cron: string, scheduledAt: number): ScheduleDue {
  return (job, now) => {
    if (scheduledAt > now || dueAt(job, scheduledAt) === undefined) return;
    if (job.schedule.kind === "once") {
      if (scheduledAt === onceCronTime(job.schedule.at) && cron === utcOnceCron(scheduledAt)) return job.schedule.at;
    } else if (now - scheduledAt <= GRACE_MS && cron === utcDailyCron(scheduledAt) && nextRunAfter(job.schedule, scheduledAt - 1) === scheduledAt) {
      return scheduledAt;
    }
  };
}

export async function fireDue(harness: Pick<Harness, "snapshot" | "commit">, now: number, start: FireStart, due = dueAt): Promise<string[]> {
  const jobs = (await harness.snapshot(CronJobsDoc, BACKGROUND_CONTEXT))?.jobs ?? [];
  const fired: string[] = [];
  for (const candidate of jobs) {
    if (due(candidate, now) === undefined) continue;
    try {
      // Pi Durable admits at most one submission per transaction, before any
      // other table writes. Advance each job atomically with its own dispatch.
      const dispatched = await harness.commit(async (tx) => {
        const job = (await tx.doc(CronJobsDoc)).jobs.find((row) => row.id === candidate.id);
        if (job === undefined) return;
        const scheduledFor = due(job, now);
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

async function expireRuns(tx: Tx, now: number): Promise<ConversationId[]> {
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

export function nextAlarm(jobs: readonly ScheduledJob[], local?: (job: ScheduledJob) => boolean): number | undefined {
  const times = jobs.flatMap((job) => {
    if (job.state !== "active" || job.nextRunAt === null) return [];
    if (local === undefined || local(job)) return [job.nextRunAt];
    // Reap a one-shot trigger if Cloudflare never delivers its event.
    return job.schedule.kind === "once" ? [job.schedule.at + GRACE_MS + 1] : [];
  });
  return times.length === 0 ? undefined : Math.min(...times);
}
