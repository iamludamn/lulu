import type { CodemodeToolOptions } from "@earendil-works/pi-durable/codemode";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { McpAuthRequiredError, McpClient, StreamableHttpTransport, toLlmContent, type AuthProvider, type McpFetch, type Tool } from "@earendil-works/pi-mcp";
import type { McpStatus } from "../protocol/contract.js";
import type { McpHostServices } from "../host/types.js";
import { McpFileAuthProvider } from "./mcp-auth.js";

const MAX_SERVER_DESCRIPTION_CHARS = 250;
const MAX_SERVERS_SECTION_CHARS = 4096;
const MAX_ERROR_CHARS = 200;
const MCP_SERVERS_SECTION = "mcp_servers";

export interface McpServerConfig {
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly fetch?: McpFetch;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return max <= 1 ? "" : `${text.slice(0, max - 1).trimEnd()}...`;
}

function serversSection(listed: Map<string, { description: string; count: number }>) {
  return section(MCP_SERVERS_SECTION, () => {
    if (listed.size === 0) return undefined;
    const lines = [...listed].map(([server, { description, count }]) => `- ${server} (${count} tools)${description ? `: ${description}` : ""}`);
    const header = "MCP servers whose tools are not declared to you. Load the tools of these servers with `tool_search`.";
    const kept: string[] = [];
    for (const line of lines) {
      if ([header, ...kept, line].join("\n").length > MAX_SERVERS_SECTION_CHARS) break;
      kept.push(line);
    }
    const omitted = lines.length - kept.length;
    return [header, ...kept, ...(omitted > 0 ? [`(${omitted} more servers not shown)`] : [])].join("\n");
  }, { tag: false });
}
export type McpConnection = Omit<McpStatus, "source">;

export interface RemoteMcpServer {
  readonly name: string;
  readonly url: string;
  readonly headers: { name: string; value: string }[];
}

export interface McpHost {
  readonly extension: Extension;
  readonly namespaces: NonNullable<CodemodeToolOptions["namespaces"]>;
  readonly statuses: readonly McpConnection[];
  remote(): Promise<RemoteMcpServer[]>;
  close(): Promise<void>;
}

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const resolved = new Map<string, string>();

/** A header value: `${VAR}` and `$VAR` read the environment, anything else is literal. */
function resolveValue(raw: string, label: string, host: McpHostServices): string {
  const cached = resolved.get(raw);
  if (cached !== undefined) return cached;
  const value = raw.replace(ENV_REFERENCE, (_match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? "";
    const found = host.env[name];
    if (found === undefined) throw new Error(`${label}: ${name} is not set`);
    return found;
  });
  resolved.set(raw, value);
  return value;
}

function urlSecrets(url: string): string[] {
  try {
    const parsed = new URL(url);
    return [url, parsed.pathname.length > 1 ? parsed.pathname : "", ...parsed.searchParams.values()];
  } catch {
    return [url];
  }
}

function redact(text: string, config: McpServerConfig, headers: Record<string, string> | undefined): string {
  const tokens = Object.values(headers ?? {}).flatMap((value) => [value, value.replace(/^\S+\s+/, "")]);
  const secrets = [...urlSecrets(config.url), ...tokens].filter((secret) => secret !== "").sort((a, b) => b.length - a.length);
  return secrets.reduce((clean, secret) => clean.split(secret).join("***"), text);
}

function headersOf(server: string, config: McpServerConfig, host: McpHostServices): Record<string, string> | undefined {
  if (config.headers === undefined) return undefined;
  const entries = Object.entries(config.headers).map(([name, raw]) => [name, resolveValue(raw, `MCP server "${server}" header "${name}"`, host)] as const);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function authOf(server: string, config: McpServerConfig, headers: Record<string, string> | undefined, host: McpHostServices): AuthProvider | undefined {
  const authorized = Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "authorization");
  return authorized ? undefined : new McpFileAuthProvider(server, config.url, host);
}

function parameters(schema: Tool["inputSchema"]): TSchema {
  return { ...schema, type: schema.type ?? "object", ...(schema.properties === undefined ? { properties: {} } : {}) } as unknown as TSchema;
}

export function mcpToolName(server: string, tool: string): string {
  return "mcp__" + server + "__" + tool;
}

function toolFor(server: string, client: McpClient, tool: Tool): ToolRegistration {
  return defineTool({
    name: mcpToolName(server, tool.name),
    callers: ["tools"],
    replay: "unsafe",
    description: tool.description?.trim() || tool.title || `MCP tool ${tool.name} from server ${server}`,
    parameters: parameters(tool.inputSchema),
    execute: async (args, _api, context) => {
      const result = await client.callTool(tool.name, (args ?? {}) as Record<string, unknown>, { signal: context.abortSignal });
      return {
        output: toLlmContent(result),
        ...(result.isError === true ? { isError: true } : {}),
        details: { server, tool: tool.name },
      };
    },
  });
}

export async function openMcp(servers: Record<string, McpServerConfig>, host: McpHostServices): Promise<McpHost> {
  const clients: McpClient[] = [];
  const connected: { server: string; client: McpClient; tool: Tool }[] = [];
  const statuses: McpConnection[] = [];
  const reachable: { server: string; url: string; headers: Record<string, string> | undefined; auth: AuthProvider | undefined }[] = [];
  for (const [server, config] of Object.entries(servers)) {
    await host.telemetry.startSpan({ name: "mcp.connect", attributes: { "lulu.mcp.server": server } }, async (span) => {
      const checkedAt = Date.now();
      let headers: Record<string, string> | undefined = undefined;
      try {
        headers = headersOf(server, config, host);
        const auth = config.fetch === undefined ? authOf(server, config, headers, host) : undefined;
        const client = new McpClient({ name: "pistack", version: "0.1.0" });
        await client.connect(
          new StreamableHttpTransport({
            url: config.url,
            ...(headers === undefined ? {} : { headers }),
            ...(auth === undefined ? {} : { authProvider: auth }),
            ...(config.fetch === undefined ? {} : { fetch: config.fetch, openGetStream: false }),
          }),
        );
        clients.push(client);
        const tools = await client.listTools();
        for (const tool of tools) connected.push({ server, client, tool });
        statuses.push({ name: server, state: "connected", tools: tools.length, checkedAt });
        span.setAttributes({ "lulu.mcp.state": "connected", "lulu.mcp.tools": tools.length });
        if (config.fetch === undefined) reachable.push({ server, url: config.url, headers, auth });
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error), config, headers);
        const state = error instanceof McpAuthRequiredError ? "needs-auth" : "failed";
        console.error(`[pistack] MCP server "${server}" unavailable: ${message}`);
        statuses.push({ name: server, state, tools: 0, error: truncate(message, MAX_ERROR_CHARS), checkedAt });
        span.setAttributes({ "lulu.mcp.state": state });
        span.setStatus({ status: "error", error: { name: error instanceof Error ? error.name : "Error", message: truncate(message, MAX_ERROR_CHARS) } });
      }
    });
  }
  const listed = new Map<string, { description: string; count: number }>();
  for (const { server, client } of connected) {
    const entry = listed.get(server) ?? { description: truncate(client.instructions ?? "", MAX_SERVER_DESCRIPTION_CHARS), count: 0 };
    entry.count += 1;
    listed.set(server, entry);
  }
  const tools = connected.map(({ server, client, tool }) => toolFor(server, client, tool));
  const namespaces = [...listed].map(([server, entry]) => ({
    name: server,
    description: entry.description || "MCP server " + server,
    prefix: mcpToolName(server, ""),
  }));
  return {
    namespaces,
    statuses,
    async remote() {
      return Promise.all(
        reachable.map(async ({ server, url, headers, auth }) => {
          const token = await auth?.token();
          const all = { ...headers, ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) };
          return { name: server, url, headers: Object.entries(all).map(([name, value]) => ({ name, value })) };
        }),
      );
    },
    extension: defineExtension({ name: "pistack.mcp", tools, sections: [serversSection(listed)] }),
    async close() {
      await Promise.all(clients.map((client) => client.close()));
    },
  };
}
