import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { serviceFetch } from "../telemetry/service.js";
import { AwsClient } from "aws4fetch";
import type { Environment } from "../host/types.js";

const PRESIGN_SECONDS = 900;
const DEFAULT_REGION = "auto";

export interface ObjectStore {
  presign(method: "PUT" | "GET", key: string): Promise<{ url: string; method: string; expiresInSeconds: number }>;
  size(key: string): Promise<number | undefined>;
  remove(keys: string[]): Promise<void>;
}

export const artifactConfigured = (env: Environment): boolean =>
  Boolean(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);

export function objectStore(env: Environment, telemetry: TelemetryContext): ObjectStore | undefined {
  const { S3_ENDPOINT: endpoint, S3_BUCKET: bucket, S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: env.S3_REGION || DEFAULT_REGION });
  const urlOf = (key: string) => `${endpoint.replace(/\/+$/, "")}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return {
    async presign(method, key) {
      const url = new URL(urlOf(key));
      url.searchParams.set("X-Amz-Expires", String(PRESIGN_SECONDS));
      const signed = await aws.sign(url.toString(), { method, aws: { signQuery: true } });
      return { url: signed.url, method, expiresInSeconds: PRESIGN_SECONDS };
    },
    async size(key) {
      const response = await serviceFetch(telemetry, "s3", "head", () => aws.fetch(urlOf(key), { method: "HEAD" }));
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`object store head failed (${response.status})`);
      return Number(response.headers.get("content-length") ?? 0);
    },
    async remove(keys) {
      await Promise.all(
        keys.map(async (key) => {
          const response = await serviceFetch(telemetry, "s3", "delete", () => aws.fetch(urlOf(key), { method: "DELETE" }));
          if (!response.ok && response.status !== 404) throw new Error(`object store delete failed (${response.status})`);
        }),
      );
    },
  };
}
