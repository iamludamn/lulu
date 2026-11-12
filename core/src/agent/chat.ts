import type { Models } from "@earendil-works/pi-ai/models";
import { createRegistry, type HarnessOptions, type Registry } from "@earendil-works/pi-durable";
import { openMcp, type McpHost, type McpServerConfig } from "./mcp.js";
import { artifactConfigured } from "../artifact/s3.js";
import { mcpStore } from "./mcp-store.js";
import { DEFAULT_HARNESS, installHarness } from "./catalog.js";
import type { DurableHost, McpHostServices } from "../host/types.js";
import type { McpStatus } from "../protocol/contract.js";

function platformServers(host: DurableHost): Record<string, McpServerConfig> {
  const { env } = host;
  const servers: Record<string, McpServerConfig> = {};
  if (artifactConfigured(env)) {
    servers.artifact = { url: "https://artifact/mcp", fetch: (input, init) => host.objects.ARTIFACTS.getByName(host.name).fetch(input, init) };
  }
  if (env.TAVILY_API_KEY) servers.tavily = { url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${env.TAVILY_API_KEY}` };
  servers.exa = { url: env.EXA_API_KEY ? `https://mcp.exa.ai/mcp?exaApiKey=${env.EXA_API_KEY}` : "https://mcp.exa.ai/mcp" };
  return servers;
}

function mcpServices(host: DurableHost): McpHostServices {
  return {
    env: host.env,
    telemetry: host.telemetry,
    readMcpAuth: () => host.readMcpAuth(),
    writeMcpAuth: (content) => host.writeMcpAuth(content),
  };
}

async function openChatMcp(host: DurableHost, botServers: Record<string, McpServerConfig>): Promise<{ host: McpHost; statuses: McpStatus[] }> {
  const platform = platformServers(host);
  const mcp = await openMcp({ ...botServers, ...platform }, mcpServices(host));
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
    DEFAULT_HARNESS.extensions.filter((name) => name === "mcp" || name === "codemode" || name === "delegate"),
    { host, mcp: opened.host },
  );
  await previous.close();
  return opened;
}

export async function createChatHarnessOptions(
  host: DurableHost,
  models: Models,
): Promise<{ options: HarnessOptions; mcp: McpStatus[]; host: McpHost; registry: Registry; botServers: Record<string, McpServerConfig> }> {
  const botServers = await mcpStore(host, host.name).servers();
  const { host: mcp, statuses } = await openChatMcp(host, botServers);
  const registry = createRegistry();
  installHarness(registry, DEFAULT_HARNESS.extensions, { host, mcp });
  return {
    options: {
      models,
      registry,
      settings: {
        retry: { enabled: true, maxRetries: 6, baseDelayMs: 2000 },
        compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
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
