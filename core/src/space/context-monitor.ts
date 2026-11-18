import type { Delivery, Finding, MonitorRun } from "./doc.js";
import { https, json, monitorId, providerRequest, record, SourceError, string } from "./source.js";

const encoder = new TextEncoder();
const request = (key: string, path: string, method = "GET", body?: unknown, requestId?: string) =>
  providerRequest("Context.dev", `https://api.context.dev/v1/monitors${path}`, key, method, body, requestId);

const info = (result: Record<string, unknown>) => ({
  id: monitorId(result.id), secret: string(record(result.webhook).secret), status: string(result.status),
  error: string(record(result.last_error).code),
});

export async function contextMonitor(key: string, id: string) {
  return info(await request(key, `/${id}`));
}

export async function findContextMonitor(key: string, tag: string): Promise<string> {
  let cursor = "";
  for (;;) {
    const result = await request(key, "?" + new URLSearchParams({ tags: tag, ...(cursor && { cursor }) }));
    const found = (Array.isArray(result.data) ? result.data : []).map(record).find((item) => Array.isArray(item.tags) && item.tags.includes(tag));
    if (found) return monitorId(found.id);
    cursor = string(result.next_cursor);
    if (!result.has_more || !cursor) return "";
  }
}

export async function createContextMonitor(key: string, tag: string, name: string, url: string, target: { type: "page"; url: string; instructions: string } | { type: "search"; query: string; instructions: string }) {
  return info(await request(key, "", "POST", {
    mode: "web", name, target, tags: [tag], change_detection: { type: "semantic" },
    schedule: { type: "interval", frequency: 1, unit: "days" },
    webhook: { url, events: ["run.completed"], retry: {} },
  }, tag));
}

export async function contextLifecycle(key: string, id: string, action: "pause" | "resume" | "delete"): Promise<void> {
  if (action === "delete") await request(key, `/${id}`, "DELETE");
  else await request(key, `/${id}`, "PATCH", { status: action === "pause" ? "paused" : "active" });
}

export async function sealSecret(secret: string, root: string, generation: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(root);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(generation) }, key, encoder.encode(secret)));
  return btoa(String.fromCharCode(...iv, ...cipher));
}

export async function openSecret(sealed: string, root: string, generation: string): Promise<string> {
  const bytes = Uint8Array.from(atob(sealed), (char) => char.charCodeAt(0));
  const key = await encryptionKey(root);
  return new TextDecoder().decode(await crypto.subtle.decrypt({
    name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(generation),
  }, key, bytes.slice(12)));
}

async function encryptionKey(root: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode("lulu/context/webhook:" + root));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function contextDelivery(request: Request, data: Uint8Array, secret: string): Promise<Delivery> {
  const header = request.headers.get("x-context-signature") ?? "";
  const signature = /^t=(\d{1,12}),\s*v1=([a-f0-9]{64})$/i.exec(header);
  const id = string(request.headers.get("x-context-id"));
  if (!signature || !/^[a-zA-Z0-9_-]{1,150}$/.test(id) || Math.abs(Date.now() / 1000 - Number(signature[1])) > 300) {
    throw new SourceError(401, "Invalid signature");
  }
  const prefix = encoder.encode(signature[1] + ".");
  const signed = new Uint8Array(prefix.length + data.length);
  signed.set(prefix);
  signed.set(data, prefix.length);
  const digest = Uint8Array.from(signature[2].match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("HMAC", key, digest, signed))) throw new SourceError(401, "Invalid signature");
  const event = record(json(data));
  const payload = record(event.data);
  const run = record(payload.run);
  const change = record(payload.change);
  const monitor = monitorId(run.monitor_id);
  if (event.id !== id || event.event !== "run.completed" || request.headers.get("x-context-event") !== event.event || !monitor ||
      (payload.change != null && (change.monitor_id !== monitor || change.run_id !== run.id))) throw new SourceError(400, "Invalid event");
  const parsed = normalizedRun(run, change);
  return { id, monitor, paused: false, ...(parsed ? { run: parsed } : { reconcile: true }) };
}

function normalizedRun(run: Record<string, unknown>, change: Record<string, unknown>): MonitorRun | undefined {
  const rawId = string(run.id);
  const at = Date.parse(string(run.completed_at || run.started_at));
  const startedAt = Date.parse(string(run.started_at));
  if (!/^run_[a-zA-Z0-9_-]{1,100}$/.test(rawId) || !Number.isFinite(at) || !["completed", "failed", "skipped"].includes(string(run.status))) return undefined;
  if (run.change_detected === true && (!string(run.change_id) || run.change_id !== change.id)) return undefined;
  const credits = run.credits_charged;
  return {
    id: `context:${rawId}`, at, startedAt: Number.isFinite(startedAt) ? startedAt : at,
    error: run.status === "completed" ? null : string(record(run.error).code) || string(run.skip_reason) || `Monitor run ${string(run.status)}`,
    findings: run.change_detected === true ? findingsOf(change, at) : [], cost: 0,
    credits: typeof credits === "number" && Number.isSafeInteger(credits) && credits >= 0 ? credits : 0,
  };
}

function findingsOf(change: Record<string, unknown>, at: number): Finding[] {
  const detail = [string(change.summary), string(change.diff)].filter(Boolean).join("\n\n");
  const urls = new Set([https(change.url)?.href, ...(Array.isArray(change.matched_urls) ? change.matched_urls.map((url) => https(url)?.href) : [])]);
  return [...urls].filter((url) => url !== undefined).slice(0, 20).map((url, index) => ({
    id: `context:${string(change.id)}:${index}`, url, title: string(change.title).slice(0, 300) || new URL(url).hostname,
    observedAt: at, ...(detail && { detail: detail.slice(0, 1800) }), ...(detail.length > 1800 && { truncated: true }),
  }));
}

export async function contextRuns(key: string, monitor: string, cursor: string, since: number): Promise<{ runs: MonitorRun[]; cursor: string }> {
  const response = await request(key, `/${monitor}/runs?` + new URLSearchParams({ limit: "5", ...(cursor && { cursor }) }));
  const runs: MonitorRun[] = [];
  let older = false;
  for (const raw of Array.isArray(response.data) ? response.data : []) {
    const run = record(raw);
    const at = Date.parse(string(run.completed_at || run.started_at));
    if (run.monitor_id !== monitor || !Number.isFinite(at)) continue;
    if (at < since) { older = true; continue; }
    const changeId = string(run.change_id);
    const change = run.change_detected === true && /^chg_[a-zA-Z0-9_-]{1,100}$/.test(changeId) ?
      await request(key, `/changes/${changeId}`) : {};
    if (change.id && (change.monitor_id !== monitor || change.run_id !== run.id)) throw new SourceError(502, "Unexpected Context.dev change");
    const parsed = normalizedRun(run, change);
    if (parsed) runs.push(parsed);
  }
  return { runs, cursor: response.has_more && !older ? string(response.next_cursor) : "" };
}
