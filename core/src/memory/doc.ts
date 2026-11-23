import { defineDoc, defineDocFamily, type ModelRef, type SubmissionId, type Tx } from "@earendil-works/pi-durable";

export type Episode = {
  id: number;
  role: "user" | "assistant";
  text: string;
};

export type Turn = Pick<Episode, "role" | "text">;

export type EpisodeSource = {
  conversationId?: string;
  model: ModelRef;
  episodes: Episode[];
  through: number;
};

export type SourceRef = { name: string; version: number; contentType: string; size: number; part: "page" | "state" | "file" };
export type MemorySource = { id: string; type: "space" | "asset"; version: string; title: string; summary: string; refs: SourceRef[] };
export type MemoryResource = { id: string; type: "system" | "person" | "topic" | "space" | "asset" | "log"; summary: string; sourceRefs: string[]; version: string; contentRef: string };
export type SelectedMemory = { resource: MemoryResource; text: string | null; truncated?: boolean };
export type MemoryInjection = { requestId: string; context?: string; selected: SelectedMemory[]; outcome: "selected" | "empty" | "unconfigured" | "timeout" | "error" | "catalog_unavailable" };

export const InjectionFamily = defineDocFamily<MemoryInjection, { requestId: string }>({
  kind: "lulu.memory.injection",
  version: 1,
  scope: "session",
  family: true,
  checkpointWhen: () => false,
  initial: ({ requestId }) => ({ requestId, selected: [], outcome: "empty" }),
});

export const InjectionBindings = defineDoc<{ requests: Record<string, string> }>({
  kind: "lulu.memory.injection.bindings",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ requests: {} }),
});

export async function bindInjection(tx: Tx, submission: SubmissionId, injection: MemoryInjection): Promise<boolean> {
  const { requestId } = injection;
  const selection = await tx.doc(InjectionFamily, requestId, { requestId });
  const bindings = await tx.doc(InjectionBindings);
  if (bindings.requests[String(submission)] !== undefined) return false;
  Object.assign(selection, injection);
  bindings.requests[String(submission)] = requestId;
  return true;
}

export function injectionRequest(bindings: Readonly<Record<string, string>> | undefined, origins: readonly number[]): string | undefined {
  for (let i = origins.length - 1; i >= 0; i--) {
    const requestId = bindings?.[String(origins[i])];
    if (requestId !== undefined) return requestId;
  }
}

export async function inheritInjection(tx: Tx, origins: readonly number[], submission: SubmissionId): Promise<void> {
  const bindings = await tx.doc(InjectionBindings);
  const requestId = injectionRequest(bindings.requests, origins);
  if (requestId !== undefined) bindings.requests[String(submission)] = requestId;
}

export const DreamingSources = defineDocFamily<{ sources: MemorySource[] }, { sources: MemorySource[] }>({
  kind: "lulu.memory.dreaming.sources", version: 1, scope: "session", family: true, checkpointWhen: () => false,
  initial: ({ sources }) => ({ sources }),
});
export const DreamingBindings = defineDoc<{ submissions: Record<string, string> }>({
  kind: "lulu.memory.dreaming.bindings", version: 1, scope: "session", checkpointWhen: () => false,
  initial: () => ({ submissions: {} }),
});
