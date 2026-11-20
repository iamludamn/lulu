import { reserveDelegate, REQUEST_TIMEOUT_MS } from "./limits.js";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool, LiveDoc } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { DefaultDelegateAgent, type DelegatePresets } from "./agents.js";
import { DelegateIndex, RunFamily, formatElapsed, resolveRunId, runIdOf, shortId, updateRun, type RunDoc } from "./runs.js";
import type { SandboxProvider } from "../sandbox/provider.js";
import { createRun } from "./spawn.js";
import { DelegateWait } from "./wait.js";

const delegateParams = (presets: DelegatePresets) => Type.Object({
  action: Type.Union([Type.Literal("spawn"), Type.Literal("list"), Type.Literal("send"), Type.Literal("resume"), Type.Literal("close")], {
    description: "spawn | list | send | resume | close",
  }),
  task: Type.Optional(Type.String({ description: "Self-contained task for spawn. Include the relevant context, constraints and expected result." })),
  description: Type.Optional(Type.String({ description: "Short display label for spawn, shown in the UI" })),
  id: Type.Optional(Type.String({ description: "Child handle for list/send/resume/close" })),
  message: Type.Optional(Type.String({ description: "Instruction for send, or optional prompt for resume" })),
  agent: Type.Optional(Type.String({ enum: Object.keys(presets), description: "Preset for spawn. Default worker." })),
  token: Type.Optional(Type.String({ description: "Owner tag for spawn; echoed on settle" })),
});

type DelegateArgs = Static<ReturnType<typeof delegateParams>>;

type DelegateDetails = {
  action: string;
  id: string | null;
};

function ok(text: string, action: string, id: string | null): ToolExecutionResult<DelegateDetails> {
  return { output: [{ type: "text", text }], details: { action, id } };
}

function fail(text: string): ToolExecutionResult<DelegateDetails> {
  return { output: [{ type: "text", text }], details: { action: "error", id: null }, isError: true };
}

async function spawn(api: ToolExecutionApi<DelegateDetails>, args: DelegateArgs, presets: DelegatePresets, sandboxes: SandboxProvider | undefined, context: Context): Promise<ToolExecutionResult<DelegateDetails>> {
  const task = args.task?.trim();
  if (!task) return fail("spawn requires task");
  const description = args.description?.trim();
  if (!description) return fail("spawn requires description");
  const agentName = args.agent ?? DefaultDelegateAgent;
  if (!Object.hasOwn(presets, agentName)) return fail("unknown delegate agent: " + agentName);
  const token = args.token?.trim() ? args.token.trim() : null;
  const runId = await runIdOf(String(api.taskId));
  if (!sandboxes) return fail("spawn needs a sandbox, but none is configured");
  const parent = await api.agent(context);
  const created = await api.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, api.conversationId);
    const run = await createRun(tx, {
      runId,
      task,
      description,
      agent: agentName,
      token,
      origin: live.run?.inputs ?? [],
      parentId: api.conversationId,
      cwd: parent.cwd ?? null,
      model: parent.model ? parent.model.provider + "/" + parent.model.modelId : null,
      thinkingLevel: parent.thinkingLevel ?? null,
    });
    return run;
  }, context);
  await api.details({ action: "spawn", id: created.runId }, context);
  api.output("spawned " + shortId(created.runId) + "\n");
  return ok("spawned " + shortId(created.runId), "spawn", created.runId);
}

async function list(api: ToolExecutionApi<DelegateDetails>, args: DelegateArgs, context: Context): Promise<ToolExecutionResult<DelegateDetails>> {
  if (args.id) {
    const index = await api.snapshot(DelegateIndex, context);
    const resolved = resolveRunId(index?.ids ?? [], args.id);
    if (!resolved) return fail("unknown id: " + args.id);
    const run = await api.snapshot(RunFamily, resolved, context);
    if (!run) return fail("unknown id: " + args.id);
    return ok(formatRow(run), "list", run.id);
  }
  const index = await api.snapshot(DelegateIndex, context);
  const runs = await Promise.all((index?.ids ?? []).map((id) => api.snapshot(RunFamily, id, context)));
  const rows = runs.filter((run): run is RunDoc => !!run && run.status !== "closed").map(formatRow);
  return ok(rows.length === 0 ? "No child agents." : rows.join("\n"), "list", null);
}

function formatRow(run: RunDoc): string {
  const parts = ["id=" + shortId(run.id), "status=" + run.status, "elapsed=" + formatElapsed((run.endedAt ?? Date.now()) - run.startedAt)];
  if (run.usage) parts.push("turns=" + run.usage.turns, "cost=$" + run.usage.cost.toFixed(4));
  if (run.conversationId) parts.push("conversation=" + String(run.conversationId));
  return parts.join("  ");
}

async function send(api: ToolExecutionApi<DelegateDetails>, args: DelegateArgs, context: Context): Promise<ToolExecutionResult<DelegateDetails>> {
  if (!args.id) return fail("send requires id");
  const message = args.message?.trim();
  if (!message) return fail("send requires message");
  const run = await mustRun(api, args.id, context);
  if (!run) return fail("unknown id: " + args.id);
  if (run.status !== "running") return fail(shortId(run.id) + " is " + run.status + "; use resume for a stopped child");
  if (!run.conversationId) return fail(shortId(run.id) + " has no live conversation; use resume");
  const child = await api.conversation(run.conversationId, context);
  if (!child) return fail(shortId(run.id) + " has no live conversation; use resume");
  await api.commit(async (tx) => {
    await child.submit(tx, { type: "input", content: message, requestId: "delegate:send:" + run.id + ":" + run.generation + ":" + String(api.taskId) });
    const live = await tx.doc(LiveDoc, api.conversationId);
    const draft = await tx.doc(RunFamily, run.id, { id: run.id, task: run.task, description: run.description, origin: run.origin, agent: run.agent, cwd: run.cwd });
    draft.origin = [...new Set([...draft.origin, ...(live.run?.inputs ?? [])])];
  }, context);
  return ok("sent to " + shortId(run.id), "send", run.id);
}

async function resume(api: ToolExecutionApi<DelegateDetails>, args: DelegateArgs, context: Context): Promise<ToolExecutionResult<DelegateDetails>> {
  if (!args.id) return fail("resume requires id");
  const run = await mustRun(api, args.id, context);
  if (!run) return fail("unknown id: " + args.id);
  if (run.status === "running") return fail(shortId(run.id) + " is running; use send");
  if (run.status === "closed") return fail(shortId(run.id) + " was closed");
  if (!run.conversationId) return fail(shortId(run.id) + " has no conversation to resume");
  const prompt = args.message?.trim() ? args.message.trim() : "Continue from where you stopped.";
  const resumeTaskId = String(api.taskId);
  await api.commit(async (tx) => {
    const draft = await tx.doc(RunFamily, run.id, { id: run.id, task: run.task, description: run.description, origin: run.origin, agent: run.agent, cwd: run.cwd });
    if (draft.resumeTaskId === resumeTaskId) return;
    await reserveDelegate(tx, run.id);
    draft.deadline = Date.now() + REQUEST_TIMEOUT_MS;
    draft.origin = [...((await tx.doc(LiveDoc, api.conversationId)).run?.inputs ?? [])];
    const generation = draft.generation + 1;
    draft.resumeTaskId = resumeTaskId;
    draft.status = "running";
    draft.endedAt = null;
    draft.output = null;
    draft.error = null;
    draft.usage = null;
    draft.generation = generation;
    const noticeId = "delegate:notice:" + run.id + "#" + generation;
    const options = { ownership: { kind: "conversation" }, background: true } as const;
    draft.waitTaskId = await tx.createTask(DelegateWait, { runId: run.id, childId: run.conversationId as ConversationId, parentId: api.conversationId, task: prompt, requestId: "delegate:" + run.id + "#" + generation, noticeId, token: run.token }, options);
  }, context);
  return ok("resumed " + shortId(run.id), "resume", run.id);
}

async function close(api: ToolExecutionApi<DelegateDetails>, args: DelegateArgs, context: Context): Promise<ToolExecutionResult<DelegateDetails>> {
  if (!args.id) return fail("close requires id");
  const run = await mustRun(api, args.id, context);
  if (!run) return fail("unknown id: " + args.id);
  if (run.conversationId) {
    const child = await api.conversation(run.conversationId, context);
    if (child) await child.abort(context, { background: true });
  }
  await api.commit(async (tx) => {
    await updateRun(tx, run.id, { status: "closed", endedAt: Date.now() });
  }, context);
  return ok("closed " + shortId(run.id), "close", run.id);
}

async function mustRun(api: ToolExecutionApi<DelegateDetails>, input: string, context: Context): Promise<RunDoc | undefined> {
  const index = await api.snapshot(DelegateIndex, context);
  const resolved = resolveRunId(index?.ids ?? [], input);
  if (!resolved) return undefined;
  const run = await api.snapshot(RunFamily, resolved, context);
  return run ?? undefined;
}

export const createDelegateTool = (presets: DelegatePresets, sandboxes: SandboxProvider | undefined): ToolRegistration => defineTool({
  name: "delegate",
  description: [
    "Launch a background child agent to handle a complex, multi-step task autonomously, and get its result back automatically.",
    "If a new task needs more than a single tool call, call this tool with action=spawn as your first step.",
    "After spawn, continue other work or end the turn. When the child finishes you are revived automatically with its result.",
    "Each child starts a fresh conversation. Put the context it needs in the task. Children share one persistent sandbox with file and command tools.",
    "Children cannot message the user: their report comes back to you, and you send any widget or asset card it carries with send_to_user.",
    "Actions: spawn (start a child with a task, returns an id immediately),",
    "list (read-only diagnostic, never a polling loop), send (message a running child),",
    "resume (restart a stopped child), close (stop a child; no completion callback).",
    "Keep this machinery private: never mention children, dispatching, or internal IDs to the user.",
  ].join(" "),
  parameters: delegateParams(presets),
  replay: "safe",
  executionMode: "parallel",
  execute: async (args, api, context) => {
    switch ((args as DelegateArgs).action) {
      case "spawn":
        return spawn(api, args as DelegateArgs, presets, sandboxes, context);
      case "list":
        return list(api, args as DelegateArgs, context);
      case "send":
        return send(api, args as DelegateArgs, context);
      case "resume":
        return resume(api, args as DelegateArgs, context);
      case "close":
        return close(api, args as DelegateArgs, context);
      default:
        return fail("unknown action: " + String((args as DelegateArgs).action));
    }
  },
});
