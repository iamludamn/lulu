import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness, ModelRef } from "@earendil-works/pi-durable";
import { DefaultDelegateAgent, DelegateAgents } from "../delegate/agents.js";
import { RunFamily } from "../delegate/runs.js";
import { createRun } from "../delegate/spawn.js";
import type { DurableHost } from "../host/types.js";
import type { ScheduleEntry } from "../protocol/contract.js";
import { CronJobsDoc } from "./doc.js";
import { expireRuns, fireDue, nextAlarm } from "./engine.js";

export const RECOVERY_ALARM_DELAY_MS = 60_000;
const SELF_ADVANCING_KINDS: ReadonlySet<string> = new Set(["running", "ready", "completing"]);

export type AlarmOutcome = { fired: string[]; expired: ConversationId[] };

export function fireSchedules(harness: Harness, parentId: ConversationId, selected: ModelRef, now: number): Promise<AlarmOutcome> {
  return harness.commit(async (tx) => {
    const fired = await fireDue(tx, now, (draft, job, runId) =>
      createRun(draft, {
        runId,
        task: job.prompt,
        description: job.name,
        agent: DefaultDelegateAgent,
        presets: DelegateAgents,
        token: "cron:" + job.id,
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

export async function nextAlarmAt(harness: Harness): Promise<number | undefined> {
  const { tasks } = await harness.inspect(BACKGROUND_CONTEXT);
  const advancing = tasks.some((task) => SELF_ADVANCING_KINDS.has(task.state.kind));
  const recovery = advancing ? Date.now() + RECOVERY_ALARM_DELAY_MS : undefined;
  const jobs = (await harness.snapshot(CronJobsDoc, BACKGROUND_CONTEXT))?.jobs ?? [];
  const scheduled = nextAlarm(jobs);
  return recovery === undefined ? scheduled : scheduled === undefined ? recovery : Math.min(recovery, scheduled);
}

export async function replaceAlarm(alarm: DurableHost["alarm"], timestamp: number | undefined): Promise<void> {
  if (timestamp === undefined) await alarm.delete();
  else await alarm.set(timestamp);
}
