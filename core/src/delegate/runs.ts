import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { ConversationId, DocumentReader, SubmissionId, TaskId, Tx } from "@earendil-works/pi-durable";
import { STORED_DOC_KINDS } from "../durable-names.js";
import { SandboxDoc } from "../sandbox/doc.js";

export type RunStatus = "running" | "done" | "failed" | "closed";

export type RunUsage = {
  input: number;
  output: number;
  cost: number;
  turns: number;
};

export type RunDoc = {
  id: string;
  task: string;
  description: string;
  origin: SubmissionId[];
  status: RunStatus;
  startedAt: number;
  deadline?: number;
  endedAt: number | null;
  agent: string;
  cwd: string;
  model: string | null;
  thinkingLevel: string | null;
  conversationId: ConversationId | null;
  requestId: string;
  generation: number;
  output: string | null;
  error: string | null;
  token: string | null;
  waitTaskId: TaskId | null;
  resumeTaskId: string | null;
  noticeId: SubmissionId | null;
  usage: RunUsage | null;
};

export type RunSeed = {
  id: string;
  task: string;
  description: string;
  origin: SubmissionId[];
  agent: string;
  cwd: string;
};

export const RunFamily = defineDocFamily<RunDoc, RunSeed>({
  kind: STORED_DOC_KINDS.delegateRun,
  version: 2,
  migrate: (value) => value as unknown as RunDoc,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (seed) => ({
    id: seed.id,
    task: seed.task,
    description: seed.description,
    origin: seed.origin,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    agent: seed.agent,
    cwd: seed.cwd,
    model: null,
    thinkingLevel: null,
    conversationId: null,
    requestId: "delegate:" + seed.id + "#0",
    generation: 0,
    output: null,
    error: null,
    token: null,
    waitTaskId: null,
    resumeTaskId: null,
    noticeId: null,
    usage: null,
  }),
});

export const DelegateIndex = defineDoc<{ ids: string[] }>({
  kind: STORED_DOC_KINDS.delegateIndex,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ ids: [] }),
});

export async function findDelegateRun(read: Pick<DocumentReader, "snapshot">, conversationId: ConversationId, context: Context): Promise<RunDoc | undefined> {
  const key = (await read.snapshot(SandboxDoc, conversationId, context))?.key;
  const run = key ? await read.snapshot(RunFamily, key, context) : undefined;
  return run?.conversationId === conversationId ? run : undefined;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export async function runIdOf(taskId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(taskId));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

export function resolveRunId(ids: readonly string[], input: string): string | undefined {
  const matches = ids.filter((id) => id.startsWith(input));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function readRunStatus(tx: Tx, id: string): Promise<RunStatus | undefined> {
  const draft = await tx.doc(RunFamily, id, { id, task: "", description: "", origin: [], agent: "", cwd: "" });
  return (draft as RunDoc).status;
}

export async function updateRun(tx: Tx, id: string, patch: Partial<RunDoc>): Promise<void> {
  const draft = await tx.doc(RunFamily, id, { id, task: "", description: "", origin: [], agent: "", cwd: "" });
  Object.assign(draft, patch);
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return ms + "ms";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + "s";
  return Math.floor(seconds / 60) + "m" + (seconds % 60) + "s";
}

export function oneLine(text: string, max = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? compact.slice(0, max - 3) + "..." : compact;
}
