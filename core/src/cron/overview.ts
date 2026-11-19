import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { PanelDoc } from "../panel/doc.js";
import { SCHEDULE_WIDGET_ID, type PanelState, type ScheduleRow } from "../protocol/panel.js";
import type { SendCard } from "../protocol/send.js";
import { CronJobsDoc } from "./doc.js";
import type { ScheduledJob } from "./schedule.js";

export function scheduleRow(job: ScheduledJob, state: ScheduleRow["state"] = job.state): ScheduleRow {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    state,
    nextRunAt: state === "active" ? job.nextRunAt : null,
    ...(job.lastRun === null ? {} : { lastRunAt: job.lastRun.scheduledFor }),
  };
}

export async function scheduleOverviewCard(harness: Pick<Harness, "snapshot">, context: Context): Promise<SendCard | undefined> {
  const panel = await harness.snapshot(PanelDoc, context);
  if (panel?.widgets[SCHEDULE_WIDGET_ID]?.body.kind === "schedules") return;
  const cron = await harness.snapshot(CronJobsDoc, context);
  const rows = [...(cron?.deleted ?? []), ...(cron?.jobs ?? []).map((job) => scheduleRow(job))].reverse();
  return {
    kind: "panel",
    panel: {
      id: SCHEDULE_WIDGET_ID,
      size: "m",
      title: "定时任务",
      icon: "clock",
      body: { kind: "schedules", revision: panel?.scheduleRevision ?? 1, rows },
    },
  };
}

export async function withScheduleOverview(harness: Pick<Harness, "snapshot">, panel: PanelState, context: Context): Promise<PanelState> {
  const widget = panel.widgets[SCHEDULE_WIDGET_ID];
  if (widget?.body.kind !== "schedules") return panel;
  const jobs = (await harness.snapshot(CronJobsDoc, context))?.jobs ?? [];
  const rows = jobs.map((job) => scheduleRow(job)).reverse();
  return {
    ...panel,
    widgets: { ...panel.widgets, [SCHEDULE_WIDGET_ID]: { ...widget, body: { ...widget.body, rows } } },
  };
}
