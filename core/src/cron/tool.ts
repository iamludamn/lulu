import type { ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { Type, type Static } from "typebox";
import { runIdOf, shortId } from "../delegate/runs.js";
import type { Schedule } from "../protocol/contract.js";
import { CronJobsDoc } from "./doc.js";
import { appendScheduleOffer, scheduleRow } from "./overview.js";
import { nextRunAfter, validTime, validTimeZone, type ScheduledJob } from "./schedule.js";

const ScheduleParams = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("delete")], {
    description: "create | list | pause | resume | delete",
  }),
  name: Type.Optional(Type.String({ description: "Short label for create" })),
  prompt: Type.Optional(Type.String({ description: "Self-contained task the scheduled run executes, for create" })),
  kind: Type.Optional(Type.Union([Type.Literal("once"), Type.Literal("daily")], { description: "once (one absolute time) or daily (time of day)" })),
  at: Type.Optional(Type.String({ description: "ISO 8601 timestamp with offset, for kind=once" })),
  time: Type.Optional(Type.String({ description: "HH:MM in 24h, for kind=daily" })),
  tz: Type.Optional(Type.String({ description: "IANA time zone, for kind=daily, e.g. Asia/Shanghai" })),
  id: Type.Optional(Type.String({ description: "Job id or unique prefix for pause, resume, delete" })),
});

type ScheduleArgs = Static<typeof ScheduleParams>;

type ScheduleDetails = {
  action: string;
  id: string | null;
};

function ok(text: string, action: string, id: string | null): ToolExecutionResult<ScheduleDetails> {
  return { output: [{ type: "text", text }], details: { action, id } };
}

function fail(text: string): ToolExecutionResult<ScheduleDetails> {
  return { output: [{ type: "text", text }], details: { action: "error", id: null }, isError: true };
}

function scheduleOf(args: ScheduleArgs, now: number): Schedule | string {
  if (args.kind === "once") {
    const at = Date.parse(args.at ?? "");
    if (Number.isNaN(at)) return "kind=once requires at (ISO 8601 with offset)";
    if (at <= now) return "at must be in the future";
    return { kind: "once", at };
  }
  if (!args.time || !validTime(args.time)) return "kind=daily requires time as HH:MM";
  if (!args.tz || !validTimeZone(args.tz)) return "kind=daily requires a valid IANA tz";
  return { kind: "daily", time: args.time, tz: args.tz };
}

function describe(job: ScheduledJob): string {
  const when = job.schedule.kind === "once" ? new Date(job.schedule.at).toISOString() : job.schedule.time + " " + job.schedule.tz;
  const next = job.nextRunAt === null ? "none" : new Date(job.nextRunAt).toISOString();
  return ["id=" + shortId(job.id), "name=" + job.name, "kind=" + job.schedule.kind, "when=" + when, "state=" + job.state, "next=" + next].join("  ");
}

function resolve(jobs: readonly ScheduledJob[], input: string): ScheduledJob | string {
  const matches = jobs.filter((job) => job.id.startsWith(input));
  if (matches.length === 0) return "unknown id: " + input;
  if (matches.length > 1) return "ambiguous id: " + input;
  return matches[0];
}

async function create(api: ToolExecutionApi<ScheduleDetails>, args: ScheduleArgs, context: Context): Promise<ToolExecutionResult<ScheduleDetails>> {
  const name = args.name?.trim();
  const prompt = args.prompt?.trim();
  if (!name) return fail("create requires name");
  if (!prompt) return fail("create requires prompt");
  const id = await runIdOf("cron:create:" + String(api.taskId));
  return api.commit(async (tx) => {
    const draft = await tx.doc(CronJobsDoc);
    const existing = draft.jobs.find((job) => job.id === id);
    if (existing !== undefined) return ok("scheduled " + describe(existing), "create", id);
    if (draft.deleted?.some((row) => row.id === id)) return ok("scheduled " + shortId(id) + " (since deleted)", "create", id);
    const now = Date.now();
    const schedule = scheduleOf(args, now);
    if (typeof schedule === "string") return fail(schedule);
    const job: ScheduledJob = { id, name, prompt, schedule, state: "active", nextRunAt: nextRunAfter(schedule, now), lastRun: null };
    draft.jobs.push(job);
    await appendScheduleOffer(tx, api.conversationId, draft.jobs, draft.deleted ?? [], now);
    return ok("scheduled " + describe(job), "create", id);
  }, context);
}

async function list(api: ToolExecutionApi<ScheduleDetails>, context: Context): Promise<ToolExecutionResult<ScheduleDetails>> {
  const jobs = (await api.snapshot(CronJobsDoc, context))?.jobs ?? [];
  return ok(jobs.length === 0 ? "No scheduled jobs." : jobs.map(describe).join("\n"), "list", null);
}

async function update(api: ToolExecutionApi<ScheduleDetails>, args: ScheduleArgs, context: Context): Promise<ToolExecutionResult<ScheduleDetails>> {
  const input = args.id?.trim();
  if (!input) return fail(args.action + " requires id");
  const jobs = (await api.snapshot(CronJobsDoc, context))?.jobs ?? [];
  const target = resolve(jobs, input);
  if (typeof target === "string") return fail(target);
  const now = Date.now();
  if (args.action === "resume" && target.schedule.kind === "once" && target.schedule.at <= now) return fail("the once time has passed; create a new job");
  await api.commit(async (tx) => {
    const draft = await tx.doc(CronJobsDoc);
    const job = draft.jobs.find((entry) => entry.id === target.id);
    if (!job) return;
    if (args.action === "delete") {
      draft.deleted = [...(draft.deleted ?? []), scheduleRow(job, "deleted")];
      draft.jobs.splice(draft.jobs.indexOf(job), 1);
      return;
    }
    job.state = args.action === "pause" ? "paused" : "active";
    if (args.action === "resume") job.nextRunAt = nextRunAfter(job.schedule, now);
  }, context);
  const updated = args.action === "delete" ? "deleted " + shortId(target.id) : describe({ ...target, state: args.action === "pause" ? "paused" : "active" });
  return ok(updated, args.action, target.id);
}

export const ScheduleTool: ToolRegistration = defineTool({
  name: "schedule",
  description: [
    "Manage scheduled jobs that run a self-contained task later, or every day at a fixed time, and report the result back to this conversation.",
    "Actions: create (name, prompt, kind=once with at, or kind=daily with time and tz), list, pause, resume, delete (id or unique id prefix).",
    "Creating a job automatically offers the user a scheduled task overview. Confirm the result in chat.",
    "Keep this machinery private: never mention job ids or internal state to the user unless they ask.",
  ].join(" "),
  parameters: ScheduleParams,
  replay: "safe",
  executionMode: "parallel",
  execute: async (args, api, context) => {
    switch ((args as ScheduleArgs).action) {
      case "create":
        return create(api, args as ScheduleArgs, context);
      case "list":
        return list(api, context);
      case "pause":
      case "resume":
      case "delete":
        return update(api, args as ScheduleArgs, context);
      default:
        return fail("unknown action: " + String((args as ScheduleArgs).action));
    }
  },
});
