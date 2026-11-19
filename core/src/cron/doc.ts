import { defineDoc } from "@earendil-works/pi-durable";
import type { ScheduledJob } from "./schedule.js";
import type { ScheduleRow } from "../protocol/panel.js";
import { STORED_DOC_KINDS } from "../durable-names.js";

export const CRON_KIND = STORED_DOC_KINDS.cronJobs;

export const CronJobsDoc = defineDoc<{ jobs: ScheduledJob[]; deleted?: ScheduleRow[] }>({
  kind: CRON_KIND,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ jobs: [] }),
});
