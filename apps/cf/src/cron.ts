import type { CronRegistration } from "@lulu/core/cron/registration.js";
import { GRACE_MS, utcDailyCron, utcOnceCron } from "@lulu/core/cron/schedule.js";
import { BOT_ID } from "@lulu/core/server/api.js";

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

export async function dispatchCron(controller: ScheduledController, env: Env): Promise<void> {
  if (cronRegistration(env) === undefined) return;
  const { scheduledTime, cron } = controller;
  const now = Date.now();
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime % 60_000 !== 0 || scheduledTime > now) return;
  const rule = cron.trim().replace(/\s+/g, " ");
  if (rule === utcOnceCron(scheduledTime) || (rule === utcDailyCron(scheduledTime) && now - scheduledTime <= GRACE_MS)) {
    await env.BOTS.getByName(BOT_ID).runCron(rule, scheduledTime);
  }
}
