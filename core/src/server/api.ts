import type { DurableHost } from "../host/types.js";
import { SPACE_ID } from "../protocol/panel.js";

export const BOT_ID = "main";

export type ApiHost = Pick<DurableHost, "env" | "objects" | "telemetry">;

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
  if (request.method === "PUT") return artifacts.fetch(`https://artifact/write?${query}`, { method: "PUT", body: await request.text() });
  return artifacts.fetch(`https://artifact/read?${query}`);
}

function botSocket(request: Request, host: ApiHost): Promise<Response> {
  if (request.method !== "GET") return Promise.resolve(json({ error: "Method not allowed" }, 405, { Allow: "GET" }));
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return Promise.resolve(json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" }));
  }
  return host.objects.BOTS.getByName(BOT_ID).fetch(request);
}

const MCP_CALLBACK = "/mcp/callback";

async function mcpRegistry(request: Request, host: ApiHost, rest: string): Promise<Response> {
  if (rest !== MCP_CALLBACK) {
    const token = host.env.MCP_ADMIN_TOKEN;
    if (token === undefined || token === "") return json({ error: "MCP_ADMIN_TOKEN is not configured" }, 503);
    const given = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!(await tokensMatch(given, token))) return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  }
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

async function route(request: Request, host: ApiHost, pathname: string): Promise<Response> {
  if (!pathname.startsWith(`${PREFIX}/`)) return notFound();
  const rest = pathname.slice(PREFIX.length).replace(/\/+$/, "");
  if (rest === "/ws") return botSocket(request, host);
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
