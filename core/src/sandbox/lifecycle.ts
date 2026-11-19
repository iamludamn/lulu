import { defineTask, type ConversationId, type Harness, type Task, type TaskId } from "@earendil-works/pi-durable";
import { SandboxDoc, SANDBOX_IDLE_MS, SANDBOX_RENEW_MS, SANDBOX_LEASE_MS, SANDBOX_RETENTION_MS } from "./doc.js";
import { WorkspaceLost, type SandboxProvider, type SandboxRef } from "./provider.js";
import { toError } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord/context";
import { ensureSandboxLifecycle, resetSandbox } from "./workspace.js";
import { accounting, confirmedReady, finishResource, opening, stoppingResource, uncertainResource } from "./accounting.js";
import { RENAMED_TASKS } from "../durable-names.js";

export const SANDBOX_LIFECYCLE = RENAMED_TASKS.sandboxLifecycle.current;
type LifecycleInput = { holder: ConversationId };
type LifecycleState = { phase: "check"; revision?: number } | { phase: "wait"; until: number; revision: number } | { phase: "apply"; epoch: number; ref: SandboxRef | null; backend: string; profile: string; cwd: string; action: "open" | "renew" | "idle" | "destroy"; requestId: string; createApp?: string; started?: number };
type LifecycleResult = { released: true };
export type SandboxLifecycleTask = Task<LifecycleInput, LifecycleState, LifecycleResult, object>;

export const SandboxLifecycleTimer = defineTask<{ until: number }, { phase: "sleep" } | { phase: "done" }, null>({
  name: "lulu.sandbox.lifecycle.timer",
  version: 1,
  initial: () => ({ phase: "sleep" }),
  phases: {
    sleep: (task, runtime, context) => runtime.sleepUntil(task.input.until, { phase: "done" }, context),
    done: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export function createSandboxLifecycle(provider: SandboxProvider | undefined): SandboxLifecycleTask {
  return defineTask<LifecycleInput, LifecycleState, LifecycleResult>({
    name: SANDBOX_LIFECYCLE,
    version: 1,
    initial: () => ({ phase: "check" }),
    phases: {
      check: async (task, runtime, context) => {
        const now = runtime.now();
        await runtime.commit(async (tx) => {
          const binding = await tx.doc(SandboxDoc, task.input.holder);
          const terminal = { status: "terminal" as const, outcome: { status: "completed" as const, result: { released: true as const } } };
          if (binding.lifecycleTaskId !== runtime.taskId) return terminal;
          const users = [];
          for (const user of binding.users) {
            const owner = await tx.task(user.taskId);
            if (owner && owner.state.status !== "terminal") users.push({ ...user, expiresAt: now + SANDBOX_LEASE_MS });
          }
          if (binding.users.length > 0 && users.length === 0) binding.lastUsedAt = now;
          binding.users = users;
          if (binding.operation?.kind === "open" && binding.operation.taskId !== runtime.taskId) {
            const opening = await tx.task(binding.operation.taskId);
            if (!opening || opening.state.status === "terminal") {
              if (binding.ref) binding.operation = null;
              else binding.operation.taskId = runtime.taskId;
            }
          }
          const wait = (until: number) => ({ status: "running" as const, checkpoint: { phase: "wait" as const, until, revision: binding.revision } });
          if (binding.operation?.kind === "open" && binding.operation.taskId !== runtime.taskId) return wait(now + SANDBOX_RENEW_MS);
          if (binding.lost) {
            if (users.length > 0) return wait(now + SANDBOX_RENEW_MS);
            resetSandbox(binding);
            binding.operation = null;
          }
          if (!binding.ref && binding.operation?.kind !== "open") {
            if (users.length > 0) return wait(now + SANDBOX_RENEW_MS);
            binding.lifecycleTaskId = null;
            return terminal;
          }
          let action: "open" | "renew" | "idle" | "destroy";
          if (binding.operation) action = binding.operation.kind;
          else if (users.length > 0) action = "renew";
          else if (now >= binding.lastUsedAt + SANDBOX_RETENTION_MS) action = "destroy";
          else if (binding.idleSince !== null) return wait(binding.lastUsedAt + SANDBOX_RETENTION_MS);
          else if (now < binding.lastUsedAt + SANDBOX_IDLE_MS) return wait(binding.lastUsedAt + SANDBOX_IDLE_MS);
          else action = "idle";
          const requestId = binding.operation?.requestId ?? `sandbox:${action}:${task.input.holder}:${binding.epoch}:${binding.lastUsedAt}`;
          const key = `${task.input.holder}:${binding.epoch}`;
          if (action === "open" && binding.backend) opening(await accounting(tx, now), key, binding.backend, now, !binding.ref || binding.idleSince !== null);
          if (action === "idle" || action === "destroy") stoppingResource(await accounting(tx, now), key);
          binding.operation = { taskId: runtime.taskId, kind: action, requestId };
          const createMetadata = action === "open" && binding.createApp !== undefined ? { createApp: binding.createApp } : {};
          return { status: "running", checkpoint: { phase: "apply", epoch: binding.epoch, ref: binding.ref, backend: binding.backend!, profile: binding.profile, cwd: binding.cwd, action, requestId, ...createMetadata, started: now } };
        }, context);
      },
      wait: (task, runtime, context) => runtime.commit(async (tx) => {
        const binding = await tx.doc(SandboxDoc, task.input.holder);
        const { until, revision } = task.state.checkpoint;
        if (binding.lifecycleTaskId !== runtime.taskId || binding.revision !== revision || until <= runtime.now()) {
          return { status: "running", checkpoint: { phase: "check" } };
        }
        const timer = await tx.createTask(SandboxLifecycleTimer, { until }, { ownership: { kind: "task", taskId: runtime.taskId } });
        return { status: "waiting", on: [timer], policy: "allSettled", checkpoint: { phase: "check", revision } };
      }, context),
      apply: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        const started = runtime.now();
        const key = `${task.input.holder}:${checkpoint.epoch}`;
        let ref = checkpoint.ref;
        let cwd = checkpoint.cwd;
        let failure: unknown;
        try {
          if (!provider) throw new Error("Sandbox backend is not configured");
          if (checkpoint.action === "open") {
            const opened = await provider.open({ backend: checkpoint.backend, profile: checkpoint.profile, key: `${task.input.holder}:${checkpoint.epoch}`, requestId: checkpoint.requestId, createApp: checkpoint.createApp, ref, cwd }, context);
            if (opened.ref.backend !== checkpoint.backend) throw new Error("Sandbox backend returned a mismatched reference");
            ref = opened.ref;
            cwd = opened.cwd;
          } else {
            if (!ref) throw new Error("Missing sandbox resource reference");
            if (checkpoint.action === "renew") await provider.renew(ref, context);
            else if (checkpoint.action === "idle") ref = await provider.idle(ref, checkpoint.requestId, context);
            else await provider.destroy(ref, checkpoint.requestId, context);
          }
          if (ref && ref.backend !== checkpoint.backend) throw new Error("Sandbox backend returned a mismatched reference");
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          failure = error;
          runtime.report(error);
        }
        await runtime.commit(async (tx) => {
          const binding = await tx.doc(SandboxDoc, task.input.holder);
          if (binding.epoch !== checkpoint.epoch || binding.operation?.taskId !== runtime.taskId || binding.operation.requestId !== checkpoint.requestId) return { status: "running", checkpoint: { phase: "check" } };
          const now = runtime.now();
          const journal = await accounting(tx, now);
          if (failure !== undefined) {
            uncertainResource(journal, key, checkpoint.backend, checkpoint.started ?? started);
            binding.error = toError(failure).message;
            if (failure instanceof WorkspaceLost) {
              finishResource(journal, key, now);
              binding.lost = true;
              binding.operation = null;
              return { status: "running", checkpoint: { phase: "check" } };
            }
            if (checkpoint.action === "renew") binding.operation = null;
            return { status: "running", checkpoint: { phase: "wait", until: now + SANDBOX_RENEW_MS, revision: binding.revision } };
          }
          binding.operation = null;
          binding.error = null;
          if (ref && (checkpoint.action === "open" || checkpoint.action === "renew")) confirmedReady(journal, key, ref, started, now);
          if (checkpoint.action === "idle" || checkpoint.action === "destroy") finishResource(journal, key, now);
          if (checkpoint.action === "destroy") resetSandbox(binding);
          else {
            binding.ref = ref;
            binding.cwd = cwd;
            if (checkpoint.action === "idle") binding.idleSince = now;
          }
          const until = checkpoint.action === "renew" ? now + SANDBOX_RENEW_MS : binding.lastUsedAt + SANDBOX_RETENTION_MS;
          return checkpoint.action === "destroy" || checkpoint.action === "open" ? { status: "running", checkpoint: { phase: "check" } } : { status: "running", checkpoint: { phase: "wait", until, revision: binding.revision } };
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "sandbox lifecycle stopped" } }), context);
    },
  });
}

export async function staleSandboxTimer(harness: Harness, holder: ConversationId, context: Context): Promise<TaskId | undefined> {
  const binding = await harness.snapshot(SandboxDoc, holder, context);
  if (binding?.lifecycleTaskId == null) return undefined;
  const lifecycle = await harness.getTask(binding.lifecycleTaskId, context);
  if (lifecycle?.state.status !== "waiting") return undefined;
  const { checkpoint, on } = lifecycle.state;
  if (checkpoint && typeof checkpoint === "object" && "revision" in checkpoint && typeof checkpoint.revision === "number" && checkpoint.revision < binding.revision) return on[0];
  return undefined;
}

export async function recoverSandboxLifecycle(harness: Harness, holder: ConversationId, provider: SandboxProvider | undefined, context: Context): Promise<void> {
  const binding = await harness.snapshot(SandboxDoc, holder, context);
  if (!binding || (!binding.ref && !binding.operation && binding.users.length === 0)) return;
  const lifecycle = createSandboxLifecycle(provider);
  await harness.commit(async (tx) => {
    const current = await tx.doc(SandboxDoc, holder);
    await ensureSandboxLifecycle(tx, holder, current, lifecycle);
  }, context);
  const timer = await staleSandboxTimer(harness, holder, context);
  if (timer !== undefined) await harness.abortTask(timer, context);
}
