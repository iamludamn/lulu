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
  readJson<T>(key: string): Promise<{ etag: string; value: T } | undefined>;
  etag(key: string): Promise<string | undefined>;
  writeJson(key: string, value: unknown, etag: string | undefined): Promise<boolean>;
  writeOnce(key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<void>;
  copyOnce(from: string, to: string): Promise<void>;
}

export const artifactConfigured = (env: Environment): boolean =>
  Boolean(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);

export function objectStore(env: Environment, telemetry: TelemetryContext): ObjectStore | undefined {
  const { S3_ENDPOINT: endpoint, S3_BUCKET: bucket, S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: env.S3_REGION || DEFAULT_REGION });
  const copyCondition = new URL(endpoint).hostname.endsWith(".r2.cloudflarestorage.com") ? "cf-copy-destination-if-none-match" : "If-None-Match";
  const pathOf = (key: string) => `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const urlOf = (key: string) => endpoint.replace(/\/+$/, "") + pathOf(key);
  async function put(key: string, headers: HeadersInit, body?: BodyInit): Promise<boolean> {
    const response = await serviceFetch(telemetry, "s3", "put", () => aws.fetch(urlOf(key), { method: "PUT", headers, body }), undefined, [412]);
    if (response.status === 412) return false;
    if (!response.ok) throw new Error(`object store put failed (${response.status})`);
    return true;
  }
  const head = (key: string) => serviceFetch(telemetry, "s3", "head", () => aws.fetch(urlOf(key), { method: "HEAD" }), undefined, [404]);
  return {
    async presign(method, key) {
      const url = new URL(urlOf(key));
      url.searchParams.set("X-Amz-Expires", String(PRESIGN_SECONDS));
      const signed = await aws.sign(url.toString(), { method, aws: { signQuery: true } });
      return { url: signed.url, method, expiresInSeconds: PRESIGN_SECONDS };
    },
    async size(key) {
      const response = await head(key);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`object store head failed (${response.status})`);
      return Number(response.headers.get("content-length") ?? 0);
    },
    async etag(key) {
      const response = await head(key);
      if (response.status === 404) return undefined;
      const tag = response.headers.get("etag");
      if (!response.ok || tag === null) throw new Error(`object store metadata head failed (${response.status})`);
      return tag;
    },
    async remove(keys) {
      await Promise.all(
        keys.map(async (key) => {
          const response = await serviceFetch(telemetry, "s3", "delete", () => aws.fetch(urlOf(key), { method: "DELETE" }), undefined, [404]);
          if (!response.ok && response.status !== 404) throw new Error(`object store delete failed (${response.status})`);
        }),
      );
    },
    async readJson<T>(key: string) {
      const response = await serviceFetch(telemetry, "s3", "get", () => aws.fetch(urlOf(key)), undefined, [404]);
      if (response.status === 404) return undefined;
      const etag = response.headers.get("etag");
      if (!response.ok || etag === null) throw new Error(`object store metadata read failed (${response.status})`);
      return { etag, value: await response.json() as T };
    },
    writeJson(key, value, etag) {
      return put(key, { "content-type": "application/json", ...(etag === undefined ? { "If-None-Match": "*" } : { "If-Match": etag }) }, JSON.stringify(value));
    },
    async writeOnce(key, bytes, contentType) {
      await put(key, { "content-type": contentType, "If-None-Match": "*" }, bytes);
    },
    async copyOnce(from, to) {
      await put(to, { "x-amz-copy-source": pathOf(from), [copyCondition]: "*" });
    },
  };
}
