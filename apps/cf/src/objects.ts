import { DurableObject } from "cloudflare:workers";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { BotSession } from "@lulu/core/conversation/bot.js";
import { MemoryObject } from "@lulu/core/memory/object.js";
import { ArtifactObject } from "@lulu/core/artifact/object.js";
import { durableHost } from "./host.js";
import { createMemoryFiles } from "./memory-files.js";

export class Bot extends DurableObject<Env> {
  readonly #session: BotSession;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#session = new BotSession(durableHost(ctx, env));
    void ctx.blockConcurrencyWhile(async () => {
      await this.#session.start(await openDurableObjectSqliteStorage(ctx.storage));
    }).then(() => this.#session.recover());
  }

  override fetch(request: Request): Promise<Response> {
    return this.#session.fetch(request);
  }

  override alarm(): Promise<void> {
    return this.#session.alarm();
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.#session.webSocketMessage(socket, message);
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    this.#session.webSocketClose(socket, code, reason);
  }

  override webSocketError(socket: WebSocket): void {
    this.#session.webSocketError(socket);
  }
}

export class Memory extends DurableObject<Env> {
  readonly #memory: MemoryObject;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#memory = new MemoryObject(durableHost(ctx, env), createMemoryFiles(ctx.storage));
    void ctx.blockConcurrencyWhile(async () => this.#memory.start(await openDurableObjectSqliteStorage(ctx.storage), await openDurableObjectSqliteStorage(ctx.storage, { prefix: "memory_retrieval_" })));
  }

  override fetch(request: Request): Promise<Response> {
    return this.#memory.fetch(request);
  }

  override alarm(): Promise<void> {
    return this.#memory.alarm();
  }
}

export class Artifact extends DurableObject<Env> {
  readonly #artifact: ArtifactObject;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#artifact = new ArtifactObject(durableHost(ctx, env));
  }

  override fetch(request: Request): Promise<Response> {
    return this.#artifact.fetch(request);
  }
}
