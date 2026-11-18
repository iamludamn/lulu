import { defineDoc, GenerationTask, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { SANDBOX_LEASE_MS } from "./doc.js";
import type { SandboxRef } from "./provider.js";

export const ACCOUNTING_WINDOW_MS = 7 * 86_400_000;
const MAX_HISTORY = 4096;
const PRUNE_INTERVAL_MS = 3_600_000;

type SandboxKind = "startup" | "ready" | "unknown";
export type Period =
  | { kind: SandboxKind; resource: string; backend: string; start: number; end: number }
  | { kind: "agent" | "agentUnknown"; task: string; delegate: boolean; start: number; end: number }
  | { kind: "association"; task: string; resource: string; start: number; end: number };

type Resource = {
  id: string;
  backend: string;
  kind: SandboxKind;
  start: number;
  confirmed: number;
  validUntil: number;
  stopping?: true;
};

export type SandboxAccounting = {
  since: number;
  lastObservedAt?: number;
  history: Period[];
  resources: Record<string, Resource>;
  agents: Record<string, { delegate: boolean; start: number; observed: number }>;
  links: Record<string, { resource: string; start: number }>;
};

export const SandboxAccountingDoc = defineDoc<SandboxAccounting>({
  kind: "lulu.sandbox.accounting",
  scope: "session",
  version: 1,
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 1024,
  initial: () => ({ since: 0, history: [], resources: {}, agents: {}, links: {} }),
});

export async function accounting(tx: Tx, at: number): Promise<SandboxAccounting> {
  const state = await tx.doc(SandboxAccountingDoc);
  const cutoff = at - ACCOUNTING_WINDOW_MS;
  if (!state.since) state.since = at;
  else if (cutoff - state.since >= PRUNE_INTERVAL_MS) {
    state.since = cutoff;
    state.history = state.history.filter(({ end }) => end > cutoff);
  }
  return state;
}

export function remember(state: SandboxAccounting, period: Period): void {
  if (period.end <= Math.max(period.start, state.since)) return;
  state.history.push(period);
  if (state.history.length > MAX_HISTORY) {
    const dropped = state.history.shift()!;
    state.since = Math.max(state.since, dropped.end);
  }
}

export function finishResource(state: SandboxAccounting, key: string, at: number): void {
  const current = state.resources[key];
  if (!current) return;
  const { id: resource, backend, start, kind, validUntil } = current;
  const end = kind === "ready" ? Math.min(at, validUntil) : at;
  remember(state, { kind, resource, backend, start, end });
  if (kind === "ready" && at > validUntil) remember(state, { kind: "unknown", resource, backend, start: validUntil, end: at });
  delete state.resources[key];
}

function resourceId(key: string, ref: SandboxRef): string {
  return JSON.stringify([key, ref.backend, ref.resource.id ?? null]);
}

export function opening(state: SandboxAccounting, key: string, backend: string, at: number, cold: boolean): void {
  if (!cold) return;
  const current = state.resources[key];
  if (current?.kind === "startup") {
    current.kind = "unknown";
  }
  finishResource(state, key, at);
  state.resources[key] = { id: key, backend, kind: "startup", start: at, confirmed: at, validUntil: at };
}

export function confirmedReady(state: SandboxAccounting, key: string, ref: SandboxRef, since: number, at: number): string {
  state.lastObservedAt = Math.max(state.lastObservedAt ?? 0, at);
  const id = resourceId(key, ref);
  const current = state.resources[key];
  const validUntil = since + SANDBOX_LEASE_MS;
  if (current?.kind === "ready" && current.id === id && since < current.validUntil && at <= current.validUntil) {
    current.confirmed = at;
    current.validUntil = Math.max(current.validUntil, validUntil);
  } else {
    if (current?.kind === "startup") current.id = id;
    finishResource(state, key, at);
    state.resources[key] = { id, backend: ref.backend, kind: "ready", start: at, confirmed: at, validUntil: Math.max(at, validUntil) };
  }
  return id;
}

export function stoppingResource(state: SandboxAccounting, key: string): void {
  const current = state.resources[key];
  if (current?.kind === "ready") current.stopping = true;
}

export function uncertainResource(state: SandboxAccounting, key: string, backend: string, at: number): void {
  const current = state.resources[key];
  if (current?.kind === "unknown") return;
  const id = current?.id ?? key;
  const start = current?.kind === "ready" ? current.confirmed : current?.start ?? at;
  if (current?.kind === "ready") finishResource(state, key, start);
  state.resources[key] = { id, backend, kind: "unknown", start, confirmed: start, validUntil: start };
}

export async function associateSandbox(tx: Tx, state: SandboxAccounting, toolId: TaskId, conversationId: ConversationId, resource: string, at: number): Promise<void> {
  let task = await tx.task(toolId);
  while (task?.owner !== undefined && task.conversationId === conversationId) {
    task = await tx.task(task.owner);
    if (task?.kind !== GenerationTask.definition.name || task.conversationId !== conversationId) continue;
    if (task.abortRequested || task.state.status === "terminal") return;
    const id = String(task.id);
    const prior = state.links[id];
    if (prior?.resource === resource) return;
    if (prior) remember(state, { kind: "association", task: id, ...prior, end: at });
    state.links[id] = { resource, start: at };
    return;
  }
}
