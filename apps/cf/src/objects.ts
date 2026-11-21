import { DurableObject } from "cloudflare:workers";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { BotSession } from "@lulu/core/conversation/bot.js";
import { MemoryObject } from "@lulu/core/memory/object.js";
import { durableHost } from "./host.js";
import { createMemoryFiles } from "./memory-files.js";
import { cronRegistration } from "./cron.js";

export class Bot extends DurableObject<Env> {
  readonly #session: BotSession;
  #cold = true;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#session = new BotSession(durableHost(ctx, env, cronRegistration(env)));
    void ctx.blockConcurrencyWhile(async () => {
      await this.#session.start(() => openDurableObjectSqliteStorage(ctx.storage));
    }).then(() => this.#session.recover());
  }

  override fetch(request: Request): Promise<Response> {
    this.#cold = false;
    return this.#session.fetch(request);
  }

  override alarm(info?: AlarmInvocationInfo): Promise<void> {
    const cold = this.#cold;
    this.#cold = false;
    return this.#session.alarm(info?.scheduledTime, cold);
  }

  runCron(cron: string, scheduledAt: number): Promise<void> {
    this.#cold = false;
    return this.#session.runCron(cron, scheduledAt);
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.#cold = false;
    return this.#session.webSocketMessage(socket, message);
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    this.#cold = false;
    this.#session.webSocketClose(socket, code, reason);
  }

  override webSocketError(socket: WebSocket): void {
    this.#cold = false;
    this.#session.webSocketError(socket);
  }
}

export class Memory extends DurableObject<Env> {
  readonly #memory: MemoryObject;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#memory = new MemoryObject(durableHost(ctx, env), createMemoryFiles(ctx.storage));
    void ctx.blockConcurrencyWhile(async () => this.#memory.start(await openDurableObjectSqliteStorage(ctx.storage), () => openDurableObjectSqliteStorage(ctx.storage, { prefix: "memory_retrieval_" })));
  }

  override fetch(request: Request): Promise<Response> {
    return this.#memory.fetch(request);
  }

  override alarm(): Promise<void> {
    return this.#memory.alarm();
  }
}

export class Artifact extends DurableObject<Env> {
  async exportMetadata(): Promise<Record<string, unknown>> {
    return Object.fromEntries(await this.ctx.storage.list());
  }
}
