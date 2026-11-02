import { botStore, parseBotName, type BotRecord } from "../registry/bots.js";
import type { DurableHost, DurableSockets } from "../host/types.js";

export type ApiHost = Pick<DurableHost, "env" | "objects"> & { readonly sockets: Pick<DurableSockets, "reject"> };

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const botSocketRoute = /^\/api\/bots\/([^/]+)\/ws\/?$/;
const botRoute = /^\/api\/bots\/([^/]+)\/?$/;
const botMemoryRoute = /^\/api\/bots\/([^/]+)\/memory\/?$/;
const botMemoryFileRoute = /^\/api\/bots\/([^/]+)\/memory\/file\/?$/;
const botSchedulesRoute = /^\/api\/bots\/([^/]+)\/schedules\/?$/;
const botArtifactFileRoute = /^\/api\/bots\/([^/]+)\/artifacts\/file\/?$/;
const botIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID_BOT_CLOSE_CODE = 4404;

const DEFAULT_BOT_NAME = "未命名 bot";

const notFound = (): Response => json({ error: "Not found" }, 404);

const readJson = (request: Request): Promise<unknown> => request.json().catch(() => null);

const readName = async (request: Request): Promise<string | undefined> => {
  const body = (await readJson(request)) as { name?: unknown } | null;
  return parseBotName(body?.name);
};

async function knownBot(host: ApiHost, id: string): Promise<Response | undefined> {
  return (await botStore(host).get(id)) === undefined ? notFound() : undefined;
}

async function listBots(host: ApiHost): Promise<Response> {
  return json(await botStore(host).list(), 200);
}

async function createBot(request: Request, host: ApiHost): Promise<Response> {
  const body = (await readJson(request)) as { name?: unknown } | null;
  const name = body?.name === undefined ? DEFAULT_BOT_NAME : parseBotName(body.name);
  if (name === undefined) return json({ error: "Invalid bot name" }, 400);
  const id = crypto.randomUUID();
  const response = await host.objects.BOTS.getByName(id).fetch("https://bot/init", { method: "POST" });
  if (!response.ok) return response;
  const record: BotRecord = { id, name, createdAt: Date.now() };
  await botStore(host).add(record);
  return json(record, 201);
}

async function renameBot(request: Request, host: ApiHost, id: string): Promise<Response> {
  const missing = await knownBot(host, id);
  if (missing !== undefined) return missing;
  const name = await readName(request);
  if (name === undefined) return json({ error: "Invalid bot name" }, 400);
  const updated = await botStore(host).rename(id, name);
  return updated === undefined ? notFound() : json(updated, 200);
}

async function deleteBot(host: ApiHost, id: string): Promise<Response> {
  const missing = await knownBot(host, id);
  if (missing !== undefined) return missing;
  await botStore(host).remove(id);
  const wiped = await host.objects.BOTS.getByName(id).fetch("https://bot/wipe", { method: "POST" });
  await host.objects.MEMORY.getByName(id).fetch("https://memory/wipe", { method: "POST" });
  await host.objects.ARTIFACTS.getByName(id).fetch("https://artifact/wipe", { method: "POST" });
  return wiped.ok ? new Response(null, { status: 204 }) : wiped;
}

async function memoryListing(host: ApiHost, id: string): Promise<Response> {
  const missing = await knownBot(host, id);
  if (missing !== undefined) return missing;
  return host.objects.MEMORY.getByName(id).fetch("https://memory/listing");
}

async function memoryFile(request: Request, host: ApiHost, id: string): Promise<Response> {
  const missing = await knownBot(host, id);
  if (missing !== undefined) return missing;
  const path = new URL(request.url).searchParams.get("path") ?? "";
  return host.objects.MEMORY.getByName(id).fetch(`https://memory/file?path=${encodeURIComponent(path)}`);
}

async function schedulesOf(host: ApiHost, id: string): Promise<Response> {
  const missing = await knownBot(host, id);
  if (missing !== undefined) return missing;
  return host.objects.BOTS.getByName(id).fetch("https://bot/schedules");
}

async function artifactFile(request: Request, host: ApiHost, id: string): Promise<Response> {
  const missing = await knownBot(host, id);
  if (missing !== undefined) return missing;
  const params = new URL(request.url).searchParams;
  const query = new URLSearchParams({ name: params.get("name") ?? "", version: params.get("version") ?? "" });
  const response = await host.objects.ARTIFACTS.getByName(id).fetch(`https://artifact/download?${query}`);
  if (!response.ok) return response;
  return Response.redirect(((await response.json()) as { url: string }).url, 302);
}

async function botSocket(request: Request, host: ApiHost, botId: string): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" });
  }
  if (!botIdPattern.test(botId)) return host.sockets.reject(INVALID_BOT_CLOSE_CODE, "Invalid bot id");
  if ((await botStore(host).get(botId)) === undefined) return host.sockets.reject(INVALID_BOT_CLOSE_CODE, "Unknown bot");
  return host.objects.BOTS.getByName(botId).fetch(request);
}

export async function handleApi(request: Request, host: ApiHost): Promise<Response> {
  const { pathname } = new URL(request.url);

  const socketMatch = botSocketRoute.exec(pathname);
  if (socketMatch !== null) return botSocket(request, host, socketMatch[1]);

  if (pathname === "/api/bots" || pathname === "/api/bots/") {
    if (request.method !== "GET" && request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
    }
    return request.method === "GET" ? listBots(host) : createBot(request, host);
  }

  const memoryMatch = botMemoryRoute.exec(pathname);
  if (memoryMatch !== null) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    const botId = memoryMatch[1];
    if (!botIdPattern.test(botId)) return notFound();
    return memoryListing(host, botId);
  }

  const schedulesMatch = botSchedulesRoute.exec(pathname);
  if (schedulesMatch !== null) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    const botId = schedulesMatch[1];
    if (!botIdPattern.test(botId)) return notFound();
    return schedulesOf(host, botId);
  }

  const artifactFileMatch = botArtifactFileRoute.exec(pathname);
  if (artifactFileMatch !== null) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    const botId = artifactFileMatch[1];
    if (!botIdPattern.test(botId)) return notFound();
    return artifactFile(request, host, botId);
  }

  const memoryFileMatch = botMemoryFileRoute.exec(pathname);
  if (memoryFileMatch !== null) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    const botId = memoryFileMatch[1];
    if (!botIdPattern.test(botId)) return notFound();
    return memoryFile(request, host, botId);
  }

  const botMatch = botRoute.exec(pathname);
  if (botMatch !== null) {
    if (request.method !== "PATCH" && request.method !== "DELETE") {
      return json({ error: "Method not allowed" }, 405, { Allow: "PATCH, DELETE" });
    }
    const botId = botMatch[1];
    if (!botIdPattern.test(botId)) return notFound();
    return request.method === "PATCH" ? renameBot(request, host, botId) : deleteBot(host, botId);
  }

  return notFound();
}
