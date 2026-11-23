import { defineExtension, section, type Extension, type Registry } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { artifactSend, artifactVersionCheck, createArtifactExtension } from "../artifact/extension.js";
import { CronExtension, scheduleSend } from "../cron/tool.js";
import { DelegateAgents } from "../delegate/agents.js";
import { createDelegateExtension, delegateSendGuidance } from "../delegate/extension.js";
import { findDelegateRun } from "../delegate/runs.js";
import { STORED_EXTENSION_NAMES } from "../durable-names.js";
import type { DurableHost } from "../host/types.js";
import type { McpHost } from "../mcp/extension.js";
import { memoryExtensionFor } from "../memory/extension.js";
import { checklistSend, createPanelExtension } from "../panel.js";
import { createSandboxProvider } from "../sandbox/backends.js";
import { createEnvironmentExtension } from "../sandbox/extension.js";
import { createSendExtension, SEND_PREAMBLE, type SendContribution } from "../send/tool.js";
import { spaceSend } from "../space/offer.js";

type HarnessDeps = { host: DurableHost; mcp: McpHost };
type CatalogDeps = HarnessDeps & { delivery: readonly SendContribution[] };

const ASSISTANT_ROLE = "You are a concise assistant. User messages may begin with a display name in brackets; treat it as speaker attribution.";

export const DEFAULT_EXTENSIONS = ["coding", "environment", "delegate", "cron", "chat", "mcp", "codemode", "memory", "artifact", "panel", "send"] as const;
type ExtensionName = typeof DEFAULT_EXTENSIONS[number];

const sandboxProvider = ({ env, name, telemetry }: DurableHost) => createSandboxProvider(env, name, telemetry);

const CATALOG: Record<ExtensionName, (deps: CatalogDeps) => Extension> = {
  coding: () => CodingTools,
  environment: ({ host }) => createEnvironmentExtension(sandboxProvider(host)),
  delegate: ({ host }) => createDelegateExtension(DelegateAgents, sandboxProvider(host)),
  cron: () => CronExtension,
  panel: () => createPanelExtension(),
  send: ({ delivery }) => createSendExtension(delivery),
  chat: ({ delivery }) => {
    const preamble = [ASSISTANT_ROLE, SEND_PREAMBLE, ...delivery.flatMap(({ preamble }) => preamble ?? [])].join(" ");
    return defineExtension({
      name: STORED_EXTENSION_NAMES.chat,
      sections: [
        section("preamble", async (input, context) => {
          if (await findDelegateRun(input.read, input.conversationId, context)) return undefined;
          return preamble;
        }, { tag: false }),
        section("clock", () => `Current time: ${new Date().toISOString().slice(0, 16)}Z.`, { tag: false }),
      ],
    });
  },
  mcp: ({ mcp }) => mcp.extension,
  codemode: ({ host, mcp }) => createCodemodeExtension({ sandbox: host.sandbox, namespaces: mcp.namespaces }),
  memory: ({ host }) => memoryExtensionFor(host),
  artifact: ({ host }) => createArtifactExtension(host.env),
};

export function installHarness(registry: Registry, names: readonly ExtensionName[], deps: HarnessDeps): void {
  const { host } = deps;
  const exists = artifactVersionCheck(host);
  const delivery = [checklistSend, spaceSend(host.env, exists), scheduleSend, artifactSend(exists), delegateSendGuidance];
  const catalog = { ...deps, delivery };
  for (const name of names) registry.install(CATALOG[name](catalog));
}
