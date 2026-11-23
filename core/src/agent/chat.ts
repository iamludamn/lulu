import type { Models } from "@earendil-works/pi-ai/models";
import { createRegistry, type HarnessOptions, type Registry } from "@earendil-works/pi-durable";
import { deferredMcp, platformServers, type McpHost, type McpServerConfig } from "../mcp/extension.js";
import { mcpStore } from "../mcp/store.js";
import { DEFAULT_EXTENSIONS, installHarness } from "./catalog.js";
import type { DurableHost } from "../host/types.js";
import type { McpStatus } from "../protocol/contract.js";

async function openChatMcp(host: DurableHost, botServers: Record<string, McpServerConfig>): Promise<{ host: McpHost; statuses: McpStatus[] }> {
  const platform = platformServers(host);
  const mcp = await deferredMcp({ ...botServers, ...platform }, host);
  const statuses = mcp.statuses.map((status): McpStatus => ({ ...status, source: Object.hasOwn(platform, status.name) ? "platform" : "bot" }));
  return { host: mcp, statuses };
}

export async function reconnectChatMcp(
  host: DurableHost,
  registry: Registry,
  previous: McpHost,
  botServers: Record<string, McpServerConfig>,
  names?: readonly string[],
): Promise<{ host: McpHost; statuses: McpStatus[] }> {
  const platform = platformServers(host);
  const mcp = await previous.reconnect({ ...botServers, ...platform }, names);
  const opened = { host: mcp, statuses: mcp.statuses.map((status): McpStatus => ({ ...status, source: Object.hasOwn(platform, status.name) ? "platform" : "bot" })) };
  installHarness(
    registry,
    DEFAULT_EXTENSIONS.filter((name) => name === "mcp" || name === "codemode" || name === "delegate"),
    { host, mcp: opened.host },
  );
  await previous.close();
  return opened;
}

export async function createChatHarnessOptions(
  host: DurableHost,
  models: Models,
): Promise<{ options: HarnessOptions; mcp: McpStatus[]; host: McpHost; registry: Registry; botServers: Record<string, McpServerConfig> }> {
  const botServers = await mcpStore(host).servers();
  const { host: mcp, statuses } = await openChatMcp(host, botServers);
  const registry = createRegistry();
  installHarness(registry, DEFAULT_EXTENSIONS, { host, mcp });
  return {
    options: {
      models,
      registry,
      settings: {
        retry: { enabled: true, maxRetries: 6, baseDelayMs: 2000 },
        compaction: {
          enabled: true,
          reserveTokens: 16384,
          keepRecentTokens: 20000,
          backgroundTokens: 0,
          modelOverrides: Object.fromEntries(models.getModels().map((model) => [
            `${model.provider}/${model.id}`,
            { backgroundTokens: Math.max(0, model.contextWindow - 16384 - 400000) },
          ])),
        },
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        documentRetentionMs: 0,
      },
    },
    mcp: statuses,
    host: mcp,
    registry,
    botServers,
  };
}
