import { reserveDelegate, REQUEST_TIMEOUT_MS } from "./limits.js";
import { ChatDoc } from "../conversation/progress.js";
import type { ScheduleMessageSource } from "../conversation/input.js";
import { configure, type ConversationId, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { SandboxDoc } from "../sandbox/doc.js";
import { DelegateAnchor } from "./anchor.js";
import { DelegateIndex, RunFamily } from "./runs.js";
import { DelegateWait } from "./wait.js";

export interface RunStart {
  runId: string;
  task: string;
  description: string;
  agent: string;
  token: string | null;
  scheduleSource?: ScheduleMessageSource;
  origin: SubmissionId[];
  parentId: ConversationId;
  cwd: string | null;
  model: string | null;
  thinkingLevel: string | null;
}

export async function createRun(tx: Tx, start: RunStart): Promise<{ runId: string; childId: ConversationId }> {
  const index = await tx.doc(DelegateIndex);
  if (!index.ids.includes(start.runId)) await reserveDelegate(tx, start.runId);
  const draft = await tx.doc(RunFamily, start.runId, { id: start.runId, task: start.task, description: start.description, origin: start.origin, agent: start.agent, cwd: start.cwd ?? "" });
  if (draft.conversationId !== null) return { runId: start.runId, childId: draft.conversationId };
  const deadlines = (await tx.doc(ChatDoc)).messages.filter((message) => message.id !== null && start.origin.includes(message.id as SubmissionId)).flatMap((message) => message.deadline === undefined ? [] : [message.deadline]);
  draft.deadline = Math.min(Date.now() + REQUEST_TIMEOUT_MS, ...deadlines);
  if (!index.ids.includes(start.runId)) index.ids.push(start.runId);
  const anchor = await tx.createTask(DelegateAnchor, { runId: start.runId }, { ownership: { kind: "conversation" }, conversationId: start.parentId, background: true });
  const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
  await configure(tx, child.id, { extensions: null });
  const binding = await tx.doc(SandboxDoc, child.id);
  binding.key = start.runId;
  binding.owner = start.parentId;
  draft.conversationId = child.id;
  draft.model = start.model;
  draft.thinkingLevel = start.thinkingLevel;
  draft.token = start.token;
  draft.waitTaskId = await tx.createTask(DelegateWait, {
    runId: start.runId,
    childId: child.id,
    parentId: start.parentId,
    task: start.task,
    requestId: "delegate:" + start.runId + "#0",
    noticeId: "delegate:notice:" + start.runId + "#0",
    token: start.token,
    ...(start.scheduleSource === undefined ? {} : { scheduleSource: start.scheduleSource }),
  }, { ownership: { kind: "conversation" }, conversationId: start.parentId, background: true });
  return { runId: start.runId, childId: child.id };
}
