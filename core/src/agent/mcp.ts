import { serviceUsage } from "../telemetry/service.js";
import type { CodemodeToolOptions } from "@earendil-works/pi-durable/codemode";
import type { TSchema } from "typebox";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { McpAuthRequiredError, McpClient, normalizeMcpInputSchema, StreamableHttpTransport, toLlmContent, type AuthProvider, type McpFetch, type Tool } from "@earendil-works/pi-mcp";
import { createMcpAuthProvider, McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import type { McpStatus } from "../protocol/contract.js";
import type { DurableHost } from "../host/types.js";
import { mcpAuthStore } from "./mcp-auth.js";
import type { McpStoreHost } from "./mcp-store.js";
import { STORED_EXTENSION_NAMES } from "../durable-names.js";

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

export interface McpHost {
  readonly catalogReady: boolean;
  readonly extension: Extension;
  readonly namespaces: NonNullable<CodemodeToolOptions["namespaces"]>;
  readonly statuses: readonly McpConnection[];
  reconnect(servers: Record<string, McpServerConfig>, names?: readonly string[]): Promise<McpHost>;
  close(): Promise<void>;
}

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const resolved = new Map<string, string>();

function resolveValue(raw: string, label: string, host: McpServices): string {
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

function headersOf(server: string, config: McpServerConfig, host: McpServices): Record<string, string> | undefined {
  if (config.headers === undefined) return undefined;
  const entries = Object.entries(config.headers).map(([name, raw]) => [name, resolveValue(raw, `MCP server "${server}" header "${name}"`, host)] as const);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function authOf(server: string, config: McpServerConfig, headers: Record<string, string> | undefined, host: McpServices): AuthProvider | undefined {
  if (config.fetch !== undefined || Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "authorization")) return undefined;
  return createMcpAuthProvider({
    serverUrl: config.url,
    clientName: "lulu",
    settings: () => ({}),
    store: mcpAuthStore(host).server(server, config.url),
    onChallenge: () => {},
  });
}

function mcpToolName(server: string, tool: string): string {
  return "mcp__" + server + "__" + tool;
}

function toolFor(server: string, client: () => Promise<McpClient>, tool: Tool, host: McpServices, external: boolean): ToolRegistration {
  return defineTool({
    name: mcpToolName(server, tool.name),
    callers: ["tools"],
    replay: "unsafe",
    description: tool.description?.trim() || tool.title || `MCP tool ${tool.name} from server ${server}`,
    parameters: normalizeMcpInputSchema(tool.inputSchema) as unknown as TSchema,
    execute: async (args, _api, context) => {
      const call = async () => (await client()).callTool(tool.name, (args ?? {}) as Record<string, unknown>, { signal: context.abortSignal });
      const result = external ? await serviceUsage(host.telemetry, server, tool.name, async (span) => {
        const result = await call();
        if (result.isError) {
          console.error("External MCP tool failed", { server, tool: tool.name });
          span.setAttributes({ "lulu.service.outcome": "error" });
          span.setStatus({ status: "error", error: { name: "Error", message: "external MCP tool failed" } });
        }
        return result;
      }) : await call();
      return {
        output: toLlmContent(result),
        ...(result.isError === true ? { isError: true } : {}),
        details: { server, tool: tool.name },
      };
    },
  });
}

type McpServices = McpStoreHost & Pick<DurableHost, "telemetry">;
type McpCatalog = { tools: readonly Tool[]; instructions: string };

async function catalogKey(server: string, config: McpServerConfig): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([server, config.url, config.headers])));
  return "mcp.catalog:" + Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface McpSession {
  readonly catalogued?: boolean;
  readonly ready?: () => Promise<McpSession>;
  readonly dispose?: () => Promise<void>;
  readonly instructions?: string;
  readonly config: McpServerConfig;
  readonly client: McpClient | undefined;
  readonly tools: readonly Tool[];
  readonly status: McpConnection;
}

async function connectMcp(server: string, config: McpServerConfig, host: McpServices): Promise<McpSession> {
  return host.telemetry.startSpan({ name: "mcp.connect", attributes: { "lulu.mcp.server": server } }, async (span) => {
    const checkedAt = Date.now();
    let headers: Record<string, string> | undefined = undefined;
    const client = new McpClient({ name: "lulu", version: "0.1.0" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("MCP connection timed out")), 10_000);
    let connecting = true;
    const fetchMcp: McpFetch = (input, init) => (config.fetch ?? fetch)(input, {
      ...init,
      signal: AbortSignal.any([
        ...(init?.signal === undefined || init.signal === null ? [] : [init.signal]),
        ...(connecting ? [controller.signal] : []),
        ...(init?.method === "DELETE" ? [AbortSignal.timeout(5_000)] : []),
      ]),
    });
    try {
      headers = headersOf(server, config, host);
      const auth = authOf(server, config, headers, host);
      await client.connect(new StreamableHttpTransport({
        url: config.url,
        ...(headers === undefined ? {} : { headers }),
        ...(auth === undefined ? {} : { authProvider: auth }),
        fetch: fetchMcp,
        ...(config.fetch === undefined ? {} : { openGetStream: false }),
      }));
      const tools = await client.listTools({ signal: controller.signal });
      await host.storage.put({ [await catalogKey(server, config)]: { tools, instructions: client.instructions ?? "" } });
      span.setAttributes({ "lulu.mcp.state": "connected", "lulu.mcp.tools": tools.length });
      return { config, client, tools, status: { name: server, state: "connected", tools: tools.length, checkedAt } };
    } catch (error) {
      await client.close().catch(() => undefined);
      const message = redact(error instanceof Error ? error.message : String(error), config, headers);
      const state = error instanceof McpAuthRequiredError || error instanceof McpOAuthAuthorizationRequiredError ? "needs-auth" : "failed";
      console.error(`[lulu] MCP server "${server}" unavailable: ${message}`);
      span.setAttributes({ "lulu.mcp.state": state });
      span.setStatus({ status: "error", error: { name: error instanceof Error ? error.name : "Error", message: truncate(message, MAX_ERROR_CHARS) } });
      return { config, client: undefined, tools: [], status: { name: server, state, tools: 0, error: truncate(message, MAX_ERROR_CHARS), checkedAt } };
    } finally {
      connecting = false;
      clearTimeout(timer);
    }
  });
}

function mcpHost(sessions: ReadonlyMap<string, McpSession>, host: McpServices): McpHost {
  const owned = new Set(sessions.values());
  const listed = new Map<string, { description: string; count: number }>();
  const tools: ToolRegistration[] = [];
  for (const [server, session] of sessions) {
    const client = session.client;
    if (client === undefined && session.ready === undefined) continue;
    const acquire = async (): Promise<McpClient> => {
      const connected = session.ready ? await session.ready() : session;
      if (!connected.client) throw new Error(`MCP server "${server}" is unavailable`);
      return connected.client;
    };
    for (const tool of session.tools) tools.push(toolFor(server, acquire, tool, host, session.config.fetch === undefined));
    if (session.tools.length > 0) listed.set(server, { description: truncate(client?.instructions ?? session.instructions ?? "", MAX_SERVER_DESCRIPTION_CHARS), count: session.tools.length });
  }
  const namespaces = [...listed].map(([server, entry]) => ({
    name: server,
    description: entry.description || "MCP server " + server,
    prefix: mcpToolName(server, ""),
  }));
  return {
    namespaces,
    catalogReady: [...sessions.values()].every((session) => session.catalogued !== false),
    statuses: [...sessions.values()].map((session) => session.status),
    async reconnect(servers, names) {
      const next = new Map(await Promise.all(Object.entries(servers).map(async ([server, config]): Promise<[string, McpSession]> => {
        const previous = sessions.get(server);
        const reuse = names !== undefined && !names.includes(server) && previous !== undefined && previous.config.url === config.url && previous.config.fetch === config.fetch && JSON.stringify(previous.config.headers) === JSON.stringify(config.headers);
        const deferred = previous?.ready && previous.config.url === config.url && JSON.stringify(previous.config.headers) === JSON.stringify(config.headers) && (names === undefined || !names.includes(server));
        if (deferred) {
          const connected = await previous.ready!();
          owned.delete(previous);
          return [server, connected];
        }
        return [server, reuse ? previous : await connectMcp(server, config, host)];
      })));
      for (const session of next.values()) owned.delete(session);
      return mcpHost(next, host);
    },
    extension: defineExtension({ name: STORED_EXTENSION_NAMES.mcp, tools, sections: [serversSection(listed)] }),
    async close() {
      const closing = [...owned];
      owned.clear();
      await Promise.all(closing.flatMap((session) => session.dispose ? [session.dispose()] : session.client === undefined ? [] : [session.client.close()]));
    },
  };
}

export async function deferredMcp(servers: Record<string, McpServerConfig>, host: McpServices): Promise<McpHost> {
  const sessions = await Promise.all(Object.entries(servers).map(async ([name, config]): Promise<[string, McpSession]> => {
    const catalog = await host.storage.get<McpCatalog>(await catalogKey(name, config));
    let pending: Promise<McpSession> | undefined;
    const ready = () => pending ??= connectMcp(name, config, host);
    return [name, {
      config, catalogued: catalog !== undefined, client: undefined, tools: catalog?.tools ?? [], instructions: catalog?.instructions,
      status: { name, state: "idle", tools: catalog?.tools.length ?? 0, checkedAt: 0 },
      ready,
      dispose: async () => { if (pending) await (await pending).client?.close(); },
    }];
  }));
  return mcpHost(new Map(sessions), host);
}
