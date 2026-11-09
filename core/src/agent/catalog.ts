import { defineExtension, section, type Extension, type Registry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { DelegateAgents } from "../delegate/agents.js";
import { createDelegateExtension } from "../delegate/extension.js";
import { CronExtension } from "../cron/extension.js";
import { PanelExtension } from "../panel/extension.js";
import { createSendExtension } from "../send/extension.js";
import { createEnvironmentExtension } from "../sandbox/extension.js";
import { createSandboxProvider } from "../sandbox/provider.js";
import { createMemoryExtension } from "../memory/extension.js";
import { memoryContext, remoteFiles } from "../memory/client.js";
import { createArtifactExtension } from "../artifact/extension.js";
import { artifactConfigured } from "../artifact/s3.js";
import type { McpHost } from "./mcp.js";
import type { DurableHost } from "../host/types.js";

export type HarnessDeps = { host: DurableHost; mcp: McpHost };

const PREAMBLE = [
  "You are a concise assistant. User messages may begin with a display name in brackets; treat it as speaker attribution.",
  "Chat is for conversation: an answer, a question, a confirmation, a few sentences.",
  "When the content is long (a report, plan, guide, comparison, research, step-by-step instructions, a long list or table, or simply more than about ten lines, or anything with headings, tables or command output), put the full Markdown in body of the same send_to_user text call and give the user the gist in content, in one to three sentences. The body is the delivery: do not also offer it as a file. Never split a long answer into several messages.",
  "Write body like a good colleague: a title, the conclusion first, then headings, lists and tables where they help, in the language the user writes in.",
  "Save a file with the artifact tools only when the user asks for a file to keep or the content is meant to last beyond the conversation.",
  "A panel widget is only for one small fact that changes and that the user will check again and again.",
  "Nothing you make enters the user's assets or panel on its own. You offer it as a card and the user decides whether to keep it.",
].join(" ");

export const DEFAULT_HARNESS = {
  extensions: ["coding", "environment", "delegate", "cron", "chat", "mcp", "codemode", "memory", "artifact", "panel", "send"],
  prompt: PREAMBLE,
};

const contextFallback = (error: unknown): string => {
  console.error(JSON.stringify({ message: "Memory context unavailable", error: error instanceof Error ? error.message : String(error) }));
  return "";
};

export const CATALOG: Record<string, (deps: HarnessDeps) => Extension> = {
  coding: () => CodingTools,
  environment: ({ host }) => createEnvironmentExtension(createSandboxProvider(host.env, host.name, host.telemetry)),
  delegate: ({ host }) => createDelegateExtension(DelegateAgents, createSandboxProvider(host.env, host.name, host.telemetry)),
  cron: () => CronExtension,
  panel: () => PanelExtension,
  send: ({ host }) =>
    createSendExtension(
      artifactConfigured(host.env)
        ? async (name, version) => {
            const query = new URLSearchParams({ name, version: String(version) });
            return (await host.objects.ARTIFACTS.getByName(host.name).fetch(`https://artifact/stat?${query}`)).ok;
          }
        : undefined,
    ),
  chat: () =>
    defineExtension({
      name: "pistack.chat",
      sections: [
        section("preamble", () => DEFAULT_HARNESS.prompt, { tag: false }),
        section("clock", () => `Current time: ${new Date().toISOString().slice(0, 16)}Z.`, { tag: false }),
      ],
    }),
  mcp: ({ mcp }) => mcp.extension,
  codemode: ({ host, mcp }) => createCodemodeExtension({ sandbox: host.sandbox, namespaces: mcp.namespaces }),
  memory: ({ host }) => createMemoryExtension(() => memoryContext(host, host.name).catch((error: unknown) => contextFallback(error)), remoteFiles(host, host.name)),
  artifact: ({ host }) => createArtifactExtension(artifactConfigured(host.env)),
};

export function installHarness(registry: Registry, names: readonly string[], deps: HarnessDeps): void {
  for (const name of names) registry.install(CATALOG[name](deps));
}
