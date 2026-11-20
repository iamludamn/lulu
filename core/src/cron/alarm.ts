import { DreamingTriggerDoc } from "../memory/dreaming.js";
import { DelegateIndex } from "../delegate/runs.js";
import { REQUEST_TIMEOUT_MS } from "../delegate/limits.js";
import { requestDeadlineAt } from "../conversation/deadlines.js";
import { inputSubmission } from "../conversation/input.js";
import { readSubmission } from "../conversation/submissions.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness, ModelRef } from "@earendil-works/pi-durable";
import { DefaultDelegateAgent, DelegateAgents } from "../delegate/agents.js";
import { RunFamily } from "../delegate/runs.js";
import { createRun } from "../delegate/spawn.js";
import type { ScheduleEntry } from "../protocol/contract.js";
import { CronJobsDoc } from "./doc.js";
import { expireRuns, fireDue, nextAlarm } from "./engine.js";
import { WATCHDOG_MS } from "./schedule.js";

export type AlarmOutcome = { fired: string[]; expired: ConversationId[] };

export async function fireSchedules(harness: Harness, root: Conversation, selected: ModelRef, now: number): Promise<AlarmOutcome> {
  const fired = await fireDue(harness, now, async (tx, job, runId, scheduledFor) => {
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
      presets: DelegateAgents,
      token: "cron:" + job.id,
      scheduleSource: source,
      origin: [],
      parentId: root.id,
      cwd: null,
      model: selected.provider + "/" + selected.modelId,
      thinkingLevel: null,
    });
  });
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

export async function nextScheduleAlarm(harness: Harness, lastRunAt: number): Promise<number | undefined> {
  const deadlines: number[] = [];
  const jobs = (await harness.snapshot(CronJobsDoc, BACKGROUND_CONTEXT))?.jobs ?? [];
  const scheduled = nextAlarm(jobs);
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
