import { defineDoc } from "@earendil-works/pi-durable";
import type { ScheduledJob } from "./schedule.js";

export const CRON_KIND = "pistack.cron.jobs";

export const CronJobsDoc = defineDoc<{ jobs: ScheduledJob[] }>({
  kind: CRON_KIND,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ jobs: [] }),
});
