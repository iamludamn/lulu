import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { type Conversation, type ConversationId, type ConversationView, type EntryId, Harness, type Registry, type Storage } from "@earendil-works/pi-durable";
import type { McpHost, McpServerConfig } from "../agent/mcp.js";
import { ChatDoc, linkChatMessage, recordChatMessage, trackProgress, trackSnapshot } from "./progress.js";
import type { EpisodeSource } from "../memory/doc.js";
import { episodesOf } from "../memory/episodes.js";
import type { McpStatus, ModelRef, SessionProgress } from "../protocol/contract.js";
import { DelegateIndex, RunFamily } from "../delegate/runs.js";
import { RECOVERY_ALARM_DELAY_MS, abortRuns, fireSchedules, nextAlarmAt, replaceAlarm, scheduleEntries } from "../cron/alarm.js";
import { CRON_KIND } from "../cron/doc.js";
import { PanelDoc } from "../panel/doc.js";
import { EMPTY_PANEL, type PanelState } from "../protocol/panel.js";
import type { AssetItem } from "../protocol/send.js";
import { AssetsDoc, DeliveryDoc, MakeDoc } from "../send/doc.js";
import { chaseDeliveries } from "../send/delivery.js";
import { keepWidget, orderCards } from "../send/keep.js";
import { MAKE_TIMEOUT_MS, makeOutcome, startMake } from "../send/make.js";
import { VoiceSession } from "./voice.js";
import { MAX_CLIENT_FRAME_CHARACTERS, type ClientMessage, type ServerMessage } from "../protocol/wire.js";
import { parseFrame } from "./frame.js";
import { createChatHarnessOptions, reconnectChatMcp } from "../agent/chat.js";
import { chatModelConfig, chatModelRef, createChatModels, durableModel } from "../agent/models.js";
import { SandboxDoc } from "../sandbox/doc.js";
import { createSandboxProvider } from "../sandbox/provider.js";
import { memoryTouch } from "../memory/client.js";
import { SOCKET_OPEN, type DurableHost, type Socket } from "../host/types.js";

const MEMORY_SOURCE_ENTRIES = 200;
const MODEL_KEY = "model";
const INITIALIZED_KEY = "executor-token";

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
  #view!: AttachedReplicatedState<ConversationView>;
  #models!: Models;
  #selected: ModelRef | undefined;
  #registry: Registry | undefined = undefined;
  #mcpHost: McpHost | undefined = undefined;
  #botServers: Record<string, McpServerConfig> = {};
  #progress: SessionProgress = { messages: [], hiddenEntries: [] };
  #alarmUpdate: Promise<void> = Promise.resolve();
  #prompts: Promise<void> = Promise.resolve();
  readonly #handshakes = new WeakMap<Socket, Promise<boolean>>();
    #panel: PanelState = EMPTY_PANEL;
  #assets: AssetItem[] = [];
  #chasing: Promise<void> = Promise.resolve();
  #settling: Promise<void> = Promise.resolve();
  readonly #makers = new Map<string, { socket: Socket; make: string }>();
  #mcp: McpStatus[] = [];

  readonly #voice: VoiceSession;

  constructor(host: DurableHost) {
    this.#host = host;
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
    const harness = await Harness.open(
      storage,
      {
        ...options,
        onReport: (error) => reportError("Harness background task failed", error),
      },
      BACKGROUND_CONTEXT,
    );
    this.#harness = harness;
    harness.subscribeCommits((publication) => {
      if (publication.changes.some((change) => change.type === "document" && change.record.kind === CRON_KIND)) {
        void this.#refreshAlarm().catch((error: unknown) => reportError("Schedule alarm reconciliation failed", error));
      }
    });

    void harness.closed.then((end) => {
      if (end.reason === "failed") this.#host.abort("Harness failed");
    });
    harness.resume();

    this.#selected = await this.#host.storage.get<ModelRef>(MODEL_KEY);
    const model = chatModelRef(this.#host.env, this.#selected);
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model, thinkingLevel: "off" } });
    await root.configure({ model, tools: null }, BACKGROUND_CONTEXT);
    this.#root = root;

    this.#view = await root.viewState(BACKGROUND_CONTEXT);
    this.#view.subscribe((_value, _context, delivery) => {
      if (delivery.kind === "update") {
        void this.#settleMakes();
        this.#broadcastState();
      }
    });
    trackProgress(
      harness,
      {
        replace: (_context, value) => {
          this.#progress = value;
          void this.#voice.settle().catch((error: unknown) => reportError("Voice settle failed", error));
          this.#chase();
          void this.#settleMakes();
          this.#broadcastState();
        },
      },
      BACKGROUND_CONTEXT,
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
    );
    await harness.commit(async (tx) => {
      const delivery = await tx.doc(DeliveryDoc);
      if (delivery.since !== null) return;
      delivery.since = Math.max(0, ...(await tx.doc(ChatDoc)).messages.map((message) => message.id ?? 0));
    }, BACKGROUND_CONTEXT);
    await this.#refreshAlarm();
  }

  fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/init") return this.#init();
    if (pathname === "/wipe") return this.#wipe();
    if (pathname === "/memory/source") return this.#memorySource(request);
    if (pathname === "/schedules") return this.#schedulesResponse();
    return this.#upgrade();
  }

  alarm(): Promise<void> {
    return this.#runAlarm();
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
      await this.#handle(socket, frame);
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
    this.#host.sockets.attach(socket, { role: "client", ready: true } satisfies ClientAttachment);
    const config = await this.#config();
    this.#send(socket, { type: "models", config });
    this.#send(socket, this.#stateMessage());
    return true;
  }

  #detach(socket: Socket): void {
    this.#voice.detach(socket);
    for (const [requestId, maker] of this.#makers) if (maker.socket === socket) this.#makers.delete(requestId);
  }

  async #handle(socket: Socket, command: Command): Promise<void> {
    switch (command.type) {
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
        this.#send(socket, { type: "result", requestId: command.requestId, ok: true });
        return;
      case "model.select": {
        const selected: ModelRef = command.model;
        const config = await chatModelConfig(this.#models, this.#host.env, selected);
        if (config.model === null) throw new Error("Model is not available");
        await this.#host.storage.put({ [MODEL_KEY]: selected });
        this.#selected = selected;
        await this.#root.configure({ model: durableModel(selected) }, BACKGROUND_CONTEXT);
        this.#broadcast({ type: "models", config });
        this.#send(socket, { type: "result", requestId: command.requestId, ok: true });
        return;
      }
      case "widget.keep":
      case "widget.drop":
        await keepWidget(this.#harness, this.#view.value.entries, command.origin, command.type === "widget.keep");
        this.#send(socket, { type: "result", requestId: command.requestId, ok: true });
        return;
      case "layout.order":
        await orderCards(this.#harness, command.target, command.ids);
        this.#send(socket, { type: "result", requestId: command.requestId, ok: true });
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
    void memoryTouch(this.#host, this.#host.name).catch((error: unknown) => reportError("Memory touch failed", error));
    const content = command.content;
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
    this.#send(socket, { type: "result", requestId: command.requestId, ok: true });
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
    const page = await this.#root.entries(
      { minEntryId: (after + 1) as EntryId, order: "ascending" },
      MEMORY_SOURCE_ENTRIES,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const source: EpisodeSource = {
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

  async #init(): Promise<Response> {
    return this.#host.blockConcurrencyWhile(async () => {
      if (await this.#initialized()) return Response.json({ error: "Bot already initialized" }, { status: 409 });
      await this.#host.storage.put({ [INITIALIZED_KEY]: true });
      return new Response(null, { status: 201 });
    });
  }

  async #wipe(): Promise<Response> {
    for (const socket of this.#host.sockets.all()) socket.close(4404, "Unknown bot");
    await this.#releaseSandboxes().catch((error: unknown) => reportError("Sandbox release failed", error));
    await this.#host.storage.deleteAll();
    return new Response(null, { status: 204 });
  }

  async #releaseSandboxes(): Promise<void> {
    const sandboxes = createSandboxProvider(this.#host.env, this.#host.name);
    if (sandboxes === undefined) return;
    const runs = (await this.#harness.snapshot(DelegateIndex, BACKGROUND_CONTEXT))?.ids ?? [];
    const children = await Promise.all(runs.map(async (id) => (await this.#harness.snapshot(RunFamily, id, BACKGROUND_CONTEXT))?.conversationId ?? null));
    for (const conversationId of [this.#root.id, ...children]) {
      if (conversationId === null) continue;
      const id = (await this.#harness.snapshot(SandboxDoc, conversationId, BACKGROUND_CONTEXT))?.id;
      if (!id) continue;
      await sandboxes.kill(id).catch((error: unknown) => reportError("Sandbox release failed", error, { sandbox: id }));
    }
  }

  async #upgrade(): Promise<Response> {
    const { server, response } = this.#host.sockets.upgrade(idleClient());
    if (!(await this.#initialized())) server.close(4404, "Unknown bot");
    return response;
  }

  async #initialized(): Promise<boolean> {
    return (await this.#host.storage.get(INITIALIZED_KEY)) !== undefined;
  }

  #config() {
    return chatModelConfig(this.#models, this.#host.env, this.#selected);
  }

  #stateMessage(): ServerMessage {
    return {
      type: "state",
      view: this.#view.value,
      progress: this.#progress,
      mcp: this.#mcp,
      panel: this.#panel,
      assets: this.#assets,
    };
  }

  async #reconnectMcp(): Promise<void> {
    const registry = this.#registry;
    const previous = this.#mcpHost;
    if (registry === undefined || previous === undefined) return;
    const reconnected = await reconnectChatMcp(this.#host, registry, previous, this.#botServers);
    this.#mcpHost = reconnected.host;
    this.#mcp = reconnected.statuses;
    this.#broadcastState();
  }

  #broadcastState(): void {
    this.#broadcast(this.#stateMessage());
  }

  #broadcast(message: ServerMessage): void {
    for (const socket of this.#host.sockets.all()) this.#send(socket, message);
  }

  #send(socket: Socket, message: ServerMessage): void {
    if (socket.readyState !== SOCKET_OPEN) return;
    socket.send(JSON.stringify(message));
  }

  #reject(socket: Socket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  async #runAlarm(): Promise<void> {
    const now = Date.now();
    if (this.#registry === undefined) return this.#refreshAlarm();
    const parentId = this.#root.id;
    const selected = chatModelRef(this.#host.env, this.#selected);
    let children: ConversationId[];
    try {
      children = await fireSchedules(this.#harness, parentId, selected, now);
    } catch (error) {
      reportError("Schedule run failed", error);
      await this.#serializeAlarmUpdate(() => replaceAlarm(this.#host.alarm, now + RECOVERY_ALARM_DELAY_MS));
      return;
    }
    await abortRuns(this.#harness, children);
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
