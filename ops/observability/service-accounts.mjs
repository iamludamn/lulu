import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const CREDENTIAL_HOST = "a1234@wujiahaodemacbook-pro.tailfdc8bd.ts.net";

function batch(now = Date.now()) {
  const metrics = new Map();
  return {
    add(name, value, labels = {}) {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid_metric");
      const metric = metrics.get(name) ?? { name: `lulu.account.${name}`, gauge: { dataPoints: [] } };
      metric.gauge.dataPoints.push({
        timeUnixNano: String(BigInt(now) * 1000000n),
        asDouble: value,
        attributes: Object.entries(labels).map(([key, value]) => ({ key: `account.${key}`, value: { stringValue: value } })),
      });
      metrics.set(name, metric);
    },
    payload() {
      return { resourceMetrics: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "lulu-service-accounts" } }] },
        scopeMetrics: [{ scope: { name: "lulu.service-accounts" }, metrics: [...metrics.values()] }],
      }] };
    },
  };
}

async function get(url, headers) {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("provider_query_failed");
  return response.json();
}

async function r2(dataset, selection, start, end) {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: `query($start:Time!,$end:Time!,$bucket:string!){viewer{accounts(filter:{accountTag:"de4897a194002b8815e728d7240c4218"}){${dataset}(limit:100,filter:{datetime_geq:$start,datetime_lt:$end,bucketName:$bucket}){${selection}}}}}`,
      variables: { start, end, bucket: process.env.S3_BUCKET },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("provider_query_failed");
  const body = await response.json();
  const accounts = body.data?.viewer?.accounts;
  const rows = accounts?.[0]?.[dataset];
  if (body.errors?.length || accounts?.length !== 1 || !Array.isArray(rows)) throw new Error("provider_query_failed");
  return rows;
}

async function collect() {
  const result = batch();
  const now = Date.now();
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const sources = [
    {
      provider: "tavily", dataset: "credits", configured: Boolean(process.env.TAVILY_API_KEY),
      async query() {
        const body = await get("https://api.tavily.com/usage", { authorization: `Bearer ${process.env.TAVILY_API_KEY}` });
        const points = [];
        for (const [scope, fields] of Object.entries({ key: ["usage", "limit", "search_usage", "extract_usage", "crawl_usage", "map_usage", "research_usage"], account: ["plan_usage", "plan_limit", "paygo_usage", "paygo_limit", "search_usage", "extract_usage", "crawl_usage", "map_usage", "research_usage"] })) {
          for (const field of fields) {
            const value = body[scope]?.[field];
            const present = typeof value === "number" && Number.isFinite(value) && value >= 0;
            points.push(["tavily.field_present", present ? 1 : 0, { scope, field }]);
            if (present) points.push(["tavily.credits", value, { scope, field }]);
          }
        }
        if (!points.some(([name, , labels]) => name === "tavily.credits" && labels.scope === "key" && labels.field === "usage")) throw new Error("missing_usage");
        return points;
      },
    },
    {
      provider: "exa", dataset: "cost", configured: Boolean(process.env.EXA_SERVICE_KEY && process.env.EXA_API_KEY),
      async query() {
        const url = new URL(`https://admin-api.exa.ai/team-management/api-keys/${encodeURIComponent(process.env.EXA_API_KEY)}/usage`);
        url.searchParams.set("start_date", start.toISOString());
        url.searchParams.set("end_date", new Date(now).toISOString());
        const body = await get(url, { "x-api-key": process.env.EXA_SERVICE_KEY });
        if (typeof body.total_cost_usd !== "number" || !Number.isFinite(body.total_cost_usd) || body.total_cost_usd < 0) throw new Error("missing_cost");
        return [["exa.cost_usd", body.total_cost_usd, { scope: "key", window: "calendar_mtd" }], ["window_start_timestamp", start.getTime() / 1000, {}], ["window_end_timestamp", now / 1000, {}]];
      },
    },
    {
      provider: "exa", dataset: "balance", configured: Boolean(process.env.EXA_SERVICE_KEY),
      async query() {
        const body = await get("https://admin-api.exa.ai/team-management/credits", { "x-api-key": process.env.EXA_SERVICE_KEY });
        if (typeof body.credits_usd !== "number" || !Number.isFinite(body.credits_usd)) throw new Error("missing_balance");
        return [["exa.balance_usd", body.credits_usd, { scope: "team" }]];
      },
    },
  ];
  const r2Configured = Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.S3_BUCKET && process.env.S3_ENDPOINT?.replace(/\/+$/, "") === "https://de4897a194002b8815e728d7240c4218.r2.cloudflarestorage.com");
  const windowStart = new Date(now - 86400000).toISOString();
  const windowEnd = new Date(now).toISOString();
  for (const [dataset, node, selection, fields] of [
    ["operations", "r2OperationsAdaptiveGroups", "sum{requests}", { requests: "requests" }],
    ["storage", "r2StorageAdaptiveGroups", "max{payloadSize metadataSize objectCount uploadCount}", { payloadSize: "payload_max_bytes", metadataSize: "metadata_max_bytes", objectCount: "objects_max", uploadCount: "pending_uploads_max" }],
    ["bandwidth", "r2BandwidthUsageAdaptiveGroups", "sum{bytesUpload bytesDownload}", { bytesUpload: "upload_bytes", bytesDownload: "download_bytes" }],
  ]) {
    sources.push({
      provider: "r2", dataset, configured: r2Configured,
      async query() {
        const rows = await r2(node, selection, windowStart, windowEnd);
        const points = [["r2.data_present", rows.length > 0 ? 1 : 0, {}], ["window_start_timestamp", (now - 86400000) / 1000, {}], ["window_end_timestamp", now / 1000, {}]];
        if (rows.length > 1) throw new Error("unexpected_groups");
        for (const row of rows) {
          const values = row.sum ?? row.max;
          const labels = { scope: "shared_bucket", window: "trailing_24h" };
          for (const [field, metric] of Object.entries(fields)) {
            const value = values?.[field];
            if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("invalid_usage");
            points.push([`r2.${metric}`, value, labels]);
          }
        }
        return points;
      },
    });
  }
  await Promise.all(sources.map(async (source) => {
    const labels = { provider: source.provider, dataset: source.dataset };
    result.add("configured", source.configured ? 1 : 0, labels);
    result.add("attempt_timestamp", now / 1000, labels);
    if (!source.configured) {
      result.add("collection_success", 0, labels);
      return;
    }
    try {
      const points = await source.query();
      for (const [name, value, scope] of points) result.add(name, value, { ...labels, ...scope });
      result.add("collection_success", 1, labels);
      result.add("data_timestamp", now / 1000, labels);
    } catch {
      result.add("collection_success", 0, labels);
    }
  }));
  return result.payload();
}

async function remoteCollection() {
  const source = await readFile(new URL(import.meta.url), "utf8");
  return new Promise((resolve, reject) => {
    const child = execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", CREDENTIAL_HOST,
      "PATH=/opt/homebrew/bin:/usr/bin:/bin /opt/homebrew/bin/op run --environment dwa4hq6cqvhqrxt3jywkaadhzy -- /opt/homebrew/bin/node --input-type=module - --collect"],
    { timeout: 100000, maxBuffer: 1048576 }, (error, stdout) => {
      if (error) {
        console.error(JSON.stringify({ message: "Credential host command failed", code: error.code, signal: error.signal, timedOut: error.killed }));
        return reject(Object.assign(new Error("credential_host_unavailable"), { needsAuthorization: error.code === 9 }));
      }
      try {
        const payload = JSON.parse(stdout);
        if (!Array.isArray(payload.resourceMetrics)) throw new Error("invalid_payload");
        resolve(payload);
      } catch {
        reject(new Error("invalid_remote_payload"));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(source);
  });
}

async function push(payload) {
  const endpoint = process.env.SERVICE_METRICS_ENDPOINT ?? "http://127.0.0.1:9090/api/v1/otlp/v1/metrics";
  const url = new URL(endpoint);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("metrics_endpoint_must_be_loopback");
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("metrics_export_rejected");
  const result = await response.json().catch(() => ({}));
  if (result.partialSuccess?.rejectedDataPoints > 0) throw new Error("metrics_export_partial");
}

async function main() {
  if (process.argv.includes("--collect")) {
    process.stdout.write(JSON.stringify(await collect()));
    return;
  }
  const health = batch();
  let payload;
  let failed = false;
  let needsAuthorization = false;
  try {
    payload = process.argv.includes("--remote") ? await remoteCollection() : await collect();
    health.add("exporter_success", 1);
  } catch (error) {
    needsAuthorization = error?.needsAuthorization === true;
    failed = true;
    health.add("exporter_success", 0);
    console.error(JSON.stringify({ message: "Service account collection unavailable" }));
  }
  health.add("credential_authorization_required", needsAuthorization ? 1 : 0);
  health.add("exporter_attempt_timestamp", Date.now() / 1000);
  const body = health.payload();
  body.resourceMetrics.push(...(payload?.resourceMetrics ?? []));
  await push(body);
  console.log(JSON.stringify({ message: "Service account observation exported", sourceAvailable: !failed }));
  if (failed) process.exitCode = needsAuthorization ? 9 : 1;
}

await main().catch(() => {
  console.error(JSON.stringify({ message: "Service account exporter failed" }));
  process.exitCode = 1;
});
