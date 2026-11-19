import { DreamingTriggerDoc } from "../memory/dreaming.js";
import { DelegateIndex } from "../delegate/runs.js";
import { REQUEST_TIMEOUT_MS } from "../delegate/limits.js";
import { requestDeadlineAt } from "../conversation/deadlines.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness, ModelRef } from "@earendil-works/pi-durable";
import { DefaultDelegateAgent, DelegateAgents } from "../delegate/agents.js";
import { RunFamily } from "../delegate/runs.js";
import { createRun } from "../delegate/spawn.js";
import type { ScheduleEntry } from "../protocol/contract.js";
import { CronJobsDoc } from "./doc.js";
import { expireRuns, fireDue, nextAlarm } from "./engine.js";
import { WATCHDOG_MS } from "./schedule.js";

export type AlarmOutcome = { fired: string[]; expired: ConversationId[] };

export function fireSchedules(harness: Harness, parentId: ConversationId, selected: ModelRef, now: number): Promise<AlarmOutcome> {
  return harness.commit(async (tx) => {
    const fired = await fireDue(tx, now, (draft, job, runId, scheduledFor) =>
      createRun(draft, {
        runId,
        task: job.prompt,
        description: job.name,
        agent: DefaultDelegateAgent,
        presets: DelegateAgents,
        token: "cron:" + job.id,
        scheduleSource: { kind: "schedule_message", scheduleId: job.id, scheduledFor },
        origin: [],
        parentId,
        cwd: null,
        forkAt: null,
        model: selected.provider + "/" + selected.modelId,
        thinkingLevel: null,
      }),
    );
    return { fired, expired: await expireRuns(tx, now) };
  }, BACKGROUND_CONTEXT);
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
    const run = job.lastRun ? await harness.snapshot(RunFamily, job.lastRun.runId, BACKGROUND_CONTEXT) : undefined;
    entries.push({
      id: job.id,
      name: job.name,
      schedule: job.schedule,
      state: job.state,
      nextRunAt: job.nextRunAt,
      lastRun: job.lastRun && run ? { scheduledFor: job.lastRun.scheduledFor, status: run.status } : null,
    });
  }
  return entries;
}

export async function nextScheduleAlarm(harness: Harness, lastRunAt: number): Promise<number | undefined> {
  const deadlines: number[] = [];
  const jobs = (await harness.snapshot(CronJobsDoc, BACKGROUND_CONTEXT))?.jobs ?? [];
  const scheduled = nextAlarm(jobs);
  if (scheduled !== undefined) deadlines.push(scheduled <= lastRunAt ? lastRunAt + 60_000 : scheduled);
  const cronRuns = new Set(jobs.flatMap((job) => job.lastRun === null ? [] : [job.lastRun.runId]));
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
