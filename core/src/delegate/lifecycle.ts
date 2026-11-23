import { awaitWithContext, withCancel, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineTask, type ConversationId, type EntryId, type SubmissionId, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { deadlineForDelegate, inputSubmission, linkFollowup, REQUEST_TIMEOUT_MS, type ScheduleMessageSource } from "../conversation/requests.js";
import { RENAMED_TASKS } from "../durable-names.js";
import { SandboxDoc } from "../sandbox/doc.js";
import { DelegateIndex, RunFamily, oneLine, readRunStatus, reserveDelegate, shortId, updateRun, type RunUsage } from "./runs.js";

interface AnchorInput {
  runId: string;
}

export const DelegateAnchor = defineTask<AnchorInput, { phase: "hold" }, { runId: string }, object>({
  name: RENAMED_TASKS.delegateAnchor.current,
  version: 1,
  initial: () => ({ phase: "hold" }),
  phases: {
    hold: async (task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { runId: task.input.runId } } }), context);
    },
  },
  abort: async () => undefined,
});

interface RunStart {
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
  draft.deadline = await deadlineForDelegate(tx, start.origin);
  if (!index.ids.includes(start.runId)) index.ids.push(start.runId);
  const anchor = await tx.createTask(DelegateAnchor, { runId: start.runId }, { ownership: { kind: "conversation" }, conversationId: start.parentId, background: true });
  const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
  // Delegates use the default extensions, including the coding tools excluded by the main conversation.
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

interface WaitInput extends Settling {
  childId: ConversationId;
  prompt?: string;
  requestId: string;
}

interface WaitCheckpoint {
  phase: "wait";
}

interface WaitResult {
  runId: string;
  status: "done" | "failed" | "closed";
}

function textOf(message: AssistantMessage): string {
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") parts.push(part.text);
  }
  return parts.join("");
}

async function readAnswer(runtime: TaskRuntime<WaitInput, WaitCheckpoint, WaitResult, object>, childId: ConversationId, answerId: EntryId | undefined, context: Context): Promise<{ text: string; usage: RunUsage }> {
  if (answerId) {
    const entry = await runtime.entry(AssistantEntry, answerId, context);
    const message = entry?.model?.[0] as AssistantMessage | undefined;
    if (message && message.role === "assistant") {
      const usage = sumUsage([message.usage]);
      return { text: textOf(message) || "(no output)", usage: { ...usage, turns: 1 } };
    }
  }
  const view = await runtime.context(childId, context);
  const found: AssistantMessage[] = [];
  for (const message of view.messages) {
    if (message.role === "assistant") found.push(message);
  }
  const last = found[found.length - 1];
  const usage = sumUsage(found.map((message) => message.usage));
  return { text: last ? textOf(last) || "(no output)" : "(no output)", usage: { ...usage, turns: found.length } };
}

function sumUsage(list: (Usage | undefined)[]): { input: number; output: number; cost: number } {
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const usage of list) {
    if (!usage) continue;
    input += usage.input;
    output += usage.output;
    cost += usage.cost.total;
  }
  return { input, output, cost };
}

function failureText(reason: string, detail: unknown): string {
  const base = reason || "child run left unanswered";
  return typeof detail === "string" && detail !== "" ? base + ": " + detail : base;
}

function noticeText(short: string, status: string, task: string, body: string, token: string | null): string {
  const head = token ? "token: " + token + "\n" : "";
  return head + "### " + short + " (" + status + ")\nTask: " + oneLine(task) + "\n\n" + body;
}

interface Settling {
  runId: string;
  parentId: ConversationId;
  task: string;
  noticeId: string;
  token: string | null;
  scheduleSource?: ScheduleMessageSource;
}

async function settle<I extends Settling, S extends { phase: string }>(input: I, runtime: TaskRuntime<I, S, WaitResult, object>, context: Context, status: "done" | "failed", text: string, usage: RunUsage | null): Promise<void> {
  const short = shortId(input.runId);
  const parent = await runtime.conversation(input.parentId, context);
  const endedAt = runtime.now();
  await runtime.commit(async (tx) => {
    if ((await readRunStatus(tx, input.runId)) !== "running") return { status: "terminal", outcome: { status: "aborted", reason: "run no longer active" } };
    const source = input.scheduleSource ?? { kind: "delegate_result", runId: input.runId } as const;
    const notice = parent ? await parent.submit(tx, inputSubmission({
      ...source,
      content: noticeText(short, status, input.task, text, input.token),
      requestId: input.noticeId,
    })) : undefined;
    const run = await tx.doc(RunFamily, input.runId, { id: input.runId, task: input.task, description: "", origin: [], agent: "", cwd: "" });
    if (notice !== undefined) await linkFollowup(tx, run.origin, notice);
    await updateRun(tx, input.runId, status === "done" ? { status, endedAt, output: text, usage, noticeId: notice ?? null } : { status, endedAt, error: text, usage, noticeId: notice ?? null });
    return { status: "terminal", outcome: { status: "completed", result: { runId: input.runId, status } } };
  }, context);
}

export const DelegateWait = defineTask<WaitInput, WaitCheckpoint, WaitResult, object>({
  name: RENAMED_TASKS.delegateWait.current,
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      const input = task.input;
      const run = await runtime.snapshot(RunFamily, input.runId, context);
      if (!run || run.status !== "running") {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "run no longer active" } }), context);
        return;
      }
      const child = await runtime.conversation(input.childId, context);
      if (!child) {
        await settle(task.input, runtime, context, "failed", "child conversation is gone", null);
        return;
      }
      const deadline = run.deadline ?? run.startedAt + REQUEST_TIMEOUT_MS;
      if (deadline <= runtime.now()) {
        await child.abort(context, { background: true });
        await settle(input, runtime, context, "failed", "Request exceeded its 15 minute deadline", null);
        return;
      }
      const draft = { content: input.prompt ?? input.task, requestId: input.requestId };
      const submission = await child.submit(input.scheduleSource === undefined ? { type: "input", ...draft } : inputSubmission({ ...draft, ...input.scheduleSource }), context);
      const waiting = withCancel(context);
      let stopTimer = (): void => {};
      let settled;
      try {
        settled = await Promise.race([
          submission.wait(waiting.context),
          awaitWithContext(new Promise<undefined>((resolve) => {
            stopTimer = runtime.setTimer(() => resolve(undefined), Math.max(0, deadline - runtime.now()));
          }), waiting.context),
        ]);
      } finally {
        stopTimer();
        waiting.cancel();
      }
      if (settled === undefined) {
        await child.abort(context, { background: true });
        await settle(input, runtime, context, "failed", "Request exceeded its 15 minute deadline", null);
        return;
      }
      const latest = await runtime.snapshot(RunFamily, input.runId, context);
      if (!latest || latest.status !== "running") {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "run no longer active" } }), context);
        return;
      }
      if (settled.status === "unanswered") {
        await settle(task.input, runtime, context, "failed", failureText(settled.reason, settled.detail), null);
        return;
      }
      const answer = await readAnswer(runtime, input.childId, settled.answer, context);
      await settle(task.input, runtime, context, "done", answer.text, answer.usage);
    },
  },
  abort: async (task, runtime, context) => {
    const input = task.input;
    const child = await runtime.conversation(input.childId, context);
    if (child) await child.abort(context, { background: true });
    await runtime.commit(async (tx) => {
      await updateRun(tx, input.runId, { status: "closed", endedAt: runtime.now() });
      return { status: "terminal", outcome: { status: "aborted", reason: "delegate closed" } };
    }, context);
  },
});
