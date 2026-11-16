import { retrieveMemory, type RetrievalInput } from "./retrieval.js";
import { memoryResources } from "./resources.js";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Storage } from "@earendil-works/pi-durable";
import { createChatModels } from "../agent/models.js";
import type { DurableHost } from "../host/types.js";
import { MemoryAgent } from "./agent.js";
import { getContext } from "./context.js";
import type { EpisodeSource, MemorySource } from "./doc.js";
import type { MemoryFiles } from "./files.js";
import { legacySource } from "./legacy.js";
import { migrateLegacy } from "./migrate.js";
import { isMemoryFile } from "./paths.js";
import { memorySpan } from "./telemetry.js";

const RETRY_MS = 60 * 60 * 1000;
const CURSOR_KEY = "cursor";
const CONSOLIDATED_KEY = "consolidated";
const LISTING_COMMITS = 20;

type MemoryStatus = { pendingSince?: number; due?: number; retries: number; lastSuccess?: number; failedStage?: string };
const STATUS_KEY = "memory.status";

export class MemoryObject {
  readonly #host: DurableHost;
  readonly #files: MemoryFiles;
  readonly #models: Models;
  #storage!: Storage;
  #retrievalStorage!: Storage;
  #retrieval: Promise<unknown> = Promise.resolve();
  #chain: Promise<unknown> = Promise.resolve();
  #announcements: Promise<void> = Promise.resolve();

  constructor(host: DurableHost, files: MemoryFiles) {
    this.#host = host;
    this.#files = files;
    this.#models = createChatModels(host.env);
  }

  async start(storage: Storage, retrievalStorage: Storage): Promise<void> {
    this.#storage = storage;
    this.#retrievalStorage = retrievalStorage;
    if ((await this.#files.commits(1)).length > 0) return;
    await migrateLegacy(legacySource(this.#host.storage), this.#files);
    await this.#files.commit("初始化记忆\n\nrequestId: migrate");
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/retrieve" && request.method === "POST") {
      const input = await request.json() as RetrievalInput;
      if (!input.requestId || !Array.isArray(input.catalog) || !Array.isArray(input.turns) || !input.model?.provider || !input.model.modelId) return new Response(null, { status: 400 });
      const run = this.#retrieval.then(() => retrieveMemory(this.#retrievalStorage, this.#models, this.#files, input, this.#host.telemetry));
      this.#retrieval = run.catch(() => undefined);
      return Response.json(await run);
    }
    if (pathname === "/catalog") return Response.json(memoryResources(await this.#files.published()));
    if (pathname === "/context") {
      const snapshot = await this.#files.published();
      return new Response(await getContext({ files: async () => Object.keys(snapshot.files), read: async (path) => snapshot.files[path] }, this.#host.telemetry));
    }
    if (pathname === "/status") {
      const status = await this.#status();
      return Response.json({ ...status, overdueMs: status.due === undefined ? 0 : Math.max(0, Date.now() - status.due), cursor: (await this.#host.storage.get<number>(CURSOR_KEY)) ?? 0 });
    }
    if (pathname === "/listing") return this.#listing();
    if (pathname === "/file") return this.#file(request);
    if (pathname === "/dream" && request.method === "POST") {
      const input = await request.json() as { sources: MemorySource[]; revision: string; sequence: number; model: import("@earendil-works/pi-durable").ModelRef };
      if (!Array.isArray(input.sources) || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || typeof input.revision !== "string" || !input.model?.provider || !input.model.modelId) return new Response(null, { status: 400 });
      const announcement = this.#announcements.then(async () => {
        const seen = await this.#host.storage.get<number>("dreaming.seen") ?? 0;
        if (input.sequence > seen) await this.#host.storage.put({ "dreaming.seen": input.sequence });
      });
      this.#announcements = announcement.catch(() => undefined);
      await announcement;
      return this.#serial(async () => {
        const processed = await this.#host.storage.get<number>("dreaming.sequence") ?? 0;
        const seen = await this.#host.storage.get<number>("dreaming.seen") ?? 0;
        if (input.sequence <= processed || input.sequence < seen) return new Response(null, { status: 204 });
        const agent = new MemoryAgent({ files: this.#files, sources: input.sources, host: this.#host, models: this.#models, model: input.model, sessionId: this.#host.id, botId: this.#host.name, telemetry: this.#host.telemetry });
        try {
          await agent.start(this.#storage);
          await agent.dreamSources(`sources:${input.sequence}:${input.revision}`);
          await this.#host.storage.put({ "dreaming.sequence": input.sequence });
          return new Response(null, { status: 204 });
        } finally { await agent.close(); }
      });
    }
    if (pathname === "/remember" && request.method === "POST") {
      const through = Number(new URL(request.url).searchParams.get("through"));
      if (!Number.isSafeInteger(through) || through <= 0) return new Response(null, { status: 400 });
      return memorySpan(this.#host.telemetry, "memory.update", { "lulu.bot.id": this.#host.name, "lulu.memory.request_id": request.headers.get("x-lulu-request-id") ?? undefined, "lulu.conversation.id": request.headers.get("x-lulu-conversation-id") ?? undefined, "lulu.memory.trigger": "compaction", "lulu.memory.cursor.target": through }, (span) => this.#serial(() => this.#update(span, through)));
    }
    return new Response(null, { status: 404 });
  }

  alarm(): Promise<void> {
    return this.#host.alarm.delete();
  }

  async #listing(): Promise<Response> {
    const [snapshot, commits] = await Promise.all([this.#files.published(), this.#files.commits(LISTING_COMMITS)]);
    return Response.json({ files: Object.keys(snapshot.files).filter(isMemoryFile), commits });
  }

  async #file(request: Request): Promise<Response> {
    const path = new URL(request.url).searchParams.get("path") ?? "";
    const version = new URL(request.url).searchParams.get("version");
    const text = !isMemoryFile(path) ? undefined : version === null ? (await this.#files.published()).files[path] : await this.#files.readVersion(path, version);
    return text === undefined ? new Response(null, { status: 404 }) : new Response(text);
  }

  async #status(): Promise<MemoryStatus> {
    return (await this.#host.storage.get<MemoryStatus>(STATUS_KEY)) ?? { retries: 0 };
  }

  async #saveStatus(entries: Record<string, unknown>): Promise<void> {
    await this.#host.storage.put(entries).catch(() => console.error(JSON.stringify({ message: "Memory diagnostic checkpoint unavailable" })));
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(task);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #update(span: TelemetrySpan, through: number): Promise<Response> {
    const status = await this.#status().catch((): MemoryStatus => ({ retries: 0 }));
    span.setAttributes({ "lulu.memory.retries": status.retries, "lulu.memory.pending_age_ms": status.pendingSince === undefined ? 0 : Date.now() - status.pendingSince, "lulu.memory.overdue_ms": status.due === undefined ? 0 : Math.max(0, Date.now() - status.due), "lulu.memory.last_success": status.lastSuccess });
    let stage = "source";
    try {
      const outcome = await this.#remember(span, through, (value) => { stage = value; });
      await this.#saveStatus({ [STATUS_KEY]: { retries: 0, lastSuccess: Date.now() } });
      span.setAttributes({ "lulu.memory.outcome": outcome });
      return new Response(null, { status: 204 });
    } catch {
      const due = Date.now() + RETRY_MS;
      span.setStatus({ status: "error", error: { name: "MemoryError", message: "memory update failed; retry scheduled" } });
      span.setAttributes({ "lulu.memory.outcome": "failed", "lulu.memory.failure_category": stage, "lulu.memory.retry_at": due, "lulu.memory.retries": status.retries + 1 });
      console.error(JSON.stringify({ message: "Memory update failed", category: "processing", retryAt: due }));
      await this.#saveStatus({ [STATUS_KEY]: { ...status, pendingSince: status.pendingSince ?? Date.now(), due, retries: status.retries + 1, failedStage: stage } });
      return new Response(null, { status: 500 });
    }
  }

  async #remember(span: TelemetrySpan, through: number, stage: (value: string) => void): Promise<"empty" | "success"> {
    let since = (await this.#host.storage.get<number>(CURSOR_KEY)) ?? 0;
    span.setAttributes({ "lulu.memory.cursor.before": since });
    if (since > through) return "empty";
    let agent: MemoryAgent | undefined;
    let episodes = 0;
    let batches = 0;
    const date = new Date().toISOString().slice(0, 10);
    const consolidate = (await this.#host.storage.get<string>(CONSOLIDATED_KEY)) !== date;

    if (since === through && !consolidate) return "empty";
    const openAgent = async (source: EpisodeSource): Promise<MemoryAgent> => {
      if (agent === undefined) {
        stage("agent_start");
        const opened = new MemoryAgent({ sources: [], conversationId: source.conversationId, host: this.#host, files: this.#files, models: this.#models, model: source.model, sessionId: this.#host.id, botId: this.#host.name, telemetry: span });
        await opened.start(this.#storage);
        agent = opened;
      }
      return agent;
    };
    try {
      while (since < through) {
        stage("source");
        const source = await this.#source(since, through);
        if (!Number.isSafeInteger(source.through) || source.through <= since || source.through > through) throw new Error("Memory source did not advance within the compaction boundary");
        span.setAttributes({ "lulu.conversation.id": source.conversationId });
        if (source.episodes.length > 0 || (source.through === through && consolidate)) {
          const current = await openAgent(source);
          stage("remember");
          await current.remember(`remember:${since}-${source.through}`, source.episodes, source.through);
        }
        stage("checkpoint");
        await this.#host.storage.put({ [CURSOR_KEY]: source.through });
        await this.#host.storage.delete(`memory.source:${since}:${through}`).catch(() => console.error("Memory source checkpoint cleanup failed"));
        since = source.through;
        episodes += source.episodes.length;
        batches += 1;
        span.setAttributes({ "lulu.memory.cursor.after": since, "lulu.memory.episodes": episodes, "lulu.memory.batches": batches });
      }
      if (consolidate) {
        const current = agent ?? await openAgent(await this.#source(through, through));
        stage("consolidate");
        await current.consolidate(`consolidate:${date}`);
        await this.#host.storage.put({ [CONSOLIDATED_KEY]: date });
      }
    } finally {
      await agent?.close();
    }
    return "success";
  }

  async #source(after: number, through: number): Promise<EpisodeSource> {
    const key = `memory.source:${after}:${through}`;
    const cached = await this.#host.storage.get<EpisodeSource>(key);
    if (cached) return cached;
    const response = await this.#host.objects.BOTS.getByName(this.#host.name).fetch(`https://bot/memory/source?after=${after}&through=${through}`);
    if (!response.ok) throw new Error(`bot source failed (${response.status})`);
    const source = await response.json() as EpisodeSource;
    await this.#host.storage.put({ [key]: source });
    return source;
  }
}
