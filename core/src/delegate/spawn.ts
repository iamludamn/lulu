import { reserveDelegate, REQUEST_TIMEOUT_MS } from "./limits.js";
import { ChatDoc } from "../conversation/progress.js";
import type { ScheduleMessageSource } from "../conversation/input.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, ProviderDoc, type ConversationId, type Cursor, type EntryId, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { SandboxDoc } from "../sandbox/doc.js";
import { ChildBrief, type DelegatePresets } from "./agents.js";
import { DelegateAnchor } from "./anchor.js";
import { DelegateIndex, RunFamily } from "./runs.js";
import { DelegateWait } from "./wait.js";

export interface RunStart {
  runId: string;
  task: string;
  description: string;
  agent: string;
  presets: DelegatePresets;
  token: string | null;
  scheduleSource?: ScheduleMessageSource;
  origin: SubmissionId[];
  parentId: ConversationId;
  cwd: string | null;
  forkAt: EntryId | null;
  model: string | null;
  thinkingLevel: string | null;
}

const SCAN_PAGE = 64;

export async function entryBeforeCall(tx: Tx, conversationId: ConversationId, callId: string): Promise<EntryId | null> {
  const id = callId.split("/")[0];
  let found = false;
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await tx.scanEntries({ conversationId }, SCAN_PAGE, cursor);
    for (const entry of page.items) {
      if (found) return entry.id;
      const message = AssistantEntry.is(entry) ? (entry.model?.[0] as AssistantMessage | undefined) : undefined;
      if (message?.content.some((part) => part.type === "toolCall" && part.id === id)) found = true;
    }
    if (page.next === undefined) return null;
    cursor = page.next;
  }
}

export async function createRun(tx: Tx, start: RunStart): Promise<{ runId: string; childId: ConversationId }> {
  const index = await tx.doc(DelegateIndex);
  if (!index.ids.includes(start.runId)) await reserveDelegate(tx, start.runId);
  const draft = await tx.doc(RunFamily, start.runId, { id: start.runId, task: start.task, description: start.description, origin: start.origin, agent: start.agent, cwd: start.cwd ?? "" });
  if (draft.conversationId !== null) return { runId: start.runId, childId: draft.conversationId };
  const deadlines = (await tx.doc(ChatDoc)).messages.filter((message) => message.id !== null && start.origin.includes(message.id as SubmissionId)).flatMap((message) => message.deadline === undefined ? [] : [message.deadline]);
  draft.deadline = Math.min(Date.now() + REQUEST_TIMEOUT_MS, ...deadlines);
  const preset = start.presets[start.agent];
  if (!index.ids.includes(start.runId)) index.ids.push(start.runId);
  const anchor = await tx.createTask(DelegateAnchor, { runId: start.runId }, { ownership: { kind: "conversation" }, conversationId: start.parentId, background: true });
  const ownership = { kind: "task", taskId: anchor } as const;
  const child = start.forkAt === null ? await tx.createConversation({ ownership }) : await tx.forkConversation(start.parentId, start.forkAt, { ownership });
  // Delegates use the default extensions, including the coding tools excluded by the main conversation.
  await configure(tx, child.id, { extensions: null });
  const binding = await tx.doc(SandboxDoc, child.id);
  binding.key = start.runId;
  binding.owner = start.parentId;
  (await tx.doc(ProviderDoc, child.id)).sessionId = (await tx.doc(ProviderDoc, start.parentId)).sessionId;
  draft.conversationId = child.id;
  draft.model = start.model;
  draft.thinkingLevel = start.thinkingLevel;
  draft.token = start.token;
  draft.waitTaskId = await tx.createTask(DelegateWait, {
    runId: start.runId,
    childId: child.id,
    parentId: start.parentId,
    task: start.task,
    prompt: [ChildBrief, preset.instructions, "Task:\n" + start.task].join("\n\n"),
    requestId: "delegate:" + start.runId + "#0",
    noticeId: "delegate:notice:" + start.runId + "#0",
    token: start.token,
    ...(start.scheduleSource === undefined ? {} : { scheduleSource: start.scheduleSource }),
  }, { ownership: { kind: "conversation" }, conversationId: start.parentId, background: true });
  return { runId: start.runId, childId: child.id };
}
