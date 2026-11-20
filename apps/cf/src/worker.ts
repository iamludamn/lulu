import { handleApi, spaceIngress } from "@lulu/core/server/api.js";
import { workerHost } from "./host.js";
import { dispatchCron } from "./cron.js";

export { Artifact, Bot, Memory } from "./objects.js";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const host = workerHost(env, ctx);
    if (!url.pathname.startsWith("/api/") && spaceIngress(url, host.env) === "private") return env.ASSETS.fetch(request);
    return handleApi(request, host);
  },
  scheduled: dispatchCron,
} satisfies ExportedHandler<Env>;
