import { D1Notes } from "./notes.js";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
import type { DurableHost, DurableSockets, Environment, KeyValue, Socket } from "@lulu/core/host/types.js";
import { createTelemetry } from "@lulu/core/telemetry/otlp.js";
import type { ApiHost } from "@lulu/core/server/api.js";
import { objectStore } from "@lulu/core/artifact/s3.js";
import { startupData, type BotData, type BotDataRead, type BotDataStore, type StartupData } from "@lulu/core/conversation/bot-data.js";
import { STORED_DOC_KINDS } from "@lulu/core/durable-names.js";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { D1BotMetadata } from "./bot-metadata.js";

export const stringsOf = (env: Env): Environment =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[0] !== "LULU_CRON_API_TOKEN" && typeof entry[1] === "string"));

const artifactsOf = (ctx: Pick<ExecutionContext, "exports">): DurableHost["objects"]["ARTIFACTS"] => ({
  getByName: (name) => ctx.exports.ArtifactWorker({ props: { name } }),
});

function botDataOf(db: D1Database, env: Environment, telemetry: TelemetryContext, name: string): BotDataStore {
  const bucket = objectStore(env, telemetry);
  const metadata = new D1BotMetadata(db, name, STORED_DOC_KINDS);
  const legacyPath = `metadata/${name}/bot-data.json`;
  const snapshotPath = `metadata/${name}/startup.json`;
  async function read(filter?: BotDataRead): Promise<BotData | undefined> {
    const current = await metadata.read(filter);
    if (current !== undefined || bucket === undefined) return current;
    const legacy = await bucket.readJson<BotData>(legacyPath);
    if (legacy !== undefined) await metadata.write(legacy.value, undefined, true);
    return metadata.read(filter);
  }
  return {
    key: "d1:" + name,
    legacyKey: bucket === undefined ? undefined : env.S3_ENDPOINT + "/" + env.S3_BUCKET + "/" + legacyPath,
    read,
    async readStartup() {
      const snapshot = await bucket?.readJson<StartupData>(snapshotPath);
      if (snapshot !== undefined) return snapshot.value;
      const data = await read();
      return data === undefined ? undefined : startupData(data);
    },
    async save(value, changed) {
      if (changed === undefined || changed.length > 0) await metadata.write(value, changed);
      if (bucket === undefined) return;
      const tag = await bucket.etag(snapshotPath);
      if (!await bucket.writeJson(snapshotPath, startupData(value), tag)) throw new Error("Startup data changed while publishing");
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
    data: botDataOf(env.LULU_METADATA, environment, telemetry, name),
    notes: new D1Notes(env.LULU_METADATA, name),
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
    data: botDataOf(env.LULU_METADATA, environment, telemetry, "main"),
    notes: new D1Notes(env.LULU_METADATA, "main"),
    objects: { BOTS: env.BOTS, MEMORY: env.MEMORY, ARTIFACTS: artifactsOf(ctx) },
  };
}
