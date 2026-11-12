import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
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
    if (pathname === "/context") return new Response(await getContext(this.#files, this.#host.telemetry));
    if (pathname === "/status") {
      const status = await this.#status();
      return Response.json({ ...status, overdueMs: status.due === undefined ? 0 : Math.max(0, Date.now() - status.due), cursor: (await this.#host.storage.get<number>(CURSOR_KEY)) ?? 0 });
    }
    if (pathname === "/listing") return this.#listing();
    if (pathname === "/file") return this.#file(request);
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
    const [files, commits] = await Promise.all([this.#files.files(), this.#files.commits(LISTING_COMMITS)]);
    return Response.json({ files: files.filter(isMemoryFile), commits });
  }

  async #file(request: Request): Promise<Response> {
    const path = new URL(request.url).searchParams.get("path") ?? "";
    const text = isMemoryFile(path) ? await this.#files.read(path) : undefined;
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
        const opened = new MemoryAgent({ files: this.#files, models: this.#models, model: source.model, sessionId: this.#host.id, botId: this.#host.name, telemetry: span });
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
    const response = await this.#host.objects.BOTS.getByName(this.#host.name).fetch(`https://bot/memory/source?after=${after}&through=${through}`);
    if (!response.ok) throw new Error(`bot source failed (${response.status})`);
    return (await response.json()) as EpisodeSource;
  }
}
