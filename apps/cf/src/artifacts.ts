import { WorkerEntrypoint } from "cloudflare:workers";
import { ArtifactService } from "@lulu/core/artifact/service.js";
import { objectStore } from "@lulu/core/artifact/s3.js";
import { createTelemetry } from "@lulu/core/telemetry/otlp.js";
import { stringsOf } from "./host.js";

export class ArtifactWorker extends WorkerEntrypoint<Env, { name: string }> {
  override fetch(request: Request): Promise<Response> {
    const { name } = this.ctx.props;
    const env = stringsOf(this.env);
    const telemetry = createTelemetry(env, (work) => this.ctx.waitUntil(work));
    const service = new ArtifactService(name, telemetry, objectStore(env, telemetry), () => this.env.ARTIFACTS.getByName(name).exportMetadata());
    return service.fetch(request);
  }
}
