import { defineExtension, section, type Extension, type Registry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { DelegateAgents } from "../delegate/agents.js";
import { createDelegateExtension } from "../delegate/extension.js";
import { CronExtension } from "../cron/extension.js";
import { createPanelExtension } from "../panel/extension.js";
import { createSendExtension } from "../send/extension.js";
import type { ArtifactCheck } from "../send/tool.js";
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
  "Work with documents the way a person does. Chat is for conversation: an answer, a question, a confirmation, a few sentences.",
  "When the content is long or lasting (a report, plan, guide, comparison, research, step-by-step instructions, a long list or table, or simply more than about ten lines, or anything with headings, tables or command output), write it as a Markdown document instead of a chat message, and give the user the gist in one short message. Never split a long answer into several messages.",
  "Write documents like a good colleague: a title, the conclusion first, then headings, lists and tables where they help, in the language the user writes in.",
  "A panel widget is for something the user will check again and again: one small fact that changes, or a space, a small app page with live data or saved state.",
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

const artifactCheck = (host: DurableHost): ArtifactCheck | undefined =>
  artifactConfigured(host.env)
    ? async (name, version) => {
        const query = new URLSearchParams({ name, version: String(version) });
        return (await host.objects.ARTIFACTS.getByName(host.name).fetch(`https://artifact/stat?${query}`)).ok;
      }
    : undefined;

export const CATALOG: Record<string, (deps: HarnessDeps) => Extension> = {
  coding: () => CodingTools,
  environment: ({ host }) => createEnvironmentExtension(createSandboxProvider(host.env, host.name, host.telemetry)),
  delegate: ({ host }) => createDelegateExtension(DelegateAgents, createSandboxProvider(host.env, host.name, host.telemetry)),
  cron: () => CronExtension,
  panel: ({ host }) => createPanelExtension(artifactCheck(host)),
  send: ({ host }) => createSendExtension(artifactCheck(host)),
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
