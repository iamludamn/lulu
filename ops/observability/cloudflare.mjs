import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const ACCOUNT = "de4897a194002b8815e728d7240c4218";
const CREDENTIAL_HOST = "a1234@wujiahaodemacbook-pro.tailfdc8bd.ts.net";
const NAMESPACES = {
  "5e8e206cdcdf43ada6b37dc6c076944e": "Bot",
  "8052c218316c420ebdf7e9851f921977": "Memory",
  "283988c20fc1447681c8075abf12b281": "Artifact",
};

const QUERIES = {
  "worker": "query($start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:\"de4897a194002b8815e728d7240c4218\"}){workersInvocationsAdaptive(limit:1,filter:{datetime_geq:$start,datetime_lt:$end,scriptName:\"lulu\"}){avg{sampleInterval} sum{requests errors cpuTimeUs}}}}}",
  "do_requests": "query($start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:\"de4897a194002b8815e728d7240c4218\"}){durableObjectsInvocationsAdaptiveGroups(limit:10,filter:{datetime_geq:$start,datetime_lt:$end,namespaceId_in:[\"5e8e206cdcdf43ada6b37dc6c076944e\", \"8052c218316c420ebdf7e9851f921977\", \"283988c20fc1447681c8075abf12b281\"]}){dimensions{namespaceId} avg{sampleInterval} sum{requests errors}}}}}",
  "do_usage": "query($start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:\"de4897a194002b8815e728d7240c4218\"}){durableObjectsPeriodicGroups(limit:10,filter:{datetime_geq:$start,datetime_lt:$end,namespaceId_in:[\"5e8e206cdcdf43ada6b37dc6c076944e\", \"8052c218316c420ebdf7e9851f921977\", \"283988c20fc1447681c8075abf12b281\"]}){dimensions{namespaceId} avg{sampleInterval} sum{duration activeTime cpuTime rowsRead rowsWritten}}}}}",
  "do_storage": "query($start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:\"de4897a194002b8815e728d7240c4218\"}){durableObjectsSqlStorageGroups(limit:10,filter:{datetime_geq:$start,datetime_lt:$end,namespaceId_in:[\"5e8e206cdcdf43ada6b37dc6c076944e\", \"8052c218316c420ebdf7e9851f921977\", \"283988c20fc1447681c8075abf12b281\"]}){dimensions{namespaceId} max{storedBytes}}}}}",
  "kv_ops": "query($start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:\"de4897a194002b8815e728d7240c4218\"}){kvOperationsAdaptiveGroups(limit:100,filter:{datetime_geq:$start,datetime_lt:$end,namespaceId:\"92e198ee66014ccdb1e69776615c880c\"}){dimensions{actionType} avg{sampleInterval} sum{requests}}}}}",
  "kv_storage": "query($start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:\"de4897a194002b8815e728d7240c4218\"}){kvStorageAdaptiveGroups(limit:1,filter:{datetime_geq:$start,datetime_lt:$end,namespaceId:\"92e198ee66014ccdb1e69776615c880c\"}){max{byteCount keyCount}}}}}"
};

const DATASETS = {
  worker: { node: "workersInvocationsAdaptive", fields: { requests: ["worker.requests", 1], errors: ["worker.errors", 1], cpuTimeUs: ["worker.cpu_seconds", 1e-6] } },
  do_requests: { node: "durableObjectsInvocationsAdaptiveGroups", fields: { requests: ["do.requests", 1], errors: ["do.errors", 1] } },
  do_usage: { node: "durableObjectsPeriodicGroups", fields: { duration: ["do.duration_gb_seconds", 1], activeTime: ["do.active_seconds", 1e-6], cpuTime: ["do.cpu_seconds", 1e-6], rowsRead: ["do.rows_read", 1], rowsWritten: ["do.rows_written", 1] } },
  do_storage: { node: "durableObjectsSqlStorageGroups", fields: { storedBytes: ["do.storage_max_bytes", 1] } },
  kv_ops: { node: "kvOperationsAdaptiveGroups", fields: { requests: ["kv.operations", 1] } },
  kv_storage: { node: "kvStorageAdaptiveGroups", fields: { byteCount: ["kv.storage_max_bytes", 1], keyCount: ["kv.storage_max_keys", 1] } },
};

function batch(now = Date.now()) {
  const metrics = new Map();
  return {
    add(name, value, labels = {}) {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid_metric");
      const metric = metrics.get(name) ?? { name: `lulu.cf.${name}`, gauge: { dataPoints: [] } };
      metric.gauge.dataPoints.push({
        timeUnixNano: String(BigInt(now) * 1000000n),
        asDouble: value,
        attributes: Object.entries(labels).map(([key, value]) => ({ key: `cf.${key}`, value: { stringValue: value } })),
      });
      metrics.set(name, metric);
    },
    payload() {
      return { resourceMetrics: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "lulu-cloudflare" } }] },
        scopeMetrics: [{ scope: { name: "lulu.cloudflare" }, metrics: [...metrics.values()] }],
      }] };
    },
  };
}

async function query(name, start, end) {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query: QUERIES[name], variables: { start: new Date(start).toISOString(), end: new Date(end).toISOString() } }),
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error("cloudflare_http_error");
  const body = await response.json();
  const accounts = body.data?.viewer?.accounts;
  const rows = accounts?.[0]?.[DATASETS[name].node];
  if (body.errors?.length || accounts?.length !== 1 || !Array.isArray(rows)) throw new Error("cloudflare_query_error");
  return rows;
}

function scopes(name) {
  if (name.startsWith("do_")) return Object.values(NAMESPACES).map((resource) => ({ resource }));
  if (name === "kv_ops") return ["read", "write", "delete", "list"].map((operation) => ({ resource: "LULU_MCP", operation }));
  return [{ resource: name === "worker" ? "lulu" : "LULU_MCP" }];
}

function scopedRow(name, rows, scope) {
  if (name.startsWith("do_")) return rows.find((row) => NAMESPACES[row.dimensions?.namespaceId] === scope.resource);
  if (name === "kv_ops") return rows.find((row) => row.dimensions?.actionType === scope.operation);
  if (rows.length > 1) throw new Error("unexpected_groups");
  return rows[0];
}

async function collect() {
  if (!process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT) throw new Error("missing_or_wrong_credentials");
  const now = Date.now();
  const day = 86400000;
  const midnight = Math.floor(now / day) * day;
  const output = batch(now);
  for (const [window, [start, end]] of Object.entries({ previous_day: [midnight - day, midnight], trailing_24h: [now - day, now] })) {
    const names = Object.keys(DATASETS);
    const results = await Promise.allSettled(names.map((name) => query(name, start, end)));
    for (const [index, result] of results.entries()) {
      const name = names[index];
      const labels = { window, dataset: name };
      output.add("collection_timestamp", now / 1000, labels);
      output.add("window_start_timestamp", start / 1000, labels);
      output.add("window_end_timestamp", end / 1000, labels);
      if (result.status === "rejected") {
        output.add("collection_success", 0, labels);
        console.error(JSON.stringify({ message: "Cloudflare dataset unavailable", dataset: name, window }));
        continue;
      }
      const points = [];
      try {
        for (const scope of scopes(name)) {
          const row = scopedRow(name, result.value, scope);
          const dimensions = { ...labels, ...scope };
          points.push(["data_present", row === undefined ? 0 : 1, dimensions]);
          if (row === undefined) continue;
          const values = row.sum ?? row.max;
          for (const [key, [metric, scale]] of Object.entries(DATASETS[name].fields)) {
            const value = values?.[key];
            if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("invalid_dataset_value");
            points.push([metric, value * scale, dimensions]);
          }
          if (row.avg !== undefined) {
            const interval = row.avg.sampleInterval;
            if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 1) throw new Error("invalid_sampling");
            points.push(["sample_interval", interval, dimensions]);
          }
        }
        for (const point of points) output.add(...point);
        output.add("collection_success", 1, labels);
        output.add("data_timestamp", now / 1000, labels);
      } catch {
        output.add("collection_success", 0, labels);
        console.error(JSON.stringify({ message: "Cloudflare dataset shape unavailable", dataset: name, window }));
      }
    }
  }
  return output.payload();
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
  const endpoint = process.env.CF_METRICS_ENDPOINT ?? "http://127.0.0.1:9090/api/v1/otlp/v1/metrics";
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
    console.error(JSON.stringify({ message: "Cloudflare collection unavailable" }));
  }
  health.add("credential_authorization_required", needsAuthorization ? 1 : 0);
  health.add("exporter_attempt_timestamp", Date.now() / 1000);
  const body = health.payload();
  body.resourceMetrics.push(...(payload?.resourceMetrics ?? []));
  await push(body);
  console.log(JSON.stringify({ message: "Cloudflare observation exported", sourceAvailable: !failed }));
  if (failed) process.exitCode = needsAuthorization ? 9 : 1;
}

await main().catch(() => {
  console.error(JSON.stringify({ message: "Cloudflare exporter failed" }));
  process.exitCode = 1;
});
