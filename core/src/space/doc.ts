import { defineDoc, defineDocFamily, type Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Tx } from "@earendil-works/pi-durable";
import type { SpaceMonitor, SpaceStatus } from "../protocol/panel.js";
import { STORED_DOC_KINDS } from "../durable-names.js";
import type { Environment } from "../host/types.js";
import { monitorDataProblem, monitorProblem } from "./monitor-contract.js";
import { monitorCredentials, SourceError, stable } from "./source.js";

export type Mode = SpaceStatus["mode"];

export type Finding = { id: string; url: string; title: string; detail?: string; observedAt: number; truncated?: boolean };
export type MonitorRun = { id: string; at: number; startedAt: number; error: string | null; findings: Finding[]; cost: number; credits?: number };
export type Delivery = { id: string; monitor: string; paused: boolean; run?: MonitorRun; reconcile?: boolean };
export type Refresh = {
  generation: string;
  mode: Mode;
  enabled: boolean;
  archived: boolean;
  notify: boolean;
  nextAt: number | null;
  immediatePull?: boolean;
  retryAt: number | null;
  monitor: string | null;
  sealedWebhookSecret?: string;
  providerState: "create" | "active" | "pause" | "paused" | "resume" | "delete" | "deleted" | null;
  startedAt: number;
  checkedAt: number | null;
  updatedAt: number | null;
  error: string | null;
  version: number;
  seen: number;
  delivered: number;
  findings: Finding[];
  value?: string;
  etag?: string;
  modified?: string;
  inbox: Delivery[];
  events?: string[];
  runs: string[];
  changes: string[];
  reconciledAt?: number;
  cost: number;
  credits?: number;
  baselineAt?: number;
  schemaFailure?: string;
  replacement?: SpaceMonitor;
};

export const SpaceRefreshIndex = defineDoc<{ ids: string[]; devices?: string[]; pushRetryAt?: number | null }>({
  kind: STORED_DOC_KINDS.spaceRefreshIndex,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ ids: [] }),
});

export const SpaceRefreshDoc = defineDocFamily<{ entry?: Refresh }, null>({
  kind: STORED_DOC_KINDS.spaceRefresh,
  version: 1,
  scope: "session",
  family: true,
  checkpointWhen: () => false,
  initial: () => ({}),
});

export async function spaceEntry(harness: Pick<Harness, "snapshot">, id: string): Promise<Refresh | undefined> {
  return (await harness.snapshot(SpaceRefreshDoc, id, context))?.entry;
}

export async function spaceEntries(harness: Pick<Harness, "snapshot">, ids?: readonly string[]): Promise<[string, Refresh][]> {
  const requested = ids ?? (await harness.snapshot(SpaceRefreshIndex, context))?.ids ?? [];
  const pairs = await Promise.all(requested.map(async (id) => [id, await spaceEntry(harness, id)] as const));
  return pairs.flatMap(([id, entry]) => entry === undefined ? [] : [[id, entry]]);
}

export async function stopTracking(tx: Tx, id: string): Promise<void> {
  const index = await tx.doc(SpaceRefreshIndex);
  index.ids = index.ids.filter((value) => value !== id);
}

export function spaceStatus(entry: Refresh): SpaceStatus {
  const nextAt = Math.min(entry.nextAt ?? Infinity, entry.retryAt ?? Infinity);
  return {
    mode: entry.mode,
    enabled: entry.enabled,
    checkedAt: entry.checkedAt,
    updatedAt: entry.updatedAt,
    nextAt: entry.mode.kind === "scheduled" && Number.isFinite(nextAt) ? nextAt : null,
    error: entry.error,
    version: entry.version,
    seen: entry.seen,
    notify: entry.notify,
    phase: entry.providerState,
    cost: entry.cost,
    ...(entry.credits !== undefined && { credits: entry.credits }),
  };
}

export async function archiveRefresh(tx: Tx, id: string): Promise<void> {
  const { entry } = await tx.doc(SpaceRefreshDoc, id, null);
  if (entry === undefined) return;
  entry.enabled = false;
  entry.archived = true;
  entry.nextAt = null;
  entry.inbox = [];
  delete entry.replacement;
  if (entry.mode.kind === "subscription") {
    if (entry.providerState !== "deleted") {
      entry.providerState = "delete";
      entry.retryAt = Date.now();
    } else {
      await stopTracking(tx, id);
    }
  } else {
    entry.retryAt = null;
    await stopTracking(tx, id);
  }
}

export function initializeRefresh(mode: Mode, old: Refresh | undefined, notify: boolean, now: number): Refresh {
  return {
    generation: crypto.randomUUID(), mode, notify, enabled: mode.kind !== "manual", archived: false,
    nextAt: mode.kind === "scheduled" ? now : null, retryAt: mode.kind === "subscription" ? now : null,
    ...(mode.kind === "scheduled" && { immediatePull: true }),
    monitor: null, providerState: mode.kind === "subscription" ? "create" : null, startedAt: now,
    checkedAt: null, updatedAt: old?.updatedAt ?? null, error: null,
    version: old?.version ?? 0, seen: old?.seen ?? 0, delivered: old?.delivered ?? 0,
    ...(old?.credits !== undefined && { credits: old.credits }),
    findings: old?.findings ?? [], ...(old?.value !== undefined && { value: old.value }), inbox: [], runs: [], changes: old?.changes ?? [], cost: old?.cost ?? 0,
  };
}

function extractMode(monitor: SpaceMonitor): Mode {
  return { kind: "subscription", provider: "context", goal: monitor.goal, source: { kind: "extract", url: monitor.url, schema: monitor.schema } };
}

export function startExtract(monitor: SpaceMonitor, previous?: Refresh): Refresh {
  const entry = initializeRefresh(extractMode(monitor), previous, monitor.notify === true, Date.now());
  if (entry.value !== undefined && monitorDataProblem(monitor.schema, JSON.parse(entry.value)) !== undefined) delete entry.value;
  return entry;
}

export async function keepMonitoredSpace(tx: Tx, id: string, monitor: SpaceMonitor, env: Environment): Promise<void> {
  const problem = monitorProblem(monitor);
  if (problem !== undefined) throw new SourceError(400, problem);
  monitorCredentials(env, "context");
  const doc = await tx.doc(SpaceRefreshDoc, id, null);
  const previous = doc.entry;
  if (previous?.mode.kind === "subscription" && previous.providerState !== "deleted") {
    if (stable(previous.mode) === stable(extractMode(monitor)) && previous.providerState !== "delete") {
      previous.notify = monitor.notify === true;
      return;
    }
    previous.replacement = monitor;
    previous.providerState = "delete";
    previous.enabled = false;
    previous.retryAt = Date.now();
    previous.inbox = [];
  } else {
    doc.entry = startExtract(monitor, previous);
  }
  const index = await tx.doc(SpaceRefreshIndex);
  if (!index.ids.includes(id)) index.ids.push(id);
}
