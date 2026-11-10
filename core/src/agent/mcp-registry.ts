import { authorizeMcp, McpOAuthProvider, type McpOAuthState, type McpOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import type { DurableHost } from "../host/types.js";
import type { McpStatus } from "../protocol/contract.js";
import { MCP_MASK, MCP_SERVER_NAME, type McpRegistryView, type McpServerInput } from "../protocol/mcp.js";
import { authKey } from "./mcp-auth.js";
import { mcpStore } from "./mcp-store.js";
import type { McpServerConfig } from "./mcp.js";

export type RegistryHost = Pick<DurableHost, "env" | "kv" | "name">;

export interface RegistryHooks {
  statuses(): readonly McpStatus[];
  reload(): Promise<readonly McpStatus[]>;
}

type Stored = Pick<McpServerConfig, "url" | "headers">;
type AuthDoc = Record<string, McpOAuthState>;

const PLATFORM_SERVERS = new Set(["artifact", "tavily", "exa"]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const AUTH_PREFIX = "mcp__";

export class McpRegistryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

const same = (name: string): string => name.replaceAll("-", "_");

function maskUrl(raw: string): string {
  const url = new URL(raw);
  for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, MCP_MASK);
  return url.toString();
}

function parseInput(body: unknown): McpServerInput {
  if (typeof body !== "object" || body === null) throw new McpRegistryError(400, "Body must be an object");
  const { url, headers } = body as { url?: unknown; headers?: unknown };
  if (typeof url !== "string") throw new McpRegistryError(400, "url is required");
  if (headers === undefined) return { url };
  if (typeof headers !== "object" || headers === null || Object.values(headers).some((value) => typeof value !== "string")) {
    throw new McpRegistryError(400, "headers must map names to strings");
  }
  return { url, headers: headers as Record<string, string> };
}

function resolve(input: McpServerInput, existing: Stored | undefined): Stored {
  let url: URL;
  try {
    url = new URL(existing !== undefined && input.url === maskUrl(existing.url) ? existing.url : input.url);
  } catch {
    throw new McpRegistryError(400, "url is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new McpRegistryError(400, "url must use http or https");
  if ([...url.searchParams.values()].includes(MCP_MASK)) throw new McpRegistryError(400, "url contains a masked value that has no stored original");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!HEADER_NAME.test(name)) throw new McpRegistryError(400, `Invalid header name "${name}"`);
    const kept = value === MCP_MASK ? existing?.headers?.[name] : value;
    if (kept === undefined) throw new McpRegistryError(400, `Header "${name}" has a masked value that has no stored original`);
    headers[name] = kept;
  }
  return { url: url.toString(), ...(Object.keys(headers).length === 0 ? {} : { headers }) };
}

function checkName(name: string, others: Iterable<string>): void {
  if (!MCP_SERVER_NAME.test(name)) throw new McpRegistryError(400, "Server names may contain only letters, digits, _ and -");
  if (PLATFORM_SERVERS.has(same(name))) throw new McpRegistryError(409, `"${name}" is a built-in server`);
  for (const other of others) {
    if (other !== name && same(other) === same(name)) throw new McpRegistryError(409, `"${name}" collides with "${other}"`);
  }
}

async function view(host: RegistryHost, statuses: readonly McpStatus[]): Promise<McpRegistryView> {
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

async function readAuth(host: RegistryHost): Promise<AuthDoc> {
  try {
    return JSON.parse((await mcpStore(host, host.name).readAuth()) ?? "{}") as AuthDoc;
  } catch {
    return {};
  }
}

const writeAuth = (host: RegistryHost, doc: AuthDoc): Promise<void> => mcpStore(host, host.name).writeAuth(`${JSON.stringify(doc, null, 2)}\n`);

function authStore(host: RegistryHost, key: string): McpOAuthStateStore {
  return {
    async load() {
      return (await readAuth(host))[key];
    },
    async save(state) {
      const doc = await readAuth(host);
      doc[key] = state;
      await writeAuth(host, doc);
    },
  };
}

function provider(host: RegistryHost, origin: string, key: string, serverUrl: string, onRedirect: (url: URL) => void): McpOAuthProvider {
  return new McpOAuthProvider({
    serverUrl,
    redirectUrl: `${origin}/api/bots/${host.name}/mcp/callback`,
    clientMetadata: { client_name: "lulu" },
    store: authStore(host, key),
    onRedirect,
  });
}

async function save(host: RegistryHost, hooks: RegistryHooks, name: string, request: Request): Promise<Response> {
  const store = mcpStore(host, host.name);
  const servers = await store.servers();
  checkName(name, Object.keys(servers));
  const body = await request.json().catch(() => {
    throw new McpRegistryError(400, "Body is not valid JSON");
  });
  await store.put(name, resolve(parseInput(body), servers[name]));
  return json(await view(host, await hooks.reload()));
}

async function remove(host: RegistryHost, hooks: RegistryHooks, name: string): Promise<Response> {
  const store = mcpStore(host, host.name);
  await store.remove(name);
  const doc = await readAuth(host);
  const kept = Object.entries(doc).filter(([key]) => key !== `${AUTH_PREFIX}${name}` && !key.startsWith(`${AUTH_PREFIX}${name}|`));
  if (kept.length !== Object.keys(doc).length) await writeAuth(host, Object.fromEntries(kept));
  return json(await view(host, await hooks.reload()));
}

async function login(host: RegistryHost, hooks: RegistryHooks, name: string, origin: string): Promise<Response> {
  const config = (await mcpStore(host, host.name).servers())[name];
  if (config === undefined) throw new McpRegistryError(404, `Unknown server "${name}"`);
  if (Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization")) {
    throw new McpRegistryError(400, "This server sends its own Authorization header");
  }
  let authorizationUrl: URL | undefined = undefined;
  const oauth = provider(host, origin, authKey(name, config.url), config.url, (url) => {
    authorizationUrl = url;
  });
  try {
    if ((await authorizeMcp(oauth, { serverUrl: config.url, skipRefresh: true })) === "AUTHORIZED") {
      return json({ authorized: true, ...(await view(host, await hooks.reload())) });
    }
  } catch (error) {
    throw new McpRegistryError(502, error instanceof Error ? error.message : String(error));
  }
  if (authorizationUrl === undefined) throw new McpRegistryError(502, "The authorization server gave no authorization URL");
  return json({ authorizationUrl: String(authorizationUrl) });
}

async function callback(host: RegistryHost, hooks: RegistryHooks, params: URLSearchParams, origin: string): Promise<Response> {
  const back = (query: Record<string, string>): Response => Response.redirect(`${origin}/mcp?${new URLSearchParams(query)}`, 302);
  const state = params.get("state");
  const code = params.get("code");
  const doc = await readAuth(host);
  const key = state === null || state === "" ? undefined : Object.keys(doc).find((candidate) => doc[candidate]?.oauthState === state);
  const entry = key === undefined ? undefined : doc[key];
  if (key === undefined || entry === undefined) return back({ error: "Unknown or expired sign-in" });
  const name = key.slice(AUTH_PREFIX.length, key.indexOf("|"));
  if (params.has("error")) return back({ error: params.get("error_description") ?? params.get("error") ?? "Sign-in was refused", server: name });
  if (code === null) return back({ error: "The authorization response had no code", server: name });
  try {
    await authorizeMcp(provider(host, origin, key, entry.serverUrl, () => undefined), {
      serverUrl: entry.serverUrl,
      authorizationCode: code,
      ...(params.has("iss") ? { iss: params.get("iss") as string } : {}),
    });
    await hooks.reload();
  } catch (error) {
    return back({ error: error instanceof Error ? error.message : String(error), server: name });
  }
  return back({ login: name });
}

async function route(request: Request, host: RegistryHost, hooks: RegistryHooks): Promise<Response> {
  if (host.env.MCP_ENCRYPTION_KEY === undefined) throw new McpRegistryError(503, "MCP_ENCRYPTION_KEY is not configured");
  const { pathname, origin, searchParams } = new URL(request.url);
  const parts = pathname.split("/").filter((part) => part !== "").slice(1);
  const allow = (...methods: string[]): Response | undefined =>
    methods.includes(request.method) ? undefined : Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: methods.join(", ") } });
  if (parts.length === 0) return allow("GET") ?? json(await view(host, hooks.statuses()));
  if (parts[0] === "reload" && parts.length === 1) return allow("POST") ?? json(await view(host, await hooks.reload()));
  if (parts[0] === "callback" && parts.length === 1) return allow("GET") ?? callback(host, hooks, searchParams, origin);
  const name = parts[1] === undefined ? undefined : decodeURIComponent(parts[1]);
  if (parts[0] !== "servers" || name === undefined) return json({ error: "Not found" }, 404);
  if (parts.length === 2) {
    return allow("PUT", "DELETE") ?? (request.method === "PUT" ? save(host, hooks, name, request) : remove(host, hooks, name));
  }
  if (parts.length === 3 && parts[2] === "login") return allow("POST") ?? login(host, hooks, name, origin);
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
