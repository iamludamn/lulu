import type { Models } from "@earendil-works/pi-ai/models";
import type { Storage } from "@earendil-works/pi-durable";
import { createChatModels } from "../agent/models.js";
import type { DurableHost } from "../host/types.js";
import { MemoryAgent } from "./agent.js";
import { getContext } from "./context.js";
import type { EpisodeSource } from "./doc.js";
import type { MemoryFiles } from "./files.js";
import { legacySource } from "./legacy.js";
import { migrateLegacy } from "./migrate.js";
import { isMemoryFile } from "./paths.js";

const DEBOUNCE_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const CURSOR_KEY = "cursor";
const CONSOLIDATED_KEY = "consolidated";
const LISTING_COMMITS = 20;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class MemoryObject {
  readonly #host: DurableHost;
  readonly #files: MemoryFiles;
  readonly #models: Models;
  #storage!: Storage;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(host: DurableHost, files: MemoryFiles) {
    this.#host = host;
    this.#files = files;
    this.#models = createChatModels(host.env);
  }

  async start(storage: Storage): Promise<void> {
    this.#storage = storage;
    if ((await this.#files.commits(1)).length > 0) return;
    await migrateLegacy(legacySource(this.#host.storage), this.#files);
    await this.#files.commit("初始化记忆\n\nrequestId: migrate");
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/context") return new Response(await getContext(this.#files));
    if (pathname === "/listing") return this.#listing();
    if (pathname === "/file") return this.#file(request);
    if (pathname === "/touch" && request.method === "POST") return this.#touch();
    if (pathname === "/wipe") return this.#wipe();
    return new Response(null, { status: 404 });
  }

  alarm(): Promise<void> {
    return this.#serial(() => this.#scheduled());
  }

  async #listing(): Promise<Response> {
    const [files, commits] = await Promise.all([this.#files.files(), this.#files.commits(LISTING_COMMITS)]);
    return Response.json({ files: files.filter(isMemoryFile), commits });
  }

  async #file(request: Request): Promise<Response> {
    const path = new URL(request.url).searchParams.get("path") ?? "";
    const text = isMemoryFile(path) ? await this.#files.read(path) : undefined;
    return text === undefined ? new Response(null, { status: 404 }) : new Response(text);
  }

  async #touch(): Promise<Response> {
    const due = Date.now() + DEBOUNCE_MS;
    const armed = await this.#host.alarm.get();
    if (armed === null || armed > due) await this.#host.alarm.set(due);
    return new Response(null, { status: 204 });
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(task);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #scheduled(): Promise<void> {
    try {
      await this.#remember();
    } catch (error) {
      console.error(JSON.stringify({ message: "Memory update failed", error: errorText(error) }));
      await this.#host.alarm.set(Date.now() + RETRY_MS);
    }
  }

  async #remember(): Promise<void> {
    const since = (await this.#host.storage.get<number>(CURSOR_KEY)) ?? 0;
    const source = await this.#source(since);
    const date = new Date().toISOString().slice(0, 10);
    const consolidate = (await this.#host.storage.get<string>(CONSOLIDATED_KEY)) !== date;
    if (source.episodes.length === 0 && !consolidate) {
      await this.#host.storage.put({ [CURSOR_KEY]: source.through });
      return;
    }
    const agent = new MemoryAgent({ files: this.#files, models: this.#models, model: source.model, sessionId: this.#host.id });
    await agent.start(this.#storage);
    try {
      await agent.remember(`remember:${since}-${source.through}`, source.episodes, source.through);
      await this.#host.storage.put({ [CURSOR_KEY]: source.through });
      if (consolidate) {
        await agent.consolidate(`consolidate:${date}`);
        await this.#host.storage.put({ [CONSOLIDATED_KEY]: date });
      }
    } finally {
      await agent.close();
    }
  }

  async #source(after: number): Promise<EpisodeSource> {
    const response = await this.#host.objects.BOTS.getByName(this.#host.name).fetch(`https://bot/memory/source?after=${after}`);
    if (!response.ok) throw new Error(`bot source failed (${response.status})`);
    return (await response.json()) as EpisodeSource;
  }

  #wipe(): Promise<Response> {
    return this.#serial(async () => {
      await this.#host.alarm.delete();
      await this.#host.storage.deleteAll();
      return new Response(null, { status: 204 });
    });
  }
}
