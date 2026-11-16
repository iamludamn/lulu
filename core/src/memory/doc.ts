import { defineDoc, defineDocFamily, type ModelRef } from "@earendil-works/pi-durable";

export type Episode = {
  id: number;
  role: "user" | "assistant";
  text: string;
};

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

export const DreamingSources = defineDocFamily<{ sources: MemorySource[] }, { sources: MemorySource[] }>({
  kind: "lulu.memory.dreaming.sources", version: 1, scope: "session", family: true, checkpointWhen: () => false,
  initial: ({ sources }) => ({ sources }),
});
export const DreamingBindings = defineDoc<{ submissions: Record<string, string> }>({
  kind: "lulu.memory.dreaming.bindings", version: 1, scope: "session", checkpointWhen: () => false,
  initial: () => ({ submissions: {} }),
});
