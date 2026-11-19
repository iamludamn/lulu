import type { Context } from "@earendil-works/chord/context";
import { defineEntry } from "@earendil-works/pi-durable";
import type { ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import { PanelDoc } from "../panel/doc.js";
import { SCHEDULE_OFFER_KIND, SCHEDULE_WIDGET_ID, type PanelState, type ScheduleRow } from "../protocol/panel.js";
import type { SendCard } from "../protocol/send.js";
import { CronJobsDoc } from "./doc.js";
import type { ScheduledJob } from "./schedule.js";

type ScheduleCard = Extract<SendCard, { kind: "panel" }>;
export const ScheduleOfferEntry = defineEntry<{ widget: ScheduleCard; at: number }>(SCHEDULE_OFFER_KIND);

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

export async function appendScheduleOffer(tx: Tx, conversation: ConversationId, jobs: readonly ScheduledJob[], deleted: readonly ScheduleRow[], at: number): Promise<void> {
  const panel = await tx.doc(PanelDoc);
  if (panel.widgets[SCHEDULE_WIDGET_ID]?.body.kind === "schedules") return;
  const revision = (panel.scheduleRevision ?? 0) + 1;
  const rows = new Map(deleted.map((row) => [row.id, row]));
  for (const job of jobs) rows.set(job.id, scheduleRow(job));
  await tx.appendEntry(ScheduleOfferEntry, conversation, {
    data: {
      at,
      widget: {
        kind: "panel",
        panel: {
          id: SCHEDULE_WIDGET_ID,
          size: "m",
          title: "定时任务",
          icon: "clock",
          body: { kind: "schedules", revision, rows: [...rows.values()].reverse() },
        },
      },
    },
  });
  panel.scheduleRevision = revision;
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
