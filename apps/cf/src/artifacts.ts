import { WorkerEntrypoint } from "cloudflare:workers";
import { ArtifactService } from "@lulu/core/artifact/service.js";
import { objectStore } from "@lulu/core/artifact/s3.js";
import { createTelemetry } from "@lulu/core/telemetry/otlp.js";
import { D1ArtifactMetadata } from "./artifact-metadata.js";
import { stringsOf } from "./host.js";

export class ArtifactWorker extends WorkerEntrypoint<Env, { name: string }> {
  override fetch(request: Request): Promise<Response> {
    const { name } = this.ctx.props;
    const env = stringsOf(this.env);
    const telemetry = createTelemetry(env, (work) => this.ctx.waitUntil(work));
    const bucket = objectStore(env, telemetry);
    if (bucket === undefined || this.env.LULU_METADATA === undefined) {
      return Promise.resolve(Response.json({ error: "Artifact storage is not configured" }, { status: 503 }));
    }
    const metadata = new D1ArtifactMetadata(this.env.LULU_METADATA, name, async () => {
      const saved = await bucket.readJson<Record<string, unknown>>(`metadata/${name}/artifacts.json`);
      return saved?.value ?? this.env.ARTIFACTS.getByName(name).exportMetadata();
    });
    const service = new ArtifactService(telemetry, bucket, metadata);
    return service.fetch(request);
  }
}
