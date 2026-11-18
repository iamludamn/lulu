import type { Context } from "@earendil-works/chord/context";
import { awaitWithContext, withoutAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId, DocumentObserver, TaskId, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { toError } from "@earendil-works/pi-durable/env";
import { SandboxDoc, SANDBOX_LEASE_MS, type SandboxBinding } from "./doc.js";
import type { SandboxLifecycleTask } from "./lifecycle.js";
import { WorkspaceLost, type SandboxProvider, type SandboxRequest } from "./provider.js";
import { accounting, associateSandbox, confirmedReady, finishResource, opening, uncertainResource } from "./accounting.js";

export async function waitForSandbox(read: DocumentObserver, holder: ConversationId, ready: (binding: Readonly<SandboxBinding> | null) => boolean, context: Context): Promise<void> {
  const watch = await read.watchDoc(SandboxDoc, holder, context);
  if (!watch) throw new Error("Sandbox workspace is gone");
  try {
    if (ready(watch.value)) return;
    await awaitWithContext(Promise.race([
      new Promise<void>((resolve) => watch.start(async (call) => { if (call.kind === "value" && ready(call.retired ? null : call.value)) resolve(); })),
      watch.closed.then(() => { throw new Error("Sandbox workspace watch closed"); }),
    ]), context);
  } finally {
    await watch.stop();
  }
}

export function resetSandbox(binding: SandboxBinding): void {
  binding.ref = null;
  binding.backend = null;
  binding.profile = "default";
  binding.cwd = "";
  binding.epoch += 1;
  binding.revision += 1;
  binding.idleSince = null;
  binding.lost = false;
  binding.error = null;
}

export async function ensureSandboxLifecycle(tx: Tx, holder: ConversationId, binding: SandboxBinding, lifecycle: SandboxLifecycleTask): Promise<void> {
  const task = binding.lifecycleTaskId === null ? undefined : await tx.task(binding.lifecycleTaskId);
  if (task && task.state.status !== "terminal") return;
  binding.lifecycleTaskId = await tx.createTask(lifecycle, { holder }, { ownership: { kind: "conversation" }, conversationId: holder, background: true });
}

export async function releaseSandbox(api: ToolExecutionApi, holder: ConversationId, context: Context): Promise<void> {
  await api.commit(async (tx) => {
    const binding = await tx.doc(SandboxDoc, holder);
    if (!binding.users.some((user) => user.taskId === api.taskId)) return;
    binding.users = binding.users.filter((user) => user.taskId !== api.taskId);
    binding.lastUsedAt = Date.now();
    binding.revision += 1;
  }, withoutAbortSignal(context));
}

type Reservation = { wait: TaskId } | { lost: true } | { error: string } | { epoch: number; started: number; request: SandboxRequest };

export async function openSandbox(api: ToolExecutionApi, provider: SandboxProvider, lifecycle: SandboxLifecycleTask, context: Context) {
  const own = await api.snapshot(SandboxDoc, api.conversationId, context);
  if (!own?.key) throw new Error("No execution environment is assigned to this conversation");
  const holder = own.owner ?? api.conversationId;
  for (;;) {
    const reserved = await api.commit<Reservation>(async (tx) => {
      const binding = await tx.doc(SandboxDoc, holder);
      await ensureSandboxLifecycle(tx, holder, binding, lifecycle);
      if (binding.operation && binding.operation.taskId !== api.taskId) return binding.error ? { error: binding.error } : { wait: binding.operation.taskId };
      if (binding.lost) return { lost: true };
      const now = Date.now();
      if (binding.backend === null) {
        binding.backend = provider.backend;
        binding.profile = provider.profile;
      }
      const key = `${holder}:${binding.epoch}`;
      const requestId = `sandbox:open:${key}`;
      const journal = await accounting(tx, now);
      opening(journal, key, binding.backend, now, binding.ref === null || binding.idleSince !== null);
      binding.operation = { taskId: api.taskId, kind: "open", requestId };
      binding.users = [...binding.users.filter((user) => user.taskId !== api.taskId), { taskId: api.taskId, expiresAt: now + SANDBOX_LEASE_MS }];
      binding.lastUsedAt = now;
      binding.revision += 1;
      const ref = binding.ref === null ? null : JSON.parse(JSON.stringify(binding.ref)) as SandboxBinding["ref"];
      return { epoch: binding.epoch, started: now, request: { backend: binding.backend, profile: binding.profile, key, requestId, ref, cwd: binding.cwd } };
    }, context);
    if ("wait" in reserved) {
      await waitForSandbox(api, holder, (binding) => !binding?.operation || binding.operation.taskId !== reserved.wait || binding.error !== null, context);
      continue;
    }
    if ("error" in reserved) throw new Error(reserved.error);
    if ("lost" in reserved) throw new WorkspaceLost("Workspace files were lost; wait for active operations to finish before starting a new workspace");
    try {
      const opened = await provider.open(reserved.request, context);
      if (opened.ref.backend !== reserved.request.backend) throw new Error("Sandbox backend returned a mismatched reference");
      await api.commit(async (tx) => {
        const binding = await tx.doc(SandboxDoc, holder);
        if (binding.epoch !== reserved.epoch || binding.operation?.taskId !== api.taskId) throw new Error("Sandbox binding changed while opening the workspace");
        const now = Date.now();
        const journal = await accounting(tx, now);
        const resource = confirmedReady(journal, reserved.request.key, opened.ref, reserved.started, now);
        await associateSandbox(tx, journal, api.taskId, api.conversationId, resource, now);
        binding.ref = opened.ref;
        binding.cwd = opened.cwd;
        binding.idleSince = null;
        binding.operation = null;
        binding.error = null;
        binding.revision += 1;
      }, context);
      return { ...opened, holder, epoch: reserved.epoch };
    } catch (error) {
      await api.commit(async (tx) => {
        const binding = await tx.doc(SandboxDoc, holder);
        if (binding.epoch !== reserved.epoch || binding.operation?.taskId !== api.taskId) return;
        const now = Date.now();
        const journal = await accounting(tx, now);
        uncertainResource(journal, reserved.request.key, reserved.request.backend, reserved.started);
        if (error instanceof WorkspaceLost) finishResource(journal, reserved.request.key, now);
        binding.error = toError(error).message;
        if (error instanceof WorkspaceLost) binding.lost = true;
        if (reserved.request.ref !== null || error instanceof WorkspaceLost) binding.operation = null;
        binding.revision += 1;
      }, withoutAbortSignal(context)).catch(() => undefined);
      await releaseSandbox(api, holder, context).catch(() => undefined);
      throw error;
    }
  }
}
