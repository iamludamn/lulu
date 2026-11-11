import { MCP_MASK, MCP_SERVER_NAME, type McpServerInput } from "../protocol/mcp.js";
import type { McpServerConfig } from "./mcp.js";

type Stored = Pick<McpServerConfig, "url" | "headers">;

const PLATFORM_SERVERS = new Set(["artifact", "tavily", "exa"]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export class McpRegistryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const same = (name: string): string => name.replaceAll("-", "_");

export function maskUrl(raw: string): string {
  const url = new URL(raw);
  const entries = [...url.searchParams.keys()];
  url.search = "";
  for (const key of entries) url.searchParams.append(key, MCP_MASK);
  return url.toString();
}

export function parseInput(body: unknown): McpServerInput {
  if (typeof body !== "object" || body === null) throw new McpRegistryError(400, "Body must be an object");
  const { url, headers } = body as { url?: unknown; headers?: unknown };
  if (typeof url !== "string") throw new McpRegistryError(400, "url is required");
  if (headers === undefined) return { url };
  if (typeof headers !== "object" || headers === null || Object.values(headers).some((value) => typeof value !== "string")) {
    throw new McpRegistryError(400, "headers must map names to strings");
  }
  return { url, headers: headers as Record<string, string> };
}

export function resolve(input: McpServerInput, existing: Stored | undefined): Stored {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new McpRegistryError(400, "url is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new McpRegistryError(400, "url must use http or https");
  if (url.username !== "" || url.password !== "") throw new McpRegistryError(400, "Use request headers instead of URL credentials");
  const previous = existing === undefined ? undefined : new URL(existing.url);
  const entries = [...url.searchParams];
  url.search = "";
  const positions = new Map<string, number>();
  for (const [key, value] of entries) {
    const index = positions.get(key) ?? 0;
    positions.set(key, index + 1);
    const kept = value === MCP_MASK && previous?.origin === url.origin ? previous.searchParams.getAll(key)[index] : value;
    if (kept === undefined || kept === MCP_MASK) throw new McpRegistryError(400, `Query parameter "${key}" has a masked value that has no stored original on this origin`);
    url.searchParams.append(key, kept);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!HEADER_NAME.test(name)) throw new McpRegistryError(400, `Invalid header name "${name}"`);
    const kept = value === MCP_MASK ? (previous?.origin === url.origin ? Object.entries(existing?.headers ?? {}).find(([header]) => header.toLowerCase() === name.toLowerCase())?.[1] : undefined) : value;
    if (kept === undefined) throw new McpRegistryError(400, `Header "${name}" has a masked value that has no stored original`);
    headers[name] = kept;
  }
  return { url: url.toString(), ...(Object.keys(headers).length === 0 ? {} : { headers }) };
}

export function checkName(name: string, others: Iterable<string>): void {
  if (!MCP_SERVER_NAME.test(name)) throw new McpRegistryError(400, "Server names may contain only letters, digits, _ and -");
  if (PLATFORM_SERVERS.has(same(name))) throw new McpRegistryError(409, `"${name}" is a built-in server`);
  for (const other of others) {
    if (other !== name && same(other) === same(name)) throw new McpRegistryError(409, `"${name}" collides with "${other}"`);
  }
}
