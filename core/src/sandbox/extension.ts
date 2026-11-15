import type { Context } from "@earendil-works/chord/context";
import { defineExtension, section, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { SandboxDoc } from "./doc.js";
import { createSandboxLifecycle, type SandboxLifecycleTask } from "./lifecycle.js";
import type { SandboxProvider } from "./provider.js";
import { openSandbox, releaseSandbox } from "./workspace.js";

export const CODING_TOOLS = ["read", "write", "edit", "bash"];

const fail = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

function inSandbox(provider: SandboxProvider | undefined, lifecycle: SandboxLifecycleTask) {
  return (tool: ToolRegistration): ToolRegistration => ({
    ...tool,
    execute: async (args, api, context: Context) => {
      if (!provider) return fail("no execution environment: no sandbox is configured");
      let opened;
      try {
        opened = await openSandbox(api, provider, lifecycle, context);
      } catch (error) {
        if (context.abortSignal?.aborted) throw error;
        return fail(`sandbox is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const result = await tool.execute(args, { ...api, env: opened.env }, context);
        return {
          ...result,
          diagnostics: [...(result.diagnostics ?? []), { severity: "info", code: "environment", message: `executed in ${opened.ref.backend} workspace generation ${opened.epoch}` }],
        };
      } finally {
        await releaseSandbox(api, opened.holder, context).catch(() => undefined);
      }
    },
  });
}

export function createEnvironmentExtension(provider: SandboxProvider | undefined) {
  const lifecycle = createSandboxLifecycle(provider);
  return defineExtension({
    name: "pistack.environment",
    tasks: [lifecycle],
    sections: [section("workspace", async (input, context) => {
      const own = await input.read.snapshot(SandboxDoc, input.conversationId, context);
      if (!own?.key) return undefined;
      const binding = own.owner === null ? own : await input.read.snapshot(SandboxDoc, own.owner, context);
      if (!binding) return undefined;
      if (binding.lost) return "The shared workspace was lost. Previous temporary files are unavailable. Active operations must finish before a new workspace can be created.";
      return binding.epoch === 0 ? undefined : `Shared workspace generation: ${binding.epoch}. The workspace has been reset; do not assume files or processes from earlier generations still exist.`;
    })],
    wraps: CODING_TOOLS.map((tool) => ({ tool, wrap: inSandbox(provider, lifecycle) })),
  });
}
