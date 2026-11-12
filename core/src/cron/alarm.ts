import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness, ModelRef } from "@earendil-works/pi-durable";
import { DefaultDelegateAgent, DelegateAgents } from "../delegate/agents.js";
import { RunFamily } from "../delegate/runs.js";
import { createRun } from "../delegate/spawn.js";
import type { DurableHost } from "../host/types.js";
import type { ScheduleEntry } from "../protocol/contract.js";
import { CronJobsDoc } from "./doc.js";
import { MEMORY_UPDATE } from "../memory/schedule.js";
import { SANDBOX_LIFECYCLE } from "../sandbox/lifecycle.js";
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
  const now = Date.now();
  const deadlines: number[] = [];
  for (const task of tasks) {
    if (!SELF_ADVANCING_KINDS.has(task.state.kind)) continue;
    const state = task.record.state;
    const checkpoint = state.status === "running" || state.status === "pending" ? state.checkpoint : undefined;
    if ((task.record.kind === SANDBOX_LIFECYCLE || task.record.kind === MEMORY_UPDATE) && task.state.kind === "running" && checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint) && checkpoint.phase === "wait" && typeof checkpoint.until === "number" && checkpoint.until > now) deadlines.push(checkpoint.until);
    else deadlines.push(now + RECOVERY_ALARM_DELAY_MS);
  }
  const jobs = (await harness.snapshot(CronJobsDoc, BACKGROUND_CONTEXT))?.jobs ?? [];
  const scheduled = nextAlarm(jobs);
  if (scheduled !== undefined) deadlines.push(scheduled);
  return deadlines.length === 0 ? undefined : Math.min(...deadlines);
}

export async function replaceAlarm(alarm: DurableHost["alarm"], timestamp: number | undefined): Promise<void> {
  if (timestamp === undefined) await alarm.delete();
  else await alarm.set(timestamp);
}
