import type { DurableHost } from "../host/types.js";
import { SPACE_ID } from "../protocol/panel.js";
import { mcpCatalog } from "./mcp-catalog.js";
import { savedPanel, savedSpace } from "../conversation/bot-data.js";
import { spaceError, spaceRefreshResponse } from "../space/refresh.js";

export const BOT_ID = "main";

export type ApiHost = Pick<DurableHost, "env" | "objects" | "telemetry" | "kv" | "data"> & { waitUntil(task: Promise<unknown>): void };

const PREFIX = `/api/bots/${BOT_ID}`;

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const notFound = (): Response => json({ error: "Not found" }, 404);

const memoryListing = (host: ApiHost): Promise<Response> => host.objects.MEMORY.getByName(BOT_ID).fetch("https://memory/listing");

const memoryFile = (request: Request, host: ApiHost): Promise<Response> => {
  const path = new URL(request.url).searchParams.get("path") ?? "";
  return host.objects.MEMORY.getByName(BOT_ID).fetch(`https://memory/file?path=${encodeURIComponent(path)}`);
};

const schedules = (host: ApiHost): Promise<Response> => host.objects.BOTS.getByName(BOT_ID).fetch("https://bot/schedules");

async function startup(request: Request, host: ApiHost): Promise<Response> {
  if (!await authorizeSocket(request, host.env.LULU_CHAT_TOKEN)) return unauthorized();
  try {
    const data = await host.data?.readStartup();
    if (data !== undefined) return Response.json(data, { headers: { "Cache-Control": "private, no-store" } });
    return await host.objects.BOTS.getByName(BOT_ID).fetch("https://bot/startup");
  } catch (error) {
    console.error("Startup read failed", error);
    return json({ error: "Startup data unavailable" }, 503);
  }
}

async function artifactFile(request: Request, host: ApiHost): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const query = new URLSearchParams({ name: params.get("name") ?? "", version: params.get("version") ?? "" });
  const response = await host.objects.ARTIFACTS.getByName(BOT_ID).fetch(`https://artifact/download?${query}`);
  if (!response.ok) return response;
  return Response.redirect(((await response.json()) as { url: string }).url, 302);
}

async function spaceState(request: Request, host: ApiHost): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!SPACE_ID.test(id)) return json({ error: "Invalid id" }, 400);
  const query = new URLSearchParams({ name: `spaces/${id}/state.json` });
  const artifacts = host.objects.ARTIFACTS.getByName(BOT_ID);
  if (request.method === "PUT") {
    const response = await artifacts.fetch(`https://artifact/write?${query}`, { method: "PUT", body: await request.text() });
    if (response.ok) host.waitUntil(host.objects.BOTS.getByName(BOT_ID).fetch("https://bot/memory/sources.changed", { method: "POST" }).then((result) => { if (!result.ok) throw new Error("Memory source notification rejected"); }).catch(() => console.error("Memory source notification failed")));
    return response;
  }
  return artifacts.fetch(`https://artifact/read?${query}`);
}

async function botSocket(request: Request, host: ApiHost): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
  if (!await authorizeSocket(request, host.env.LULU_CHAT_TOKEN)) return unauthorized();
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" });
  }
  return host.objects.BOTS.getByName(BOT_ID).fetch(request);
}

const MCP_CALLBACK = "/mcp/callback";
const bearer = (request: Request): string => /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1] ?? "";
const unauthorized = (): Response => json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });

export async function authorizeSocket(request: Request, token: string | undefined): Promise<boolean> {
  return token === undefined || (token !== "" && await tokensMatch(bearer(request), token));
}

async function mcpRegistry(request: Request, host: ApiHost, rest: string): Promise<Response> {
  if (rest !== MCP_CALLBACK) {
    const token = host.env.MCP_ADMIN_TOKEN;
    if (token === undefined || token === "") return json({ error: "MCP_ADMIN_TOKEN is not configured" }, 503);
    if (!await tokensMatch(bearer(request), token)) return unauthorized();
  }
  if (rest === "/mcp/catalog") return mcpCatalog(request, host.kv, host.telemetry);
  const url = new URL(request.url);
  url.pathname = rest;
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  return host.objects.BOTS.getByName(BOT_ID).fetch(new Request(url, { method: request.method, headers: request.headers, redirect: "manual", ...(body === undefined ? {} : { body }) }));
}

async function tokensMatch(given: string, expected: string): Promise<boolean> {
  const digest = async (text: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return a.every((byte, index) => byte === b[index]);
}

const reads: Record<string, (request: Request, host: ApiHost) => Promise<Response>> = {
  "/memory": (_request, host) => memoryListing(host),
  "/memory/file": memoryFile,
  "/schedules": (_request, host) => schedules(host),
  "/startup": startup,
  "/artifacts/file": artifactFile,
};

export function handleApi(request: Request, host: ApiHost): Promise<Response> {
  const { pathname } = new URL(request.url);
  return host.telemetry.startSpan(
    { name: `${request.method} api`, attributes: { "http.request.method": request.method, "url.path": pathname } },
    async (span) => {
      const response = await route(request, host, pathname);
      span.setAttributes({ "http.response.status_code": response.status });
      if (response.status >= 500) span.setStatus({ status: "error", error: { name: "HttpError", message: String(response.status) } });
      return response;
    },
  );
}

export function spaceIngress(url: URL, env: DurableHost["env"]): "private" | "webhook" | "none" {
  const publicOrigin = env.LULU_SPACE_WEBHOOK_ORIGIN ? URL.parse(env.LULU_SPACE_WEBHOOK_ORIGIN)?.origin : undefined;
  if (publicOrigin === undefined) return "private";
  const privateOrigin = env.LULU_SPACE_PRIVATE_ORIGIN ? URL.parse(env.LULU_SPACE_PRIVATE_ORIGIN)?.origin : undefined;
  if (url.origin === publicOrigin) return "webhook";
  return url.origin === privateOrigin ? "private" : "none";
}

async function route(request: Request, host: ApiHost, pathname: string): Promise<Response> {
  const ingress = spaceIngress(new URL(request.url), host.env);
  if (ingress === "none") return notFound();
  const webhook = pathname === "/api/webhooks/perplexity" || pathname === "/api/webhooks/context";
  if (webhook || ingress === "webhook") {
    if (!webhook || ingress !== "webhook") return notFound();
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    const query = new URL(request.url).searchParams;
    query.set("provider", pathname.endsWith("/context") ? "context" : "perplexity");
    return host.objects.BOTS.getByName(BOT_ID).fetch("https://bot/space-webhook?" + query, {
      method: "POST", headers: request.headers, body: request.body,
    });
  }
  if (!pathname.startsWith(`${PREFIX}/`)) return notFound();
  const rest = pathname.slice(PREFIX.length).replace(/\/+$/, "");
  if (rest === "/ws") return botSocket(request, host);
  if (rest === "/observability/api/v1/query") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    const token = host.env.LULU_OBSERVABILITY_TOKEN;
    if (!token || !await tokensMatch(bearer(request), token)) return unauthorized();
    const url = new URL(request.url);
    const path = url.searchParams.get("query")?.startsWith("lulu_chat_delivery_window{") ? "/chat-delivery-window" : "/sandbox-window";
    return host.objects.BOTS.getByName(BOT_ID).fetch("https://bot" + path + url.search);
  }
  if (rest === "/spaces/refresh" || rest === "/spaces/device") {
    if (rest === "/spaces/refresh" && request.method === "GET") {
      try {
        const id = new URL(request.url).searchParams.get("id") ?? "";
        const stored = await host.data?.read({ space: id });
        if (stored !== undefined) {
          return spaceRefreshResponse(id, savedPanel(stored), savedSpace(stored, id), host.env);
        }
      } catch (error) { return spaceError(error); }
    }
    const action = rest === "/spaces/refresh" ? "space-refresh" : "space-device";
    return host.objects.BOTS.getByName(BOT_ID).fetch("https://bot/" + action + new URL(request.url).search, {
      method: request.method, headers: request.headers, body: request.body,
    });
  }
  if (rest === "/spaces/state") {
    if (request.method !== "GET" && request.method !== "PUT") return json({ error: "Method not allowed" }, 405, { Allow: "GET, PUT" });
    return spaceState(request, host);
  }
  if (rest === "/mcp" || rest.startsWith("/mcp/")) return mcpRegistry(request, host, rest);
  const read = reads[rest];
  if (read === undefined) return notFound();
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
  return read(request, host);
}
