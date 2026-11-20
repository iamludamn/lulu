import type { CronRegistration } from "@lulu/core/cron/registration.js";
import { cronDueAt } from "@lulu/core/cron/engine.js";
import { cronOccurrence, GRACE_MS, utcDailyCron } from "@lulu/core/cron/schedule.js";
import { savedJobs, savedPanel, savedSpace } from "@lulu/core/conversation/bot-data.js";
import { BOT_ID } from "@lulu/core/server/api.js";
import { spaceCronDue } from "@lulu/core/space/refresh.js";
import { workerHost } from "./host.js";

export function cronRegistration(env: Env): CronRegistration | undefined {
  const account = env.LULU_CRON_ACCOUNT_ID;
  const script = env.LULU_CRON_WORKER_NAME;
  const token = env.LULU_CRON_API_TOKEN;
  if (!account || !script || !token) return;
  const key = `${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(script)}`;
  return {
    key,
    async replace(crons) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${key}/schedules`, {
        method: "PUT",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify(crons.map((cron) => ({ cron }))),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json<{ success?: boolean; errors?: { code: number }[] }>();
      if (!response.ok || body.success !== true) {
        throw new Error(`Cloudflare Cron update failed (HTTP ${response.status}, codes ${body.errors?.map(({ code }) => code).join(",") ?? ""})`);
      }
    },
  };
}

export async function dispatchCron(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  if (cronRegistration(env) === undefined) return;
  const { scheduledTime, cron } = controller;
  const now = Date.now();
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime > now) return;
  const rule = cron.trim().replace(/\s+/g, " ");
  const at = cronOccurrence(rule, scheduledTime);
  if (at === undefined || (rule === utcDailyCron(at) && now - at > GRACE_MS)) return;
  const stored = await workerHost(env, ctx).data?.read();
  if (stored !== undefined) {
    const due = cronDueAt(rule, at);
    const hasJob = savedJobs(stored).some((job) => due(job, now) !== undefined);
    const hasSpace = savedPanel(stored)?.order.some((id) => {
      const entry = savedSpace(stored, id);
      return entry !== undefined && spaceCronDue(entry, rule, at, now);
    });
    if (!hasJob && !hasSpace) return;
  }
  await env.BOTS.getByName(BOT_ID).runCron(rule, at);
}
