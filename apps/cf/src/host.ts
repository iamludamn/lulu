import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
import type { DurableHost, DurableSockets, Environment, KeyValue, Socket } from "@lulu/core/host/types.js";
import { createTelemetry } from "@lulu/core/telemetry/otlp.js";
import type { ApiHost } from "@lulu/core/server/api.js";
import { objectStore } from "@lulu/core/artifact/s3.js";
import { startupData, type BotData, type BotDataStore, type StartupData } from "@lulu/core/conversation/bot-data.js";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";

export const stringsOf = (env: Env): Environment =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[0] !== "LULU_CRON_API_TOKEN" && typeof entry[1] === "string"));

const artifactsOf = (ctx: Pick<ExecutionContext, "exports">): DurableHost["objects"]["ARTIFACTS"] => ({
  getByName: (name) => ctx.exports.ArtifactWorker({ props: { name } }),
});

export function botDataOf(env: Environment, telemetry: TelemetryContext, name: string): BotDataStore | undefined {
  const store = objectStore(env, telemetry);
  if (store === undefined) return;
  const path = `metadata/${name}/bot-data.json`;
  const startup = `metadata/${name}/startup.json`;
  return {
    key: env.S3_ENDPOINT + "/" + env.S3_BUCKET + "/" + path,
    read: async () => (await store.readJson<BotData>(path))?.value,
    readStartup: async () => (await store.readJson<StartupData>(startup))?.value,
    async save(value) {
      const [dataTag, startupTag] = await Promise.all([store.etag(path), store.etag(startup)]);
      if (!await store.writeJson(path, value, dataTag)) throw new Error("Bot data changed while publishing");
      if (!await store.writeJson(startup, startupData(value), startupTag)) throw new Error("Startup data changed while publishing");
    },
  };
}

const kvOf = (kv: KVNamespace): KeyValue => ({
  get: (key) => kv.get(key),
  put: (key, value) => kv.put(key, value),
  delete: (key) => kv.delete(key),
  list: async (prefix) => (await kv.list({ prefix })).keys.map((key) => key.name),
});

const socketsOf = (ctx: DurableObjectState): DurableSockets => ({
  all: () => ctx.getWebSockets(),
  attachment: (socket) => (socket as WebSocket).deserializeAttachment(),
  attach: (socket, attachment) => (socket as WebSocket).serializeAttachment(attachment),
  upgrade(attachment) {
    const pair = new WebSocketPair();
    const server = pair[1];
    ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    return { server, response: new Response(null, { status: 101, webSocket: pair[0] }) };
  },
});

const connect: DurableHost["connect"] = async (url, headers, handlers) => {
  const response = await fetch(url, { headers: { Upgrade: "websocket", ...headers } });
  const socket = response.webSocket;
  if (socket === null || socket === undefined) return { status: response.status, socket: undefined };
  socket.accept();
  socket.addEventListener("message", (event) => handlers.message(event.data));
  socket.addEventListener("close", () => handlers.close());
  return { status: response.status, socket: socket as Socket };
};

export function durableHost(ctx: DurableObjectState, env: Env, cronRegistration?: DurableHost["cronRegistration"]): DurableHost {
  const name = ctx.id.name;
  if (name === undefined) throw new Error("Object must be addressed by name");
  const environment = { ...stringsOf(env), LULU_RELEASE: env.CF_VERSION_METADATA?.id };
  const telemetry = createTelemetry(environment, (task) => ctx.waitUntil(task));
  const kv = kvOf(env.LULU_MCP);
  const storage: DurableHost["storage"] = {
    get: <T = unknown>(key: string) => ctx.storage.get<T>(key),
    put: (entries) => ctx.storage.put(entries),
    delete: (keys) => ctx.storage.delete(typeof keys === "string" ? [keys] : keys),
    deleteAll: () => ctx.storage.deleteAll(),
    list: <T = unknown>(options: { prefix: string }) => ctx.storage.list<T>(options),
  };
  return {
    env: environment,
    telemetry,
    decisionModel: env.AI === undefined ? undefined : {
      name: "@cf/cloudflare/clef-flash",
      run: (state, questions, signal) => env.AI!.run("@cf/cloudflare/clef-flash", { model: "clef-flash", state, questions }, { signal }),
    },
    name,
    id: ctx.id.toString(),
    storage,
    alarm: {
      get: () => ctx.storage.getAlarm(),
      set: (time) => ctx.storage.setAlarm(time),
      delete: () => ctx.storage.deleteAlarm(),
    },
    cronRegistration,
    data: botDataOf(environment, telemetry, name),
    sockets: socketsOf(ctx),
    objects: { BOTS: env.BOTS, MEMORY: env.MEMORY, ARTIFACTS: artifactsOf(ctx) },
    kv,
    sandbox: createInlineCodemodeSandbox(),
    connect,
    abort: (reason) => ctx.abort(reason),
  };
}

export function workerHost(env: Env, ctx: ExecutionContext): ApiHost {
  const environment = stringsOf(env);
  const telemetry = createTelemetry(environment, (task) => ctx.waitUntil(task));
  return {
    waitUntil: (task) => ctx.waitUntil(task),
    env: environment,
    kv: kvOf(env.LULU_MCP),
    telemetry,
    data: botDataOf(environment, telemetry, "main"),
    objects: { BOTS: env.BOTS, MEMORY: env.MEMORY, ARTIFACTS: artifactsOf(ctx) },
  };
}
