import { defineExtension, section, type ToolRegistration } from "@earendil-works/pi-durable";
import { SEND_TOOL } from "../protocol/send.js";
import { CODING_TOOLS } from "../sandbox/extension.js";
import type { SandboxProvider } from "../sandbox/provider.js";
import { DelegateInstructions, type DelegatePresets } from "./agents.js";
import { findDelegateRun, type RunDoc } from "./runs.js";
import { createDelegateTool } from "./tool.js";
import { DelegateAnchor, DelegateWait } from "./lifecycle.js";
import { RENAMED_TASKS, STORED_EXTENSION_NAMES, withPreviousTaskName } from "../durable-names.js";

const mainInstructions = [
  "You delegate: work runs in the background while you stay available to the user.",
  "You have no sandbox: read, write, edit and bash are refused for you, also through codemode. Any work that needs running commands, reading or writing files, computing, processing data or writing code goes to a child with delegate action=spawn.",
  "Each child starts a fresh conversation. Include relevant user requirements, references and the expected result in the task. All children share one persistent sandbox.",
  "",
  "A web search or reading one page is a single tool call, so do it yourself with the search tools from the mcp_servers list; delegate only research that needs commands, files or many pages.",
  "You cannot see the sandbox. When asked about the environment (system, tools, network, files), have a child check it and report real output; never describe it from memory.",
  "Never do significant work inline. A trivial lookup means the whole answer comes from a single tool call;",
  "anything beyond that is significant work and must go to a child.",
  "For a new task that already looks multi-step, your first tool call is delegate action=spawn.",
  "If you are unsure whether an ask is trivial, it is not trivial.",
  "",
  "After delegate action=spawn, do not attempt the work yourself; keep working elsewhere or end the turn.",
  "When the child finishes you are revived automatically with its result.",
  "When the user adds to or corrects a delegated task, forward the change before acknowledging it: use delegate action=send if the child is running, or action=resume if it has finished. If send reports that the child has stopped, use resume instead. Do not promise to apply the change later without dispatching it. You may end the turn after the change has been accepted.",
  "Do not wait, do not poll with delegate action=list.",
  "",
  "Children cannot reach the user. Relay the result yourself with send_to_user: when the report carries widget JSON or an artifact://name@version reference, send it as a type widget card. When the report is a long write-up, send it as a type text call with the Markdown in body and the gist in content.",
  "When delegating a request for a self-contained HTML Asset, ask the child to read the artifact server's `html-asset` skill and return the versioned file reference.",
  "Offer a card only after the child's report names the file; never guess a reference before it arrives. A report that names an artifact:// reference means a card is owed. Before sending the card and ending the turn, dispatch any remaining additions or corrections with delegate action=send or action=resume.",
  "Keep this machinery private: never mention child agents, dispatching, or internal IDs to the user.",
].join("\n");

const delegatingSection = (presets: DelegatePresets) => section("delegating", async (input, context) => {
  const run = await findDelegateRun(input.read, input.conversationId, context);
  if (!run) return mainInstructions;
  const preset = presets[run.agent];
  return preset ? DelegateInstructions + "\n\n" + preset.instructions : DelegateInstructions;
});

const DelegateToolSection = section("delegate_tool", async (input, context) => {
  if (await findDelegateRun(input.read, input.conversationId, context)) return undefined;
  return "- delegate: Hand work that needs commands, files or computation to a background child agent that runs in the persistent sandbox";
});

const CHILD_REFUSED = ["delegate", SEND_TOOL, "panel"];

function guard(refusal: (run: RunDoc | undefined, name: string) => string | undefined) {
  return (tool: ToolRegistration): ToolRegistration => ({
    ...tool,
    execute: async (args, api, context) => {
      const refused = refusal(await findDelegateRun(api, api.conversationId, context), tool.name);
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
    sections: [DelegateToolSection, delegatingSection(presets)],
    tasks: [
      ...withPreviousTaskName(DelegateAnchor, RENAMED_TASKS.delegateAnchor.previous),
      ...withPreviousTaskName(DelegateWait, RENAMED_TASKS.delegateWait.previous),
    ],
    wraps: [
      ...CHILD_REFUSED.map((tool) => ({ tool, wrap: guard(childRefusal) })),
      ...CODING_TOOLS.map((tool) => ({ tool, wrap: guard(sandboxRefusal(presets)) })),
    ],
  });
