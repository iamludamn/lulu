import type { Context } from "@earendil-works/chord/context";
import { GenerationTask, type ConversationId, type Harness, type TaskId } from "@earendil-works/pi-durable";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { accounting, finishResource, remember, uncertainResource, type SandboxAccounting } from "./accounting.js";
import { SandboxDoc } from "./doc.js";

type Activity = {
  task: TaskId;
  conversation: ConversationId;
  at: number;
  active: boolean;
  terminal: boolean;
};

function finishAgent(state: SandboxAccounting, task: string, at: number): void {
  const segment = state.agents[task];
  if (segment) remember(state, { kind: "agent", task, delegate: segment.delegate, start: segment.start, end: at });
}

function finishLink(state: SandboxAccounting, task: string, at: number): void {
  const link = state.links[task];
  if (!link) return;
  remember(state, { kind: "association", task, ...link, end: at });
  delete state.links[task];
}

export async function observeSandboxActivity(harness: Harness, root: ConversationId, telemetry: TelemetryContext, context: Context): Promise<() => Promise<void>> {
  await harness.commit(async (tx) => {
    const now = Date.now();
    const state = await accounting(tx, now);
    for (const [key, resource] of Object.entries(state.resources)) {
      if (resource.kind === "startup" || resource.stopping) uncertainResource(state, key, resource.backend, now);
    }
    const binding = await tx.doc(SandboxDoc, root);
    const key = `${root}:${binding.epoch}`;
    if (binding.lost) finishResource(state, key, now);
    else if (binding.ref && binding.idleSince === null && !state.resources[key]) uncertainResource(state, key, binding.ref.backend, now);

    for (const [id, agent] of Object.entries(state.agents)) {
      finishAgent(state, id, agent.observed);
      remember(state, { kind: "agentUnknown", task: id, delegate: agent.delegate, start: agent.observed, end: now });
    }
    for (const id of new Set([...Object.keys(state.agents), ...Object.keys(state.links)])) {
      const task = await tx.task(Number(id) as TaskId);
      if (!task || task.state.status === "terminal") finishLink(state, id, task?.endedAt ?? now);
    }
    state.agents = {};
  }, context);

  let pending = Promise.resolve();
  harness.observeCommits({
    advance: (publication) => {
      const events: Activity[] = [];
      for (const change of publication.changes) {
        if (change.type !== "task" || change.value.kind !== GenerationTask.definition.name) continue;
        const task = change.value;
        const checkpoint = task.state.checkpoint;
        const phase = checkpoint && typeof checkpoint === "object" && "phase" in checkpoint ? checkpoint.phase : undefined;
        const active = !task.abortRequested && (
          (task.state.status === "running" && (phase === "prepare" || phase === "request" || phase === "poll" || phase === "tools")) ||
          (task.state.status === "waiting" && (phase === "tools" || phase === "prepare"))
        );
        events.push({ task: task.id, conversation: task.conversationId, at: task.endedAt ?? Date.now(), active, terminal: task.state.status === "terminal" });
      }
      if (events.length === 0) return;
      pending = pending.then(() => harness.commit(async (tx) => {
        const state = await accounting(tx, Date.now());
        for (const { task, conversation, at, active, terminal } of events) {
          state.lastObservedAt = Math.max(state.lastObservedAt ?? 0, at);
          const id = String(task);
          const agent = state.agents[id];
          if (active) {
            if (agent) {
              agent.observed = at;
            } else {
              const delegate = conversation !== root && (await tx.doc(SandboxDoc, conversation)).owner !== null;
              state.agents[id] = { delegate, start: at, observed: at };
            }
          } else if (agent) {
            finishAgent(state, id, at);
            delete state.agents[id];
          }
          if (terminal) finishLink(state, id, at);
        }
      }, context)).catch(async () => {
        await telemetry.startSpan({ name: "sandbox.accounting.error" }, async (span) => {
          span.setStatus({ status: "error", error: { name: "AccountingError", message: "Could not record task activity" } });
        }).catch(() => undefined);
      });
    },
    end: () => {},
  });
  return () => pending;
}
