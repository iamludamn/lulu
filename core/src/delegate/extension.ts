import type { Context } from "@earendil-works/chord/context";
import { defineExtension, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { SEND_TOOL } from "../protocol/send.js";
import { CODING_TOOLS } from "../sandbox/extension.js";
import { SandboxDoc } from "../sandbox/doc.js";
import type { SandboxProvider } from "../sandbox/provider.js";
import type { DelegatePresets } from "./agents.js";
import { RunFamily, type RunDoc } from "./runs.js";
import { createDelegateTool } from "./tool.js";
import { DelegateToolSection, DelegatingSection } from "./prompt.js";
import { DelegateAnchor } from "./anchor.js";
import { DelegateWait } from "./wait.js";
import { RENAMED_TASKS, STORED_EXTENSION_NAMES, withPreviousTaskName } from "../durable-names.js";

const CHILD_REFUSED = ["delegate", SEND_TOOL, "panel"];

async function childRun(api: ToolExecutionApi, context: Context): Promise<RunDoc | undefined> {
  const key = (await api.snapshot(SandboxDoc, api.conversationId, context))?.key;
  const run = key ? await api.snapshot(RunFamily, key, context) : undefined;
  return run?.conversationId === api.conversationId ? run : undefined;
}

function guard(refusal: (run: RunDoc | undefined, name: string) => string | undefined) {
  return (tool: ToolRegistration): ToolRegistration => ({
    ...tool,
    execute: async (args, api, context) => {
      const refused = refusal(await childRun(api, context), tool.name);
      return refused === undefined ? tool.execute(args, api, context) : { output: [{ type: "text", text: refused }], isError: true };
    },
  });
}

const childRefusal = (run: RunDoc | undefined, name: string) =>
  run === undefined ? undefined : `You are a child agent and cannot use ${name}. Put the result in your final reply; the main agent relays it to the user.`;

const sandboxRefusal = (presets: DelegatePresets) => (run: RunDoc | undefined, name: string) => {
  if (run === undefined) return `The main agent has no sandbox, so ${name} is unavailable. Hand file and command work to a child with delegate action=spawn.`;
  return presets[run.agent]?.tools.includes(name) ? undefined : `The ${run.agent} preset cannot use ${name}.`;
};

export const createDelegateExtension = (presets: DelegatePresets, sandboxes: SandboxProvider | undefined) =>
  defineExtension({
    name: STORED_EXTENSION_NAMES.delegate,
    tools: [createDelegateTool(presets, sandboxes)],
    sections: [DelegateToolSection, DelegatingSection],
    tasks: [
      ...withPreviousTaskName(DelegateAnchor, RENAMED_TASKS.delegateAnchor.previous),
      ...withPreviousTaskName(DelegateWait, RENAMED_TASKS.delegateWait.previous),
    ],
    wraps: [
      ...CHILD_REFUSED.map((tool) => ({ tool, wrap: guard(childRefusal) })),
      ...CODING_TOOLS.map((tool) => ({ tool, wrap: guard(sandboxRefusal(presets)) })),
    ],
  });
