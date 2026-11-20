import type { SubmissionId } from "@earendil-works/pi-durable";
import type { Schedule } from "../protocol/contract.js";

export const GRACE_MS = 5 * 60 * 1000;
export const WATCHDOG_MS = 60 * 60 * 1000;

export type JobState = "active" | "paused" | "done" | "missed";

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

function zonedOf(ms: number, tz: string): Zoned {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(ms)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute };
}

function offsetOf(ms: number, tz: string): number {
  const local = zonedOf(ms, tz);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - Math.floor(ms / 60_000) * 60_000;
}

function instantOf(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  return guess - offsetOf(guess - offsetOf(guess, tz), tz);
}

export function nextDailyAfter(time: string, tz: string, after: number): number {
  const [hour, minute] = time.split(":").map(Number);
  const today = zonedOf(after, tz);
  for (let offset = 0; offset < 3; offset++) {
    const candidate = instantOf(today.year, today.month, today.day + offset, hour, minute, tz);
    if (candidate > after) return candidate;
  }
  return after + 24 * 60 * 60 * 1000;
}

export function nextRunAfter(schedule: Schedule, after: number): number | null {
  if (schedule.kind === "once") return schedule.at > after ? schedule.at : null;
  return nextDailyAfter(schedule.time, schedule.tz, after);
}
