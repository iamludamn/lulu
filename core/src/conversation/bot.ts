import { observeView } from "./view.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { type Conversation, type ConversationView, type EntryId, CompactionEntry, Harness, type Registry, type Storage } from "@earendil-works/pi-durable";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { McpHost, McpServerConfig } from "../agent/mcp.js";
import { handleMcpRegistry } from "../agent/mcp-registry.js";
import { mcpStore } from "../agent/mcp-store.js";
import { ChatDoc, linkChatMessage, recordChatMessage, trackProgress, trackSnapshot } from "./progress.js";
import type { EpisodeSource } from "../memory/doc.js";
import { episodesOf } from "../memory/episodes.js";
import type { McpStatus, ModelRef, SessionProgress } from "../protocol/contract.js";
import { RECOVERY_ALARM_DELAY_MS, type AlarmOutcome, abortRuns, fireSchedules, nextAlarmAt, replaceAlarm, scheduleEntries } from "../cron/alarm.js";
import { CRON_KIND } from "../cron/doc.js";
import { SANDBOX_KIND } from "../sandbox/doc.js";
import { SANDBOX_LIFECYCLE, recoverSandboxLifecycle } from "../sandbox/lifecycle.js";
import { createSandboxProvider } from "../sandbox/backends.js";
import { checkItem } from "../panel/check.js";
import { PanelDoc } from "../panel/doc.js";
import { EMPTY_PANEL, type PanelState } from "../protocol/panel.js";
import type { AssetItem } from "../protocol/send.js";
import { AssetsDoc, DeliveryDoc, MakeDoc } from "../send/doc.js";
import { chaseDeliveries } from "../send/delivery.js";
import { keepWidget, orderCards } from "../send/keep.js";
import { MAKE_TIMEOUT_MS, makeOutcome, startMake } from "../send/make.js";
import { AsrSessions } from "../voice/asr.js";
import { VoiceSession } from "./voice.js";
import { MAX_CLIENT_FRAME_CHARACTERS, type ClientMessage, type ServerMessage } from "../protocol/wire.js";
import { parseFrame } from "./frame.js";
import { createChatHarnessOptions, reconnectChatMcp } from "../agent/chat.js";
import { chatModelConfig, chatModelRef, createChatModels, durableModel } from "../agent/models.js";
import { memoryTelemetry } from "../memory/telemetry.js";
import { createMemoryUpdate, recoverMemoryUpdates, MEMORY_UPDATE } from "../memory/schedule.js";
import { RecallDoc } from "../memory/doc.js";
import { judgeRecall } from "../memory/recall.js";
import { createHarnessTelemetry, observeDelegateTiming } from "../telemetry/agent.js";
import { SOCKET_OPEN, type DurableHost, type Socket } from "../host/types.js";

const MEMORY_SOURCE_ENTRIES = 200;
const RECALL_ENTRIES = 8;
const MODEL_KEY = "model";
const STATE_INTERVAL_MS = 50;
const PROGRESS_WAIT_MS = 500;

type ClientAttachment = { readonly role: "client"; readonly ready: boolean };
type HelloMessage = Extract<ClientMessage, { type: "hello" }>;
type Command = Exclude<ClientMessage, HelloMessage>;

const reportError = (message: string, error: unknown, details: Readonly<Record<string, unknown>> = {}): void => {
  console.error(JSON.stringify({ message, ...details, error: error instanceof Error ? error.message : String(error) }));
};

const idleClient = (): ClientAttachment => ({ role: "client", ready: false });

const isReservedCloseCode = (code: number): boolean => code === 1005 || code === 1006 || code === 1015;

export class BotSession {
  readonly #host: DurableHost;
  #harness!: Harness;
  #root!: Conversation;
  #view!: { readonly value: ConversationView };
  #models!: Models;
  #selected: ModelRef | undefined;
  #registry: Registry | undefined = undefined;
  #mcpHost: McpHost | undefined = undefined;
  #botServers: Record<string, McpServerConfig> = {};
  #progress: SessionProgress = { messages: [], hiddenEntries: [] };
  readonly #sentEntries = new Map<string, string>();
  #sentRest = "";
  #cooling = false;
  #awaiting = false;
  #waitTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  readonly #deferred: Array<() => void> = [];
  #dirty = false;
  #alarmUpdate: Promise<void> = Promise.resolve();
  #prompts: Promise<void> = Promise.resolve();
  readonly #handshakes = new WeakMap<Socket, Promise<boolean>>();
    #panel: PanelState = EMPTY_PANEL;
  #assets: AssetItem[] = [];
  #chasing: Promise<void> = Promise.resolve();
  #settling: Promise<void> = Promise.resolve();
  readonly #makers = new Map<string, { socket: Socket; make: string }>();
  #mcp: McpStatus[] = [];
  #mcpRequests: Promise<unknown> = Promise.resolve();
  #mcpReconnect: Promise<void> = Promise.resolve();

  readonly #voice: VoiceSession;
  readonly #asr: AsrSessions;

  constructor(host: DurableHost) {
    this.#host = host;
    this.#asr = new AsrSessions(host, (socket, event) => this.#send(socket, { type: "voice", event }));
    this.#voice = new VoiceSession({
      host,
      harness: () => this.#harness,
      models: () => this.#models,
      selected: () => this.#selected,
      progress: () => this.#progress,
      entries: () => this.#view.value.entries,
      send: (socket, message) => this.#send(socket, message),
      submit: (socket, command) => this.#handle(socket, command),
    });
  }

  async start(storage: Storage): Promise<void> {
    await this.#initialize(storage);
  }

  recover(): void {
    if (this.#mcp.some((server) => server.state !== "connected")) {
      void this.#reconnectMcp().catch((error: unknown) => reportError("MCP reconnect failed", error));
    }
  }

  async #initialize(storage: Storage): Promise<void> {
    this.#models = createChatModels(this.#host.env);
    const { options, mcp, host, registry, botServers } = await createChatHarnessOptions(this.#host, this.#models);
    this.#botServers = botServers;
    this.#mcp = mcp;
    this.#mcpHost = host;
    this.#registry = registry;
    const telemetry = createHarnessTelemetry(this.#host.telemetry, { "lulu.bot.id": this.#host.name, "lulu.agent": "chat" }, () => this.#root?.id);
    registry.install(telemetry.extension);
    const harness = await Harness.open(
      storage,
      {
        ...options,
        telemetry: telemetry.context,
        onReport: (report) => reportError("Harness background task failed", report.error, { kind: report.kind, ...("reason" in report ? { reason: report.reason } : {}), ...("extension" in report ? { extension: report.extension } : {}) }),
      },
      BACKGROUND_CONTEXT,
    );
    this.#harness = harness;
    observeDelegateTiming(harness, telemetry.context);
    harness.observeCommits({ advance: (publication) => {
      if (publication.changes.some((change) => (change.type === "document" && (change.record.kind === CRON_KIND || change.record.kind === SANDBOX_KIND)) || (change.type === "task" && (change.value.kind === SANDBOX_LIFECYCLE || change.value.kind === MEMORY_UPDATE)))) {
        void this.#refreshAlarm().catch((error: unknown) => reportError("Schedule alarm reconciliation failed", error));
      }
    }, end: () => {} });

    void harness.closed.then((end) => {
      if (end.kind === "failed") this.#host.abort("Harness failed");
    });
    this.#selected = await this.#host.storage.get<ModelRef>(MODEL_KEY);
    const model = chatModelRef(this.#host.env, this.#selected);
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model, thinkingLevel: "off" } });
    await root.configure({ model, tools: null }, BACKGROUND_CONTEXT);
    this.#root = root;
    harness.resume();
    const update = createMemoryUpdate(this.#host);
    harness.observeCommits({ advance: (publication) => {
      if (publication.changes.some((change) => change.type === "entry" && change.value.conversationId === root.id && CompactionEntry.is(change.value))) {
        void recoverMemoryUpdates(harness, root, update).catch((error: unknown) => reportError("Memory compaction scheduling failed", error));
      }
    }, end: () => {} });
    await recoverMemoryUpdates(harness, root, update);
    await recoverSandboxLifecycle(harness, root.id, createSandboxProvider(this.#host.env, this.#host.name, this.#host.telemetry), BACKGROUND_CONTEXT);

    this.#view = await observeView(harness, root, () => {
      void this.#settleMakes();
      this.#broadcastState();
    });
    trackProgress(
      harness,
      {
        pending: () => {
          this.#awaiting = true;
          this.#waitTimer ??= setTimeout(() => {
            this.#waitTimer = undefined;
            this.#awaiting = false;
            this.#broadcastState();
          }, PROGRESS_WAIT_MS);
        },
        replace: (_context, value) => {
          this.#progress = value;
          this.#awaiting = false;
          clearTimeout(this.#waitTimer);
          this.#waitTimer = undefined;
          void this.#voice.settle().catch((error: unknown) => reportError("Voice settle failed", error));
          this.#chase();
          void this.#settleMakes();
          this.#broadcastState();
        },
      },
      () => this.#view.value.entries,
      BACKGROUND_CONTEXT,
      this.#snapshotFailed("progress"),
    );
    trackSnapshot(
      harness,
      async (context) => ({
        panel: (await harness.snapshot(PanelDoc, context)) ?? EMPTY_PANEL,
        assets: (await harness.snapshot(AssetsDoc, context))?.items ?? [],
      }),
      {
        replace: (_context, value) => {
          this.#panel = value.panel;
          this.#assets = value.assets;
          this.#broadcastState();
        },
      },
      BACKGROUND_CONTEXT,
      this.#snapshotFailed("layout"),
      (publication) => publication.changes.some((change) => change.type === "document" && (change.record.kind === PanelDoc.definition.kind || change.record.kind === AssetsDoc.definition.kind)),
    );
    await harness.commit(async (tx) => {
      const delivery = await tx.doc(DeliveryDoc);
      if (delivery.since !== null) return;
      delivery.since = Math.max(0, ...(await tx.doc(ChatDoc)).messages.map((message) => message.id ?? 0));
    }, BACKGROUND_CONTEXT);
    await this.#refreshAlarm();
  }

  #snapshotFailed(snapshot: string): (error: unknown) => void {
    return (error) => {
      reportError("Snapshot refresh failed", error, { snapshot });
      void this.#host.telemetry
        .startSpan({ name: "bot.snapshot", attributes: { "lulu.bot.id": this.#host.name, "lulu.snapshot": snapshot } }, () => Promise.reject(error))
        .catch(() => undefined);
    };
  }

  fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/memory/source") return this.#memorySource(request);
    if (pathname === "/schedules") return this.#schedulesResponse();
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      const next = this.#mcpRequests.then(() => handleMcpRegistry(request, this.#host, { statuses: () => this.#mcp, reload: (name) => this.#reloadMcp(name) }));
      this.#mcpRequests = next.catch(() => undefined);
      return next;
    }
    return Promise.resolve(this.#upgrade());
  }

  alarm(): Promise<void> {
    return this.#host.telemetry.startSpan({ name: "bot.alarm", attributes: { "lulu.bot.id": this.#host.name } }, (span) => this.#runAlarm(span));
  }

  async webSocketMessage(socket: Socket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      this.#reject(socket, 1003, "Binary frames are not supported");
      return;
    }
    const attachment = this.#attachmentOf(socket);
    if (message.length > MAX_CLIENT_FRAME_CHARACTERS) {
      this.#reject(socket, 1009, "Command frame too large");
      return;
    }

    const handshake = this.#handshakes.get(socket);
    if (handshake !== undefined && !(await handshake)) return;

    let frame: ClientMessage;
    try {
      frame = parseFrame(message);
    } catch {
      this.#reject(socket, 1002, "Invalid command frame");
      return;
    }

    if (frame.type === "hello") {
      const next = this.#hello(socket);
      this.#handshakes.set(socket, next);
      await next;
      return;
    }

    if (attachment?.ready !== true) {
      this.#reject(socket, 1008, "Hello required");
      return;
    }

    try {
      await this.#host.telemetry.startSpan(
        { name: `bot.command ${frame.type}`, attributes: { "lulu.bot.id": this.#host.name, "lulu.command": frame.type } },
        (span) => {
          if (frame.type === "prompt.submit") span.setAttributes({ "lulu.prompt.chars": frame.content.length, "lulu.prompt.when_busy": frame.whenBusy });
          return this.#handle(socket, frame);
        },
      );
    } catch (error) {
      reportError("Bot command failed", error, { command: frame.type });
      this.#send(socket, {
        type: "result",
        requestId: frame.requestId,
        ok: false,
        error: error instanceof Error ? error.message : "Command failed",
      });
    }
  }

  webSocketClose(socket: Socket, code: number, reason: string): void {
    this.#detach(socket);
    if (!isReservedCloseCode(code)) socket.close(code, reason);
  }

  webSocketError(socket: Socket): void {
    this.#detach(socket);
  }

  #attachmentOf(socket: Socket): ClientAttachment | null {
    return this.#host.sockets.attachment(socket) as ClientAttachment | null;
  }

  async #hello(socket: Socket): Promise<boolean> {
    const config = await this.#config();
    this.#host.sockets.attach(socket, { role: "client", ready: true } satisfies ClientAttachment);
    this.#send(socket, { type: "models", config });
    this.#send(socket, this.#stateMessage());
    return true;
  }

  #detach(socket: Socket): void {
    this.#voice.detach(socket);
    this.#asr.cancel(socket);
    for (const [requestId, maker] of this.#makers) if (maker.socket === socket) this.#makers.delete(requestId);
  }

  async #handle(socket: Socket, command: Command): Promise<void> {
    switch (command.type) {
      case "asr.start":
        await this.#asr.start(socket, command.requestId);
        this.#acknowledge(socket, command.requestId);
        return;
      case "asr.audio":
        this.#asr.audio(socket, command.requestId, command.audio);
        return;
      case "asr.finish":
        this.#asr.finish(socket, command.requestId);
        return;
      case "asr.cancel":
        this.#asr.cancel(socket, command.requestId);
        return;
      case "voice.start":
        return this.#voice.start(socket, command.requestId);
      case "voice.audio":
        this.#voice.audio(socket, command.audio);
        return;
      case "voice.mute":
        this.#voice.mute(socket, command.muted);
        return;
      case "voice.stop":
        this.#voice.stop(socket, command.requestId);
        return;
      case "prompt.submit":
        return this.#inPromptOrder(() => this.#submitPrompt(socket, command));
      case "prompt.abort":
        await this.#root.abort(BACKGROUND_CONTEXT);
        this.#broadcastState();
        this.#acknowledge(socket, command.requestId);
        return;
      case "model.select": {
        const selected: ModelRef = command.model;
        const config = await chatModelConfig(this.#models, this.#host.env, selected);
        if (config.model === null) throw new Error("Model is not available");
        await this.#host.storage.put({ [MODEL_KEY]: selected });
        this.#selected = selected;
        await this.#root.configure({ model: durableModel(selected) }, BACKGROUND_CONTEXT);
        this.#broadcast({ type: "models", config });
        this.#acknowledge(socket, command.requestId);
        return;
      }
      case "widget.keep":
      case "widget.drop":
        await keepWidget(this.#harness, this.#view.value.entries, command.origin, command.type === "widget.keep");
        this.#acknowledge(socket, command.requestId);
        return;
      case "layout.order":
        await orderCards(this.#harness, command.ids);
        this.#acknowledge(socket, command.requestId);
        return;
      case "widget.check":
        await checkItem(this.#harness, command.id, command.index, command.done);
        this.#acknowledge(socket, command.requestId);
        return;
      case "widget.make": {
        const make = await this.#inPromptOrder(() => startMake(this.#harness, this.#root, this.#view.value.entries, command));
        this.#makers.set(command.requestId, { socket, make: make.requestId });
        setTimeout(() => void this.#settleMakes(), Math.max(0, make.at + MAKE_TIMEOUT_MS - Date.now()) + 100);
        await this.#settleMakes();
        return;
      }
    }
  }

  async #submitPrompt(socket: Socket, command: Extract<Command, { type: "prompt.submit" }>): Promise<void> {
    const content = command.content;
    await this.#recall(command.requestId, content);
    await recordChatMessage(this.#harness, this.#view, command.requestId, content);
    const submission = await this.#root.submit(
      {
        type: "input",
        content,
        requestId: command.requestId,
        whenBusy: command.whenBusy,
      },
      BACKGROUND_CONTEXT,
    );
    await linkChatMessage(this.#harness, command.requestId, submission.id as number);
    void this.#refreshAlarm().catch((error: unknown) => reportError("Prompt alarm reconciliation failed", error));
    this.#broadcastState();
    this.#acknowledge(socket, command.requestId);
  }

  async #recall(requestId: string, content: string): Promise<void> {
    if ((await this.#harness.snapshot(RecallDoc, BACKGROUND_CONTEXT))?.requestId === requestId) return;
    const turns = [...episodesOf(this.#view.value.entries.slice(-RECALL_ENTRIES)), { role: "user" as const, text: content }];
    const decision = await judgeRecall(this.#host.env, memoryTelemetry(this.#host.telemetry, this.#host.name, requestId, String(this.#root.id)), turns);
    await this.#harness.commit(async (tx) => {
      const recall = await tx.doc(RecallDoc);
      recall.requestId = requestId;
      recall.inject = decision.inject;
    }, BACKGROUND_CONTEXT);
  }

  #inPromptOrder<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#prompts.then(task);
    this.#prompts = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #memorySource(request: Request): Promise<Response> {
    const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
    const through = Number(new URL(request.url).searchParams.get("through"));
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(through) || through < after) return new Response(null, { status: 400 });
    const page = await this.#root.entries(
      { minEntryId: (after + 1) as EntryId, maxEntryId: through as EntryId, order: "ascending" },
      MEMORY_SOURCE_ENTRIES,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const source: EpisodeSource = {
      conversationId: String(this.#root.id),
      model: chatModelRef(this.#host.env, this.#selected),
      episodes: episodesOf(page.items),
      through: page.items.at(-1)?.id ?? after,
    };
    return Response.json(source);
  }

  #chase(): void {
    this.#chasing = this.#chasing
      .then(() => chaseDeliveries(this.#harness, this.#root, this.#view.value.entries))
      .catch((error: unknown) => reportError("Delivery check failed", error));
  }

  #settleMakes(): Promise<void> {
    this.#settling = this.#settling
      .then(async () => {
        if (this.#makers.size === 0) return;
        const makes = (await this.#harness.snapshot(MakeDoc, BACKGROUND_CONTEXT))?.makes ?? [];
        for (const [requestId, maker] of [...this.#makers]) {
          const make = makes.find((item) => item.requestId === maker.make);
          const outcome = make === undefined ? { state: "failed" as const, error: "生成记录已丢失" } : await makeOutcome(this.#harness, make, this.#view.value.entries, BACKGROUND_CONTEXT);
          if (outcome.state === "running") continue;
          this.#makers.delete(requestId);
          this.#send(maker.socket, outcome.state === "done" ? { type: "result", requestId, ok: true } : { type: "result", requestId, ok: false, error: outcome.error });
        }
      })
      .catch((error: unknown) => reportError("Widget make settle failed", error));
    return this.#settling;
  }

  #upgrade(): Response {
    return this.#host.sockets.upgrade(idleClient()).response;
  }

  #config() {
    return chatModelConfig(this.#models, this.#host.env, this.#selected);
  }

  #stateMessage(entries: ConversationView["entries"] = this.#view.value.entries): ServerMessage {
    const { conversation, docs, entries: all } = this.#view.value;
    return {
      type: "state",
      view: { conversation, docs, order: all.map((entry) => String(entry.id)), entries },
      progress: this.#progress,
      mcp: this.#mcp,
      panel: this.#panel,
      assets: this.#assets,
    };
  }

  async #reloadMcp(name?: string): Promise<McpStatus[]> {
    this.#botServers = await mcpStore(this.#host, this.#host.name).servers();
    await this.#reconnectMcp(name);
    return this.#mcp;
  }

  #reconnectMcp(name?: string): Promise<void> {
    const next = this.#mcpReconnect.then(() => this.#openMcp(name));
    this.#mcpReconnect = next.catch(() => undefined);
    return next;
  }

  async #openMcp(name?: string): Promise<void> {
    const registry = this.#registry;
    const previous = this.#mcpHost;
    if (registry === undefined || previous === undefined) return;
    const reconnected = await reconnectChatMcp(this.#host, registry, previous, this.#botServers, name === undefined ? undefined : [name]);
    this.#mcpHost = reconnected.host;
    this.#mcp = reconnected.statuses;
    this.#broadcastState();
  }

  #broadcastState(): void {
    if (this.#cooling || this.#awaiting) {
      this.#dirty = true;
      return;
    }
    this.#cooling = true;
    setTimeout(() => {
      this.#cooling = false;
      if (this.#dirty) {
        this.#dirty = false;
        this.#broadcastState();
      }
    }, STATE_INTERVAL_MS);
    this.#publishState();
  }

  #publishState(): void {
    this.#diffAndSend();
    for (const send of this.#deferred.splice(0)) send();
  }

  #diffAndSend(): void {
    const bodies = new Map(this.#view.value.entries.map((entry) => [String(entry.id), JSON.stringify(entry)]));
    const changed = this.#view.value.entries.filter((entry) => this.#sentEntries.get(String(entry.id)) !== bodies.get(String(entry.id)));
    const { view, ...rest } = this.#stateMessage(changed) as Extract<ServerMessage, { type: "state" }>;
    const signature = JSON.stringify({ ...rest, view: { ...view, entries: [] } });
    if (changed.length === 0 && signature === this.#sentRest) return;
    this.#sentEntries.clear();
    for (const [id, body] of bodies) this.#sentEntries.set(id, body);
    this.#sentRest = signature;
    this.#broadcast({ view, ...rest });
  }

  #broadcast(message: ServerMessage): void {
    for (const socket of this.#host.sockets.all()) if (this.#attachmentOf(socket)?.ready === true) this.#send(socket, message);
  }

  #acknowledge(socket: Socket, requestId: string): void {
    this.#send(socket, { type: "result", requestId, ok: true });
  }

  #send(socket: Socket, message: ServerMessage): void {
    if (message.type === "result") {
      if (this.#awaiting) {
        this.#deferred.push(() => this.#send(socket, message));
        return;
      }
      this.#publishState();
    }
    if (socket.readyState !== SOCKET_OPEN) return;
    socket.send(JSON.stringify(message));
  }

  #reject(socket: Socket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  async #runAlarm(span: TelemetrySpan): Promise<void> {
    const now = Date.now();
    if (this.#registry === undefined) return this.#refreshAlarm();
    const parentId = this.#root.id;
    const selected = chatModelRef(this.#host.env, this.#selected);
    let outcome: AlarmOutcome;
    try {
      await recoverMemoryUpdates(this.#harness, this.#root, createMemoryUpdate(this.#host));
      outcome = await fireSchedules(this.#harness, parentId, selected, now);
    } catch (error) {
      reportError("Schedule run failed", error);
      await this.#serializeAlarmUpdate(() => replaceAlarm(this.#host.alarm, now + RECOVERY_ALARM_DELAY_MS));
      return;
    }
    span.setAttributes({ "lulu.cron.fired": outcome.fired.length, "lulu.cron.expired": outcome.expired.length });
    await abortRuns(this.#harness, outcome.expired);
    await this.#refreshAlarm();
  }

  async #schedulesResponse(): Promise<Response> {
    return Response.json(await scheduleEntries(this.#harness));
  }

  #refreshAlarm(): Promise<void> {
    return this.#serializeAlarmUpdate(async () => replaceAlarm(this.#host.alarm, await nextAlarmAt(this.#harness)));
  }

  #serializeAlarmUpdate(operation: () => Promise<void>): Promise<void> {
    const update = this.#alarmUpdate.then(operation, operation);
    this.#alarmUpdate = update;
    return update;
  }
}
