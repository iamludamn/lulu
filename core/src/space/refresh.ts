import { contextDelivery, contextLifecycle, contextMonitor, contextRuns, createContextMonitor, findContextMonitor, openSecret, sealSecret } from "./context-monitor.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Harness, Tx } from "@earendil-works/pi-durable";
import { GRACE_MS, nextDailyAfter, utcDailyCron } from "../cron/schedule.js";
import type { Environment } from "../host/types.js";
import { PanelDoc } from "../panel.js";
import { SPACE_ID, type MonitorProvider, type PanelState, type SpaceMonitor } from "../protocol/panel.js";
import { monitorDataProblem } from "./monitor-contract.js";
import { SpaceRefreshDoc, SpaceRefreshIndex, spaceEntries, spaceEntry, spaceStatus, startExtract, stopTracking, initializeRefresh, type Mode, type MonitorRun, type Refresh } from "./doc.js";
import { bytes, DAY, monitorCredentials, monitorProviders, stable, deliveryOf, json, modeOf, monitorId, monitorRun, provider, pull, record, signed, signingSecret, SourceError, string } from "./source.js";

const RETRY = 5 * 60_000;
const MAX_INBOX = 24;
const HISTORY = 100;
const LEDGER = 4096;
const visible = (kind?: string): boolean => kind === "space" || kind === "web";
const has = (value: object, key: string): boolean => Object.hasOwn(value, key);
const kept = async (tx: Tx, id: string): Promise<boolean> => {
  const panel = await tx.doc(PanelDoc);
  return has(panel.widgets, id) && visible(panel.widgets[id]?.body.kind);
};
const deadline = (entry: Refresh, local?: (entry: Refresh) => boolean): number =>
  Math.min(local?.(entry) === false ? Infinity : entry.nextAt ?? Infinity, entry.retryAt ?? Infinity);
const next = (mode: Mode, now: number): number | null => mode.kind === "scheduled" ? nextDailyAfter(mode.time, mode.tz, now) : null;

function addRun(entry: Refresh, run: MonitorRun): boolean {
  if (entry.runs.includes(run.id)) return false;
  entry.runs = [...entry.runs, run.id].slice(-LEDGER);
  entry.cost += run.cost;
  if (run.credits !== undefined) entry.credits = (entry.credits ?? 0) + run.credits;
  if (entry.checkedAt === null || run.at >= entry.checkedAt) {
    entry.checkedAt = run.at;
    entry.error = run.error;
  }
  const known = new Set([...entry.changes, ...entry.findings.map((item) => item.id)]);
  const added = run.findings.filter((item) => {
    if (known.has(item.id)) return false;
    known.add(item.id);
    return true;
  });
  entry.changes = Array.from(known).slice(-LEDGER);
  if (added.length === 0) return false;
  const retained = [...entry.findings, ...added].sort((a, b) => b.observedAt - a.observedAt).slice(0, HISTORY);
  if (retained.every((item, i) => item.id === entry.findings[i]?.id)) return false;
  entry.findings = retained;
  return true;
}

function changed(entry: Refresh, now: number): void {
  entry.updatedAt = now;
  entry.version += 1;
}

async function apply(
  harness: Harness, id: string, expected: Refresh, callback: (entry: Refresh, tx: Tx) => void | Promise<void>,
): Promise<boolean> {
  return harness.commit(async (tx) => {
    const { entry } = await tx.doc(SpaceRefreshDoc, id, null);
    if (!entry || entry.generation !== expected.generation || entry.providerState !== expected.providerState || entry.enabled !== expected.enabled || entry.archived !== expected.archived) return false;
    await callback(entry, tx);
    return true;
  }, context);
}

const providerOf = (mode: Mode): MonitorProvider => mode.kind === "subscription" ? mode.provider ?? "perplexity" : "perplexity";

export async function receiveSpaceEvent(harness: Harness, request: Request, env: Environment): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("space") ?? "";
  const generation = searchParams.get("generation") ?? "";
  if (!SPACE_ID.test(id)) throw new SourceError(404, "Unknown subscription");
  const entry = await spaceEntry(harness, id);
  if (entry?.mode.kind !== "subscription" || entry.generation !== generation) throw new SourceError(404, "Unknown subscription");
  const name = searchParams.get("provider") === "context" ? "context" : "perplexity";
  if (providerOf(entry.mode) !== name) throw new SourceError(404, "Unknown subscription");
  const { root } = monitorCredentials(env, name);
  const data = await bytes(request);
  const delivery = name === "context" ? await contextEvent(request, data, entry, root) : await perplexityEvent(request, data, root, generation);
  if (delivery === null) return new Response(null, { status: 204 });
  const deliveryId = delivery.id;
  await harness.commit(async (tx) => {
    const { entry: current } = await tx.doc(SpaceRefreshDoc, id, null);
    if (!current || current.generation !== generation || !current.enabled || !(await kept(tx, id))) return;
    if (current.monitor !== null && current.monitor !== delivery.monitor) throw new SourceError(404, "Unknown monitor");
    if (current.events?.includes(deliveryId) || current.inbox.some((item) => item.id === deliveryId)) return;
    if (current.inbox.length >= MAX_INBOX) throw new SourceError(503, "Inbox full");
    current.inbox.push(delivery);
    current.retryAt = Date.now();
  }, context);
  return new Response(null, { status: 204 });
}

async function contextEvent(request: Request, data: Uint8Array, entry: Refresh, root: string) {
  if (!entry.sealedWebhookSecret) throw new SourceError(503, "Subscription is still being connected");
  return contextDelivery(request, data, await openSecret(entry.sealedWebhookSecret, root, entry.generation));
}

async function perplexityEvent(request: Request, data: Uint8Array, root: string, generation: string) {
  const deliveryId = await signed(request, data, await signingSecret(root, generation));
  if (!deliveryId) throw new SourceError(401, "Invalid signature");
  return deliveryOf(json(data), deliveryId);
}

export async function handleSpaceRefresh(harness: Harness, request: Request, env: Environment): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  if (!SPACE_ID.test(id)) throw new SourceError(400, "Invalid Space ID");
  if (request.method === "GET") {
    return spaceRefreshResponse(id, await harness.snapshot(PanelDoc, context), await spaceEntry(harness, id), env);
  }
  const input = record(json(await bytes(request)));
  if (request.method === "POST" && input.action === "configure") {
    await harness.commit(async (tx) => {
      if (!(await kept(tx, id))) throw new SourceError(404, "Space not kept");
      const doc = await tx.doc(SpaceRefreshDoc, id, null);
      const previous = doc.entry;
      if (previous?.mode.kind === "subscription" && previous.mode.source.kind === "extract" && input.mode === undefined) {
        previous.notify = input.notify === true;
        return;
      }
      const mode = modeOf(input.mode, env.LULU_SPACE_PULL_HOSTS);
      if (mode.kind === "subscription") {
        const name = mode.provider ?? (previous?.mode.kind === "subscription" && previous.providerState !== "deleted" ? providerOf(previous.mode) : env.PERPLEXITY_API_KEY ? "perplexity" : "context");
        monitorCredentials(env, name);
        if (name === "context" && mode.source.kind === "page" && mode.source.urls.length !== 1) {
          throw new SourceError(400, "Context.dev monitors one page per subscription");
        }
        if (name === "context" || previous?.mode.kind !== "subscription" || previous.mode.provider !== undefined) mode.provider = name;
        else delete mode.provider;
      }
      if (previous?.mode.kind === "subscription" && previous.providerState !== "deleted") {
        if (mode.kind !== "subscription" || providerOf(previous.mode) !== providerOf(mode) ||
            JSON.stringify(previous.mode.source) !== JSON.stringify(mode.source) || previous.mode.goal !== mode.goal) throw new SourceError(409, "Remove the current subscription before changing its source");
        previous.notify = input.notify === true;
        return;
      }
      if (previous && !previous.archived && JSON.stringify(previous.mode) === JSON.stringify(mode)) {
        previous.notify = input.notify === true;
        return;
      }
      doc.entry = initializeRefresh(mode, previous, input.notify === true, Date.now());
      const index = await tx.doc(SpaceRefreshIndex);
      if (mode.kind === "manual") index.ids = index.ids.filter((value) => value !== id);
      else if (!index.ids.includes(id)) index.ids.push(id);
    }, context);
  } else if (request.method === "POST") {
    await harness.commit(async (tx) => {
      if (!(await kept(tx, id))) throw new SourceError(404, "Space not kept");
      const { entry } = await tx.doc(SpaceRefreshDoc, id, null);
      if (!entry) throw new SourceError(404, "Refresh not configured");
      const now = Date.now();
      switch (input.action) {
        case "seen": {
          const version = input.version;
          if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0 || version > entry.version) throw new SourceError(400, "Invalid data version");
          entry.seen = Math.max(entry.seen, version);
          break;
        }
        case "refresh":
          if (entry.mode.kind !== "scheduled") throw new SourceError(409, "Source has no pull schedule");
          if (entry.enabled) {
            entry.nextAt = now;
            entry.retryAt = null;
            entry.immediatePull = true;
          }
          break;
        case "pause":
        case "resume":
        case "remove": {
          if (input.action === "remove") delete entry.replacement;
          if (entry.mode.kind === "manual" || entry.providerState === "delete" || entry.providerState === "deleted") break;
          const enabled = input.action === "resume";
          if (input.action !== "remove" && entry.enabled === enabled) break;
          entry.enabled = enabled;
          entry.archived = false;
          entry.nextAt = enabled ? next(entry.mode, now) : null;
          delete entry.immediatePull;
          entry.inbox = [];
          if (entry.mode.kind === "subscription") {
            entry.providerState = input.action === "remove" ? "delete" : enabled ? entry.monitor === null ? "create" : "resume" : "pause";
            entry.retryAt = now;
          } else {
            entry.retryAt = null;
            if (input.action === "remove") {
              entry.mode = { kind: "manual" };
              await stopTracking(tx, id);
            }
          }
          break;
        }
        default: throw new SourceError(400, "Unknown refresh action");
      }
    }, context);
  } else {
    throw new SourceError(405, "Method not allowed");
  }
  return new Response(null, { status: 204 });
}

export function spaceRefreshResponse(id: string, panel: PanelState | undefined, entry: Refresh | undefined, env: Environment): Response {
  if (!SPACE_ID.test(id)) throw new SourceError(400, "Invalid Space ID");
  if (!panel || !has(panel.widgets, id) || !visible(panel.widgets[id]?.body.kind)) throw new SourceError(404, "Space not kept");
  const data = entry === undefined ? null : { version: entry.version, updatedAt: entry.updatedAt, findings: entry.findings, value: entry.value === undefined ? undefined : json(new TextEncoder().encode(entry.value)) };
  return Response.json({ status: entry === undefined ? null : spaceStatus(entry), data, providers: monitorProviders(env) }, { headers: { "Cache-Control": "no-store" } });
}

export function calendarPull(entry: Refresh, at: number): boolean {
  return entry.enabled && !entry.immediatePull && entry.mode.kind === "scheduled" && nextDailyAfter(entry.mode.time, entry.mode.tz, at - 1) === at;
}

export function spaceCronDue(entry: Refresh, cron: string, at: number, now: number): boolean {
  return at <= now && now - at <= GRACE_MS && cron === utcDailyCron(at) &&
    entry.nextAt !== null && entry.nextAt <= at && calendarPull(entry, at);
}

export async function nextSpaceAlarm(harness: Harness, local?: (entry: Refresh) => boolean): Promise<number | undefined> {
  const entries = await spaceEntries(harness);
  const at = Math.min(...entries.map(([, entry]) => deadline(entry, local)));
  return Number.isFinite(at) ? at : undefined;
}

async function runPull(harness: Harness, id: string, entry: Refresh, env: Environment): Promise<void> {
  if (entry.mode.kind !== "scheduled" || !entry.enabled) return;
  const result = await pull(entry.mode, entry, env.LULU_SPACE_PULL_HOSTS);
  const now = Date.now();
  await apply(harness, id, entry, (current) => {
    if (current.nextAt !== entry.nextAt || current.retryAt !== entry.retryAt) return;
    if (has(result, "value")) {
      if (current.value === undefined) {
        current.updatedAt = now;
      } else if (stable(result.value) !== current.value) {
        changed(current, now);
      }
      current.value = stable(result.value);
      if (result.etag !== undefined) current.etag = result.etag;
      else delete current.etag;
      if (result.modified !== undefined) current.modified = result.modified;
      else delete current.modified;
    }
    current.checkedAt = now;
    current.error = null;
    current.nextAt = next(current.mode, now);
    delete current.immediatePull;
    current.retryAt = null;
  });
}

async function connectMonitor(entry: Refresh, id: string, env: Environment): Promise<{ id: string; sealed?: string }> {
  if (entry.mode.kind !== "subscription") throw new Error("No monitor source");
  const name = providerOf(entry.mode);
  const { key, root, callback } = monitorCredentials(env, name);
  callback.pathname = "/api/webhooks/" + name;
  callback.search = new URLSearchParams({ space: id, generation: entry.generation }).toString();
  if (name === "context") {
    const tag = "lulu-" + entry.generation;
    const existing = await findContextMonitor(key, tag);
    if (entry.providerState !== "create") return { id: existing };
    const source = entry.mode.source;
    const instructions = entry.mode.goal;
    const target = source.kind === "extract" ? { type: "extract" as const, url: source.url, schema: source.schema, instructions, max_pages: 1 as const, max_depth: 0 as const } :
      source.kind === "search" ? { type: "search" as const, query: source.query, instructions } :
      { type: "page" as const, url: source.urls[0], instructions };
    const result = existing ? await contextMonitor(key, existing) : await createContextMonitor(key, tag, `Lulu Space ${id}`, callback.href, target);
    if (!result.id || !result.secret) throw new SourceError(502, "Context.dev did not return the monitor ID and signing secret");
    return { id: result.id, sealed: await sealSecret(result.secret, root, entry.generation) };
  }
  if (entry.mode.source.kind === "extract") throw new SourceError(400, "Structured monitors require Context.dev");
  const match = async (): Promise<string> => {
    let after = "";
    for (;;) {
      const result = await provider(key, "?" + new URLSearchParams({ limit: "100", ...(after && { after }) }));
      const monitors: unknown[] = Array.isArray(result.data) ? result.data : [];
      for (const item of monitors) {
        const monitor = record(item);
        if (record(monitor.metadata).lulu_generation === entry.generation) return monitorId(monitor.id);
      }
      after = monitorId(record(monitors.at(-1)).id);
      if (!result.has_more || !after) return "";
    }
  };
  const existing = await match();
  if (existing || entry.providerState !== "create") return { id: existing };
  const source = entry.mode.source;
  const targets = source.kind === "search" ? [{ type: "search", query: source.query, max_results: 5 }] :
    source.urls.map((url) => ({ type: "page", url }));
  const result = await provider(key, "", "POST", {
    name: `Lulu Space ${id}`, goal: entry.mode.goal, targets, schedule: { type: "interval", interval: "1d" },
    metadata: { lulu_generation: entry.generation },
    webhook: { url: callback.href, secret: `whsec_${await signingSecret(root, entry.generation)}`, events: ["monitor.run.completed", "monitor.paused"] },
  }, entry.generation);
  const monitor = monitorId(result.id);
  if (!monitor) throw new Error("Monitor returned an invalid ID");
  return { id: monitor };
}

async function drain(harness: Harness, id: string, entry: Refresh): Promise<void> {
  const ids = new Set(entry.inbox.map((item) => item.id));
  await apply(harness, id, entry, (current) => {
    let updated = false;
    let paused = false;
    for (const item of current.inbox) {
      if (!ids.has(item.id) || item.monitor !== current.monitor) continue;
      if (item.run && item.run.startedAt >= Math.floor(current.startedAt / 1000) * 1000) updated = addRun(current, item.run) || updated;
      paused ||= item.paused || item.reconcile === true;
    }
    current.inbox = current.inbox.filter((item) => !ids.has(item.id));
    current.events = [...(current.events ?? []), ...ids].slice(-LEDGER);
    if (updated) changed(current, Date.now());
    current.retryAt = current.inbox.length > 0 ? Date.now() : current.reconciledAt ? current.reconciledAt + DAY : Date.now();
    if (paused) {
      delete current.reconciledAt;
      current.retryAt = Date.now();
    }
  });
}

async function reconcile(harness: Harness, id: string, entry: Refresh, key: string, name: MonitorProvider): Promise<void> {
  if (!entry.monitor) throw new SourceError(503, "Monitor is not connected");
  const until = Date.now();
  const since = Math.max(Math.floor(entry.startedAt / 1000) * 1000, (entry.reconciledAt ?? entry.startedAt) - DAY);
  const info = name === "context" ? await contextMonitor(key, entry.monitor) : await provider(key, "/" + entry.monitor);
  let cursor = "";
  for (;;) {
    const page = name === "context" ? await contextRuns(key, entry.monitor, cursor, since) : await perplexityRuns(key, entry.monitor, cursor, since);
    if (!(await apply(harness, id, entry, (current) => {
      let updated = false;
      for (const run of page.runs) {
        if (run.at >= since && run.startedAt >= Math.floor(current.startedAt / 1000) * 1000) updated = addRun(current, run) || updated;
      }
      if (updated) changed(current, until);
    }))) return;
    if (!page.cursor) break;
    if (page.cursor === cursor) throw new SourceError(502, "Monitor API repeated a pagination cursor");
    cursor = page.cursor;
  }
  await apply(harness, id, entry, (current) => {
    current.reconciledAt = until;
    if (info.status === "paused") {
      current.enabled = false;
      current.providerState = "paused";
      const reason = record(info).pause_reason ?? record(info).error;
      current.error = `Monitor paused (${typeof reason === "string" && reason ? reason : "provider"})`;
      current.retryAt = null;
    } else {
      current.retryAt = current.inbox.length > 0 ? Date.now() : until + DAY;
    }
  });
}

async function perplexityRuns(key: string, monitor: string, after: string, since: number) {
  const page = await provider(key, `/${monitor}/runs?` + new URLSearchParams({ limit: "5", ...(after && { after }) }));
  const items: unknown[] = Array.isArray(page.data) ? page.data : [];
  const runs = items.map(monitorRun).filter((run) => run !== undefined);
  const last = record(items.at(-1)).id;
  const cursor = page.has_more && typeof last === "string" && /^run_[a-zA-Z0-9_]+$/.test(last) && !runs.some((run) => run.at < since) ? last : "";
  return { runs, cursor };
}

export type SpaceRepair = (tx: Tx, id: string, failure: { generation: string; capturedAt: number; problem: string; schema: SpaceMonitor["schema"]; sample: string }) => Promise<void>;

async function refreshExtract(harness: Harness, id: string, entry: Refresh, schema: SpaceMonitor["schema"], key: string, repair?: SpaceRepair): Promise<void> {
  if (!entry.monitor) throw new SourceError(503, "Monitor is not connected");
  const info = await contextMonitor(key, entry.monitor);
  const capturedAt = Date.parse(string(info.baseline.captured_at));
  const sample = info.baseline.data;
  const received = new Set(entry.inbox.map(({ id: event }) => event));
  const now = Date.now();
  await apply(harness, id, entry, async (current, tx) => {
    const fresh = info.status !== "paused" && sample !== undefined && Number.isFinite(capturedAt) && capturedAt > (current.baselineAt ?? 0);
    const problem = fresh ? monitorDataProblem(schema, sample) : undefined;
    if (problem !== undefined && current.schemaFailure !== problem && repair !== undefined && await kept(tx, id)) {
      await repair(tx, id, { generation: current.generation, capturedAt, problem, schema, sample: JSON.stringify(sample).slice(0, 6000) });
      current.schemaFailure = problem;
    }
    current.inbox = current.inbox.filter(({ id: event }) => !received.has(event));
    current.events = [...(current.events ?? []), ...received].slice(-LEDGER);
    current.checkedAt = now;
    if (info.status === "paused") {
      current.enabled = false;
      current.providerState = "paused";
      current.retryAt = null;
      current.error = "Monitor paused";
      return;
    }
    current.retryAt = current.inbox.length > 0 ? now : sample === undefined ? now + RETRY : now + DAY;
    if (info.error) current.error = info.error;
    if (!fresh) return;
    if (problem !== undefined) {
      current.error = problem;
    } else {
      const value = stable(sample);
      if (current.value === undefined) current.updatedAt = now;
      else if (value !== current.value) changed(current, now);
      current.value = value;
      current.error = null;
      delete current.schemaFailure;
    }
    current.baselineAt = capturedAt;
  });
}

async function runMonitor(harness: Harness, id: string, entry: Refresh, env: Environment, repair?: SpaceRepair): Promise<void> {
  const name = providerOf(entry.mode);
  const { key, root } = monitorCredentials(env, name);
  const state = entry.providerState;
  if (state === "active" && entry.mode.kind === "subscription" && entry.mode.source.kind === "extract") {
    return refreshExtract(harness, id, entry, entry.mode.source.schema, key, repair);
  }
  if (state === "active" && entry.inbox.length > 0) return drain(harness, id, entry);
  if (state === "active") return reconcile(harness, id, entry, key, name);
  if (state === "create") {
    const monitor = await connectMonitor(entry, id, env);
    await apply(harness, id, entry, (current) => {
      current.monitor = monitor.id;
      if (monitor.sealed) current.sealedWebhookSecret = monitor.sealed;
      current.providerState = "active";
      current.retryAt = Date.now();
      current.error = null;
    });
    return;
  }
  if (state !== "pause" && state !== "resume" && state !== "delete") return;
  const startedAt = Date.now();
  const monitor = entry.monitor ?? (await connectMonitor(entry, id, env)).id;
  let sealed: string | undefined;
  if (name === "context" && state === "resume" && monitor && !entry.sealedWebhookSecret) {
    const result = await contextMonitor(key, monitor);
    if (!result.secret) throw new SourceError(502, "Context.dev did not return the signing secret");
    sealed = await sealSecret(result.secret, root, entry.generation);
  }
  if (monitor) {
    try {
      if (name === "context") await contextLifecycle(key, monitor, state);
      else await provider(key, state === "delete" ? `/${monitor}` : `/${monitor}/${state}`, state === "delete" ? "DELETE" : "POST");
    } catch (error) {
      if (!(error instanceof SourceError && (error.status === 404 && state === "delete" || error.status === 409 && state !== "delete" &&
        (name === "context" ? await contextMonitor(key, monitor) : await provider(key, `/${monitor}`)).status === (state === "pause" ? "paused" : "active")))) throw error;
    }
  }
  await apply(harness, id, entry, async (current, tx) => {
    current.monitor = monitor || null;
    current.providerState = state === "delete" ? "deleted" : state === "pause" ? "paused" : "active";
    current.retryAt = state === "resume" ? Date.now() : null;
    current.error = null;
    if (state === "resume") {
      current.startedAt = startedAt;
      if (sealed) current.sealedWebhookSecret = sealed;
    }
    if (state === "delete") {
      if (current.replacement !== undefined) {
        (await tx.doc(SpaceRefreshDoc, id, null)).entry = startExtract(current.replacement, current);
        return;
      }
      delete current.sealedWebhookSecret;
      await stopTracking(tx, id);
    }
  });
}

export async function refreshDueSpaces(harness: Harness, env: Environment, now: number, local?: (entry: Refresh) => boolean, cron?: { rule: string; at: number }, repair?: SpaceRepair): Promise<void> {
  const entries = (await spaceEntries(harness)).filter(([, entry]) =>
    cron === undefined ? deadline(entry, local) <= now : spaceCronDue(entry, cron.rule, cron.at, now));
  const refresh = async ([id, entry]: [string, Refresh]): Promise<void> => {
    try {
      if (entry.mode.kind === "scheduled") await runPull(harness, id, entry, env);
      if (entry.mode.kind === "subscription") await runMonitor(harness, id, entry, env, repair);
    } catch (error) {
      await apply(harness, id, entry, (current) => {
        const failedAt = Date.now();
        if (entry.mode.kind === "scheduled") {
          if (current.nextAt !== entry.nextAt || current.retryAt !== entry.retryAt) return;
          current.nextAt = next(current.mode, failedAt);
          delete current.immediatePull;
          current.retryAt = entry.retryAt === null ? failedAt + RETRY : null;
        } else {
          current.retryAt = failedAt + RETRY;
        }
        current.error = error instanceof SourceError ? error.message : "Refresh failed";
      });
    }
  };
  for (let start = 0; start < entries.length; start += 4) {
    await Promise.all(entries.slice(start, start + 4).map(refresh));
    if (cron === undefined) break;
  }
}

export function spaceError(error: unknown): Response {
  if (error instanceof SourceError) return Response.json({ error: error.message }, { status: error.status >= 400 && error.status < 600 ? error.status : 502 });
  console.error("Space refresh failed", error);
  return Response.json({ error: "Space refresh unavailable" }, { status: 503 });
}
