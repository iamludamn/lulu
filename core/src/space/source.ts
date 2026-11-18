import { Parser } from "htmlparser2";
import type { Delivery, Finding, Mode, MonitorRun, Refresh } from "./doc.js";
import { validTime, validTimeZone } from "../cron/schedule.js";

export const DAY = 86_400_000;
const MAX_BODY = 512 * 1024;
const NORMALIZED_LIMIT = 64 * 1024;
const encoder = new TextEncoder();

export class SourceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const string = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const at = (value: unknown): number => Date.parse(string(value));
const id = (value: unknown, prefix: string): string => {
  const text = string(value);
  return text.startsWith(prefix) && /^[a-zA-Z0-9_]+$/.test(text) && text.length <= 100 ? text : "";
};

export async function bytes(message: Request | Response, limit = MAX_BODY): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(message.headers.get("content-length")) > limit) throw new SourceError(413, "Content too large");
  const reader = message.body?.getReader();
  const data = new Uint8Array(limit);
  let size = 0;
  if (reader !== undefined) {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (size + chunk.value.length > limit) {
          await reader.cancel();
          throw new SourceError(413, "Content too large");
        }
        data.set(chunk.value, size);
        size += chunk.value.length;
      }
    } finally {
      reader.releaseLock();
    }
  }
  return data.subarray(0, size);
}

export function json(data: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); }
  catch { throw new SourceError(400, "Invalid JSON"); }
}

export function https(value: unknown): URL | null {
  const address = string(value);
  if (address.length > 2048) return null;
  try {
    const url = new URL(address);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname) && !/^[\d.]+$/.test(url.hostname) ? url : null;
  } catch { return null; }
}

export function modeOf(input: unknown, hosts: string | undefined): Mode {
  const value = record(input);
  if (value.kind === "manual") return { kind: "manual" };
  if (value.kind === "scheduled") {
    const url = https(value.url);
    const allowed = hosts?.split(",").map((host) => host.trim().toLowerCase()) ?? [];
    const time = string(value.time);
    const tz = string(value.tz);
    if (url === null || !allowed.includes(url.hostname)) throw new SourceError(400, "Use an HTTPS URL on a configured Space data host");
    if (!validTime(time) || tz.length > 100 || !validTimeZone(tz)) throw new SourceError(400, "Invalid schedule");
    return { kind: "scheduled", url: url.href, time, tz };
  }
  if (value.kind === "subscription") {
    const goal = string(value.goal);
    const source = record(value.source);
    if (!goal || goal.length > 1000) throw new SourceError(400, "A monitoring goal is required");
    if (source.kind === "search") {
      const query = string(source.query);
      if (query.length > 0 && query.length <= 500) return { kind: "subscription", goal, source: { kind: "search", query } };
    }
    if (source.kind === "page" && Array.isArray(source.urls) && source.urls.length > 0 && source.urls.length <= 10) {
      const urls = source.urls.map(https);
      if (urls.every((url) => url !== null)) return { kind: "subscription", goal, source: { kind: "page", urls: [...new Set(urls.map((url) => url.href))] } };
    }
  }
  throw new SourceError(400, "Invalid refresh mode or monitoring target");
}

function pageText(html: string): string {
  const hiddenTags = new Set(["script", "style", "noscript", "head", "template", "svg", "nav", "footer", "aside"]);
  const boundaries = new Set(["article", "br", "div", "h1", "h2", "h3", "li", "main", "p", "section", "td"]);
  const parts: string[] = [];
  let hidden = 0;
  const parser = new Parser({
    onopentag(name) {
      if (hiddenTags.has(name)) hidden++;
      if (!hidden && boundaries.has(name)) parts.push(" ");
    },
    ontext(text) { if (!hidden) parts.push(text); },
    onclosetag(name) {
      if (hiddenTags.has(name)) hidden--;
      if (!hidden && boundaries.has(name)) parts.push(" ");
    },
  });
  parser.end(html);
  return parts.join("").replace(/\s+/g, " ").trim();
}

export async function pull(mode: Extract<Mode, { kind: "scheduled" }>, entry: Refresh, hosts: string | undefined): Promise<{ modified?: string; etag?: string; value?: unknown }> {
  modeOf(mode, hosts);
  const headers = new Headers({ Accept: "application/json, text/html;q=0.9, text/plain;q=0.8" });
  if (entry.etag) headers.set("If-None-Match", entry.etag);
  if (entry.modified) headers.set("If-Modified-Since", entry.modified);
  const response = await fetch(mode.url, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (response.status === 304) return {};
  if (!response.ok) throw new SourceError(response.status, `Source returned ${response.status}`);
  const data = await bytes(response);
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type !== "text/html" && type !== "text/plain" && type !== "application/json" && !type.endsWith("+json")) {
    throw new SourceError(422, "The source must respond with JSON, HTML or plain text");
  }
  const text = new TextDecoder().decode(data);
  const value = type === "text/html" ? pageText(text) : type === "text/plain" ? text.trim() : json(data);
  if (typeof value === "string" && value.length === 0) throw new SourceError(422, "No readable content in source");
  if (encoder.encode(JSON.stringify(value)).length > NORMALIZED_LIMIT) throw new SourceError(413, "Source data is too large");
  return { value, etag: response.headers.get("etag") ?? undefined, modified: response.headers.get("last-modified") ?? undefined };
}

export async function signingSecret(root: string, generation: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(root), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(generation)));
  return btoa(String.fromCharCode(...derived));
}

export async function signed(request: Request, data: Uint8Array, secret: string): Promise<string> {
  const delivery = id(request.headers.get("webhook-id"), "evt_");
  const rawTime = request.headers.get("webhook-timestamp") ?? "";
  if (!delivery || !/^\d{10,12}$/.test(rawTime) || Math.abs(Date.now() - Number(rawTime) * 1000) > 300_000) return "";
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(secret), (char) => char.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const prefix = encoder.encode(`${delivery}.${rawTime}.`);
  const input = new Uint8Array(prefix.length + data.length);
  input.set(prefix);
  input.set(data, prefix.length);
  for (const value of (request.headers.get("webhook-signature") ?? "").slice(0, 1024).split(" ")) {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(value)) continue;
    if (await crypto.subtle.verify("HMAC", key, Uint8Array.from(atob(value.slice(3)), (char) => char.charCodeAt(0)), input)) return delivery;
  }
  return "";
}

export function monitorRun(raw: unknown): MonitorRun | undefined {
  const run = record(raw);
  const runId = id(run.id, "run_");
  const observedAt = at(run.finished_at || run.created_at);
  if (!runId || !Number.isFinite(observedAt) || !["succeeded", "failed", "skipped"].includes(string(run.status))) return undefined;
  const findings: Finding[] = [];
  for (const raw of Array.isArray(run.changes) ? run.changes : []) {
    const change = record(raw);
    const changeId = id(change.id, "chg_");
    const address = https(change.url);
    if (!changeId || address === null) continue;
    const diff = record(change.diff);
    const detail = string(change.snippet ?? diff.unified).slice(0, 1800);
    findings.push({ id: changeId, url: address.href, title: string(change.title).slice(0, 300) || address.hostname, observedAt, ...(detail && { detail }), ...((diff.truncated === true || string(diff.unified).length > 1800) && { truncated: true }) });
  }
  const cost = record(record(run.usage).cost).total_cost;
  const partial = Array.isArray(run.target_errors) && run.target_errors.length > 0;
  const error = run.status === "succeeded" ? partial ? "Some sources could not be checked" : null : `Monitor run ${String(run.status)}`;
  return { id: runId, at: observedAt, startedAt: Number.isFinite(at(run.created_at)) ? at(run.created_at) : observedAt, error, findings, cost: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : 0 };
}

export function deliveryOf(raw: unknown, deliveryId: string): Delivery | null {
  const body = record(raw);
  const data = record(body.data);
  const monitor = id(record(data.monitor).id, "mon_");
  const paused = body.type === "monitor.paused";
  if (body.id !== deliveryId || !monitor || !["monitor.paused", "monitor.changes.detected", "monitor.run.completed", "monitor.webhook.test"].includes(string(body.type))) throw new SourceError(400, "Invalid event");
  if (body.type === "monitor.webhook.test") return null;
  const run = monitorRun(data.run);
  if (!paused && run === undefined) throw new SourceError(400, "Invalid run");
  return { id: deliveryId, monitor, paused, ...(run !== undefined && { run }) };
}

export async function provider(key: string, path: string, method = "GET", body?: unknown, requestId?: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.perplexity.ai/v1/monitors${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(requestId === undefined ? {} : { "Idempotency-Key": requestId }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new SourceError(response.status, `Perplexity returned ${response.status}`);
  return record(json(await bytes(response, 2 * 1024 * 1024)));
}

export const monitorId = (value: unknown): string => id(value, "mon_");
