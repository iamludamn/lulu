import { handleApi } from "@lulu/core/server/api.js";
import { workerHost } from "./host.js";

export { Artifact, Bot, Memory } from "./objects.js";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleApi(request, workerHost(env, ctx));
  },
} satisfies ExportedHandler<Env>;
