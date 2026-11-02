import { handleApi } from "@lulu/core/server/api.js";
import { workerHost } from "./host.js";

export { Artifact, Bot, Memory, Registry } from "./objects.js";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleApi(request, workerHost(env));
  },
} satisfies ExportedHandler<Env>;
