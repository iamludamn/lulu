import { createDreamingTask } from "../memory/dreaming.js";
import { defineExtension, section, type Extension, type Registry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { DelegateAgents } from "../delegate/agents.js";
import { createDelegateExtension } from "../delegate/extension.js";
import { findDelegateRun } from "../delegate/runs.js";
import { CronExtension } from "../cron/extension.js";
import { createPanelExtension } from "../panel/extension.js";
import { createSendExtension } from "../send/extension.js";
import type { ArtifactCheck } from "../send/tool.js";
import { createEnvironmentExtension } from "../sandbox/extension.js";
import { createSandboxProvider } from "../sandbox/backends.js";
import { memoryTelemetry } from "../memory/telemetry.js";
import { createMemoryUpdate } from "../memory/schedule.js";
import { createMemoryExtension } from "../memory/extension.js";
import { createArtifactExtension } from "../artifact/extension.js";
import { artifactConfigured } from "../artifact/s3.js";
import type { McpHost } from "./mcp.js";
import type { DurableHost } from "../host/types.js";
import { STORED_EXTENSION_NAMES } from "../durable-names.js";

export type HarnessDeps = { host: DurableHost; mcp: McpHost };

const PREAMBLE = [
  "You are a concise assistant. User messages may begin with a display name in brackets; treat it as speaker attribution.",
  "Chat is for conversation: an answer, a question, a confirmation, a few sentences.",
  "When the content is long (a report, plan, guide, comparison, research, step-by-step instructions, a long list or table, or simply more than about ten lines, or anything with headings, tables or command output), put the full Markdown in body of the same send_to_user text call and give the user the gist in content, in one to three sentences. The body is the delivery: do not also offer it as a file. Never split a long answer into several messages.",
  "Write body like a good colleague: a title, the conclusion first, then headings, lists and tables where they help, in the language the user writes in.",
  "Save a file with the artifact tools only when the user asks for a file to keep or the content is meant to last beyond the conversation.",
  "For reminders, set an Alarm with schedule mode=reminder. For items the user wants to check off over time, offer a Checklist.",
  "Nothing you make enters the user's assets or panel on its own. You offer it as a card and the user decides whether to keep it.",
].join(" ");

export const DEFAULT_HARNESS = {
  extensions: ["coding", "environment", "delegate", "cron", "chat", "mcp", "codemode", "memory", "artifact", "panel", "send"],
  prompt: PREAMBLE,
};

const artifactCheck = (host: DurableHost): ArtifactCheck | undefined =>
  artifactConfigured(host.env)
    ? async (name, version) => {
        const query = new URLSearchParams({ name, version: String(version) });
        return (await host.objects.ARTIFACTS.getByName(host.name).fetch(`https://artifact/stat?${query}`)).ok;
      }
    : undefined;
const sandboxProvider = ({ env, name, telemetry }: DurableHost) => createSandboxProvider(env, name, telemetry);

export const CATALOG: Record<string, (deps: HarnessDeps) => Extension> = {
  coding: () => CodingTools,
  environment: ({ host }) => createEnvironmentExtension(sandboxProvider(host)),
  delegate: ({ host }) => createDelegateExtension(DelegateAgents, sandboxProvider(host)),
  cron: () => CronExtension,
  panel: () => createPanelExtension(),
  send: ({ host }) => createSendExtension(artifactCheck(host)),
  chat: () =>
    defineExtension({
      name: STORED_EXTENSION_NAMES.chat,
      sections: [
        section("preamble", async (input, context) => {
          if (await findDelegateRun(input.read, input.conversationId, context)) return undefined;
          return DEFAULT_HARNESS.prompt;
        }, { tag: false }),
        section("clock", () => `Current time: ${new Date().toISOString().slice(0, 16)}Z.`, { tag: false }),
      ],
    }),
  mcp: ({ mcp }) => mcp.extension,
  codemode: ({ host, mcp }) => createCodemodeExtension({ sandbox: host.sandbox, namespaces: mcp.namespaces }),
  memory: ({ host }) => createMemoryExtension({
    telemetry: memoryTelemetry(host.telemetry, host.name),
    update: createMemoryUpdate(host),
    dreaming: createDreamingTask(host),
  }),
  artifact: ({ host }) => createArtifactExtension(artifactConfigured(host.env)),
};

export function installHarness(registry: Registry, names: readonly string[], deps: HarnessDeps): void {
  for (const name of names) registry.install(CATALOG[name](deps));
}
