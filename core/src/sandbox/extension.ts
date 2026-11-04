import type { Context } from "@earendil-works/chord";
import { defineExtension, type ConversationId, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { SandboxDoc } from "./doc.js";
import { isSandboxGone, type SandboxHandle, type SandboxProvider } from "./provider.js";

export const CODING_TOOLS = ["read", "write", "edit", "bash"];

const NO_ENVIRONMENT = "no execution environment: E2B_API_KEY is not configured";

async function bindSandbox(api: ToolExecutionApi, holder: ConversationId, key: string, sandboxes: SandboxProvider, context: Context): Promise<SandboxHandle> {
  const created = (await api.memo<SandboxHandle>("pistack.sandbox", context)) ?? (await api.memo("pistack.sandbox", await sandboxes.create(key), context));
  return api.commit(async (tx) => {
    const binding = await tx.doc(SandboxDoc, holder);
    if (!binding.id) {
      binding.id = created.id;
      binding.cwd = created.cwd;
    }
    return { id: binding.id, cwd: binding.cwd };
  }, context);
}

const fail = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

async function connectSandbox(api: ToolExecutionApi, sandboxes: SandboxProvider | undefined, context: Context): Promise<ExecutionEnv | { error: string }> {
  const own = await api.snapshot(SandboxDoc, api.conversationId, context);
  if (!own?.key || sandboxes === undefined) return { error: NO_ENVIRONMENT };
  const holder = own.owner ?? api.conversationId;
  const shared = own.owner === null ? own : await api.snapshot(SandboxDoc, holder, context);
  const createKey = (epoch: number): string => (own.owner === null ? own.key! : `shared:${epoch}`);
  try {
    const handle = shared?.id ? { id: shared.id, cwd: shared.cwd } : await bindSandbox(api, holder, createKey(shared?.epoch ?? 0), sandboxes, context);
    try {
      return await sandboxes.connect(handle);
    } catch (error) {
      if (!isSandboxGone(error)) throw error;
      const reset = await api.commit(async (tx) => {
        const binding = await tx.doc(SandboxDoc, holder);
        if (binding.id === handle.id) {
          binding.id = null;
          binding.epoch += 1;
        }
        return { id: binding.id, cwd: binding.cwd, epoch: binding.epoch };
      }, context);
      const rebound = reset.id ? { id: reset.id, cwd: reset.cwd } : await bindSandbox(api, holder, createKey(reset.epoch), sandboxes, context);
      return await sandboxes.connect(rebound);
    }
  } catch (error) {
    return { error: `sandbox is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function inSandbox(sandboxes: SandboxProvider | undefined) {
  return (tool: ToolRegistration): ToolRegistration => ({
    ...tool,
    execute: async (args, api, context) => {
      const env = await connectSandbox(api, sandboxes, context);
      if ("error" in env) return fail(env.error);
      const result = await tool.execute(args, { ...api, env }, context);
      return {
        ...result,
        diagnostics: [
          ...(result.diagnostics ?? []),
          { severity: "info", code: "environment", message: "executed in execution environment sandbox" },
        ],
      };
    },
  });
}

export function createEnvironmentExtension(sandboxes: SandboxProvider | undefined) {
  return defineExtension({
    name: "pistack.environment",
    wraps: CODING_TOOLS.map((tool) => ({ tool, wrap: inSandbox(sandboxes) })),
  });
}
