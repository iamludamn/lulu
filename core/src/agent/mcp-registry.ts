import type { DurableHost } from "../host/types.js";
import type { McpStatus } from "../protocol/contract.js";
import { MCP_MASK, type McpRegistryView } from "../protocol/mcp.js";
import { McpRegistryError, checkName, maskUrl, parseInput, resolve } from "./mcp-config.js";
import { loginMcp, callbackMcp, removeMcpAuth } from "./mcp-oauth.js";
import { mcpStore } from "./mcp-store.js";

export type RegistryHost = Pick<DurableHost, "env" | "kv" | "name" | "storage">;

export interface RegistryHooks {
  statuses(): readonly McpStatus[];
  reload(name?: string): Promise<readonly McpStatus[]>;
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

async function registryView(host: RegistryHost, statuses: readonly McpStatus[]): Promise<McpRegistryView> {
  const servers = await mcpStore(host, host.name).servers();
  return {
    servers: Object.entries(servers).map(([name, config]) => ({
      name,
      url: maskUrl(config.url),
      headers: Object.fromEntries(Object.keys(config.headers ?? {}).map((header) => [header, MCP_MASK])),
    })),
    statuses,
  };
}

async function save(host: RegistryHost, hooks: RegistryHooks, name: string, request: Request): Promise<Response> {
  const store = mcpStore(host, host.name);
  const servers = await store.servers();
  checkName(name, Object.keys(servers));
  const body = await request.json().catch(() => {
    throw new McpRegistryError(400, "Body is not valid JSON");
  });
  await store.put(name, resolve(parseInput(body), servers[name]));
  return json(await registryView(host, await hooks.reload(name)));
}

async function remove(host: RegistryHost, hooks: RegistryHooks, name: string): Promise<Response> {
  const store = mcpStore(host, host.name);
  await store.remove(name);
  await removeMcpAuth(host, name);
  return json(await registryView(host, await hooks.reload(name)));
}

async function route(request: Request, host: RegistryHost, hooks: RegistryHooks): Promise<Response> {
  if (host.env.MCP_ENCRYPTION_KEY === undefined) throw new McpRegistryError(503, "MCP_ENCRYPTION_KEY is not configured");
  const { pathname, origin, searchParams } = new URL(request.url);
  const parts = pathname.split("/").filter((part) => part !== "").slice(1);
  const allow = (...methods: string[]): Response | undefined =>
    methods.includes(request.method) ? undefined : Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: methods.join(", ") } });
  if (parts.length === 0) return allow("GET") ?? json(await registryView(host, hooks.statuses()));
  if (parts[0] === "reload" && parts.length === 1) return allow("POST") ?? json(await registryView(host, await hooks.reload()));
  if (parts[0] === "callback" && parts.length === 1) return allow("GET") ?? callbackMcp(host, hooks, searchParams, origin);
  const name = parts[1] === undefined ? undefined : decodeURIComponent(parts[1]);
  if (parts[0] !== "servers" || name === undefined) return json({ error: "Not found" }, 404);
  if (parts.length === 2) {
    return allow("PUT", "DELETE") ?? (request.method === "PUT" ? save(host, hooks, name, request) : remove(host, hooks, name));
  }
  if (parts.length === 3 && parts[2] === "reload") {
    const rejected = allow("POST");
    if (rejected !== undefined) return rejected;
    if ((await mcpStore(host, host.name).servers())[name] === undefined) throw new McpRegistryError(404, `Unknown server "${name}"`);
    return json(await registryView(host, await hooks.reload(name)));
  }
  if (parts.length === 3 && parts[2] === "login") return allow("POST") ?? loginMcp(host, hooks, name, origin);
  return json({ error: "Not found" }, 404);
}

export async function handleMcpRegistry(request: Request, host: RegistryHost, hooks: RegistryHooks): Promise<Response> {
  try {
    return await route(request, host, hooks);
  } catch (error) {
    if (error instanceof McpRegistryError) return json({ error: error.message }, error.status);
    throw error;
  }
}
