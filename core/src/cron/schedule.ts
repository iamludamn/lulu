import type { Context } from "@earendil-works/chord/context";
import { defineDoc, type DocumentReader, type SubmissionId } from "@earendil-works/pi-durable";
import { STORED_DOC_KINDS } from "../durable-names.js";
import type { Schedule } from "../protocol/contract.js";
import { SCHEDULE_WIDGET_ID, type PanelState, type ScheduleRow } from "../protocol/panel.js";

export const GRACE_MS = 5 * 60 * 1000;
export const WATCHDOG_MS = 60 * 60 * 1000;

type JobState = "active" | "paused" | "done" | "missed";

export type ScheduledJob = {
  id: string;
  name: string;
  mode?: "task" | "reminder";
  prompt: string;
  schedule: Schedule;
  state: JobState;
  nextRunAt: number | null;
  lastRun: ({ scheduledFor: number } & ({ runId: string } | { submissionId: SubmissionId })) | null;
};

type Zoned = { year: number; month: number; day: number; hour: number; minute: number };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const validTime = (time: string): boolean => TIME.test(time);

function clockIn(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
}

function zonedOf(ms: number, clock: Intl.DateTimeFormat): Zoned {
  const values: Record<string, number> = {};
  for (const part of clock.formatToParts(ms)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute };
}

function offsetOf(ms: number, clock: Intl.DateTimeFormat): number {
  const local = zonedOf(ms, clock);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - Math.floor(ms / 60_000) * 60_000;
}

function instantOf(year: number, month: number, day: number, hour: number, minute: number, clock: Intl.DateTimeFormat): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  return guess - offsetOf(guess - offsetOf(guess, clock), clock);
}

export function nextDailyAfter(time: string, tz: string, after: number): number {
  const [hour, minute] = time.split(":").map(Number);
  const clock = clockIn(tz);
  const today = zonedOf(after, clock);
  for (let offset = 0; offset < 3; offset++) {
    const candidate = instantOf(today.year, today.month, today.day + offset, hour, minute, clock);
    if (candidate > after) return candidate;
  }
  return after + 24 * 60 * 60 * 1000;
}

export function utcDailyCron(at: number): string {
  const utc = new Date(at);
  return `${utc.getUTCMinutes()} ${utc.getUTCHours()} * * *`;
}

export function onceCronTime(at: number): number {
  return Math.ceil(at / 60_000) * 60_000;
}

export function utcOnceCron(at: number): string {
  const utc = new Date(at);
  return `${utc.getUTCMinutes()} ${utc.getUTCHours()} ${utc.getUTCDate()} ${utc.getUTCMonth() + 1} *`;
}

export function cronOccurrence(cron: string, eventTime: number): number | undefined {
  const minute = 60_000;
  for (let at = Math.floor(eventTime / minute) * minute; eventTime - at <= GRACE_MS; at -= minute) {
    if (cron === utcDailyCron(at) || cron === utcOnceCron(at)) return at;
  }
}

export function dailyUtcCrons(time: string, tz: string, now: number): string[] {
  const [hour, minute] = time.split(":").map(Number);
  const clock = clockIn(tz);
  const today = zonedOf(now, clock);
  const crons = new Set<string>();
  for (let offset = 0; offset < 370; offset++) {
    crons.add(utcDailyCron(instantOf(today.year, today.month, today.day + offset, hour, minute, clock)));
  }
  return [...crons];
}

export function nextRunAfter(schedule: Schedule, after: number): number | null {
  if (schedule.kind === "once") return schedule.at > after ? schedule.at : null;
  return nextDailyAfter(schedule.time, schedule.tz, after);
}

export const CRON_KIND = STORED_DOC_KINDS.cronJobs;

export const CronJobsDoc = defineDoc<{ jobs: ScheduledJob[]; deleted?: ScheduleRow[] }>({
  kind: CRON_KIND,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ jobs: [] }),
});

export function scheduleRow(job: ScheduledJob, state: ScheduleRow["state"] = job.state): ScheduleRow {
  return {
    id: job.id,
    name: job.name,
    ...(job.mode === "reminder" && { mode: job.mode }),
    schedule: job.schedule,
    state,
    nextRunAt: state === "active" ? job.nextRunAt : null,
    ...(job.lastRun === null ? {} : { lastRunAt: job.lastRun.scheduledFor }),
  };
}

export async function withScheduleOverview(harness: Pick<DocumentReader, "snapshot">, panel: PanelState, context: Context): Promise<PanelState> {
  if (panel.widgets[SCHEDULE_WIDGET_ID]?.body.kind !== "schedules") return panel;
  return projectScheduleOverview(panel, (await harness.snapshot(CronJobsDoc, context))?.jobs ?? []);
}

export function projectScheduleOverview(panel: PanelState, jobs: readonly ScheduledJob[]): PanelState {
  const widget = panel.widgets[SCHEDULE_WIDGET_ID];
  if (widget?.body.kind !== "schedules") return panel;
  const rows = jobs.map((job) => scheduleRow(job)).reverse();
  return {
    ...panel,
    widgets: { ...panel.widgets, [SCHEDULE_WIDGET_ID]: { ...widget, body: { ...widget.body, rows } } },
  };
}