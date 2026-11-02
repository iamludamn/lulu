import { defineExtension, section } from "@earendil-works/pi-durable";
import { ScheduleTool } from "./tool.js";
import { CronJobsDoc } from "./doc.js";

const ScheduledJobsSection = section("scheduled_jobs", async (input, context) => {
  const jobs = (await input.read.snapshot(CronJobsDoc, context))?.jobs ?? [];
  const rows = jobs.filter((job) => job.state === "active" || job.state === "paused").map((job) => "- " + job.name + " (" + job.schedule.kind + ", " + job.state + ")");
  return rows.length === 0 ? undefined : rows.join("\n");
});

export const CronExtension = defineExtension({
  name: "pistack.cron",
  tools: [ScheduleTool],
  sections: [ScheduledJobsSection],
});
