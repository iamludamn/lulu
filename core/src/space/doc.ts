import { defineDoc, defineDocFamily, type Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Tx } from "@earendil-works/pi-durable";
import type { SpaceStatus } from "../protocol/panel.js";
import { STORED_DOC_KINDS } from "../durable-names.js";

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

export async function spaceEntry(harness: Harness, id: string): Promise<Refresh | undefined> {
  return (await harness.snapshot(SpaceRefreshDoc, id, context))?.entry;
}

export async function spaceEntries(harness: Harness, ids?: readonly string[]): Promise<[string, Refresh][]> {
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
