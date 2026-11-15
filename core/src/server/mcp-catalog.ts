import type { KeyValue } from "../host/types.js";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { McpCatalogHeader, McpCatalogPage, McpCatalogRemote, McpCatalogServer, McpCatalogValue } from "../protocol/mcp.js";
import { serviceFetch, serviceUsage } from "../telemetry/service.js";

const REGISTRY = "https://registry.modelcontextprotocol.io/v0.1/servers";
const MAX_AGE = 60 * 60 * 1000;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

function valueOf(raw: unknown): McpCatalogValue {
  const input = object(raw);
  const choices = Array.isArray(input.choices) ? input.choices.filter((choice): choice is string => typeof choice === "string" && choice !== "") : [];
  return {
    description: text(input.description), default: text(input.default), placeholder: text(input.placeholder), value: text(input.value),
    isRequired: input.isRequired === true, isSecret: input.isSecret === true, format: text(input.format),
    ...(choices.length === 0 ? {} : { choices }),
  };
}

const variablesOf = (raw: unknown): Readonly<Record<string, McpCatalogValue>> => Object.fromEntries(Object.entries(object(raw)).map(([name, value]) => [name, valueOf(value)]));

function remoteOf(raw: unknown): McpCatalogRemote | undefined {
  const remote = object(raw);
  const url = text(remote.url);
  if (remote.type !== "streamable-http" || url === undefined) return undefined;
  try {
    const parsed = new URL(url.replace(/\{[^{}]+\}/g, "example"));
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username !== "" || parsed.password !== "") return undefined;
  } catch { return undefined; }
  const headers: McpCatalogHeader[] = [];
  for (const raw of Array.isArray(remote.headers) ? remote.headers : []) {
    const header = object(raw);
    if (typeof header.name !== "string" || !HEADER_NAME.test(header.name)) return undefined;
    headers.push({ ...valueOf(header), name: header.name, variables: variablesOf(header.variables) });
  }
  return { url, headers, variables: variablesOf(remote.variables) };
}

function serverOf(raw: unknown): McpCatalogServer | undefined {
  const row = object(raw);
  const status = object(object(row._meta)["io.modelcontextprotocol.registry/official"]).status;
  if (status !== "active") return undefined;
  const server = object(row.server);
  if (typeof server.name !== "string") return undefined;
  const remotes = (Array.isArray(server.remotes) ? server.remotes : []).map(remoteOf).filter((remote): remote is McpCatalogRemote => remote !== undefined);
  if (remotes.length === 0) return undefined;
  const websiteUrl = text(server.websiteUrl);
  return {
    name: server.name, title: text(server.title) ?? server.name.split("/").at(-1) ?? server.name,
    description: text(server.description) ?? "", remotes,
    ...(websiteUrl !== undefined && /^https?:\/\//i.test(websiteUrl) ? { websiteUrl } : {}),
  };
}

export async function mcpCatalog(request: Request, kv: KeyValue, telemetry: TelemetryContext): Promise<Response> {
  if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
  const params = new URL(request.url).searchParams;
  const search = (params.get("search") ?? "").trim();
  const cursor = params.get("cursor") ?? "";
  if ((search !== "" && Array.from(search).length < 3) || search.length > 100 || cursor.length > 1024) {
    return Response.json({ error: "请输入至少 3 个字符搜索服务。" }, { status: 400 });
  }
  const query = new URLSearchParams({ version: "latest", limit: "100" });
  if (search !== "") query.set("search", search.toLowerCase());
  if (cursor !== "") query.set("cursor", cursor);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(query.toString()));
  const key = `mcp:catalog:v1:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const stored = await serviceUsage(telemetry, "cloudflare-kv", "get", () => kv.get(key)).catch(() => null);
  let cached: McpCatalogPage | undefined;
  try {
    const parsed = object(stored === null ? undefined : JSON.parse(stored));
    if (Array.isArray(parsed.servers) && typeof parsed.fetchedAt === "number") cached = parsed as unknown as McpCatalogPage;
  } catch { cached = undefined; }
  if (cached !== undefined && Date.now() - cached.fetchedAt < MAX_AGE) return Response.json(cached);
  try {
    const response = await serviceFetch(telemetry, "mcp-registry", "list", () => fetch(`${REGISTRY}?${query}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }));
    if (!response.ok) throw new Error(`Registry HTTP ${response.status}`);
    const data = object(await response.json());
    if (!Array.isArray(data.servers)) throw new Error("Invalid registry response");
    const nextCursor = text(object(data.metadata).nextCursor);
    const page: McpCatalogPage = {
      servers: data.servers.map(serverOf).filter((server): server is McpCatalogServer => server !== undefined),
      ...(nextCursor === undefined || nextCursor === "" ? {} : { nextCursor }), fetchedAt: Date.now(), stale: false,
    };
    await serviceUsage(telemetry, "cloudflare-kv", "put", () => kv.put(key, JSON.stringify(page))).catch(() => undefined);
    return Response.json(page);
  } catch {
    return cached === undefined
      ? Response.json({ error: "暂时无法加载服务目录，请稍后重试或手动添加。" }, { status: 502 })
      : Response.json({ ...cached, stale: true });
  }
}
