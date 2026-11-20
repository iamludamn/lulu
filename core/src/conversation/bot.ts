import { markDeliveryCancellation, nextDeliveryAlarm, observeDelivery, reconcileDelivery } from "./delivery.js";
import { ChatDeliveryDoc } from "./delivery-doc.js";
import { chatDeliveryQuery } from "./delivery-report.js";
import { SEND_TOOL } from "../protocol/send.js";
import { nextPushAlarm, sendSpacePushes, spaceDevice } from "../space/push.js";
import { handleSpaceRefresh, nextSpaceAlarm, receiveSpaceEvent, refreshDueSpaces, spaceError } from "../space/refresh.js";
import { SpaceRefreshDoc, SpaceRefreshIndex, spaceEntries, spaceStatus } from "../space/doc.js";
import { DreamingTriggerDoc, reconcileDreaming } from "../memory/dreaming.js";
import { admitPrompt, prepareInjection } from "../memory/injection.js";
import { expireRequests, RequestDeadlinesDoc } from "./deadlines.js";
import { RunFamily } from "../delegate/runs.js";
import { entryRange, HISTORY_PAGE_SIZE, observeView } from "./view.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { type Conversation, type ConversationView, type EntryId, CompactionEntry, Harness, type Registry, type Storage } from "@earendil-works/pi-durable";
import type { TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { McpHost, McpServerConfig } from "../agent/mcp.js";
import { handleMcpRegistry } from "../agent/mcp-registry.js";
import { mcpStore } from "../agent/mcp-store.js";
import { ChatDoc, trackProgress, trackSnapshot } from "./progress.js";
import type { EpisodeSource } from "../memory/doc.js";
import { episodesOf } from "../memory/episodes.js";
import type { McpStatus, ModelRef, SessionProgress } from "../protocol/contract.js";
import { abortRuns, fireSchedules, nextScheduleAlarm, scheduleEntries } from "../cron/alarm.js";
import { BotAlarm, RECOVERY_ALARM_DELAY_MS } from "./alarm.js";
import { CRON_KIND } from "../cron/doc.js";
import { withScheduleOverview } from "../cron/overview.js";
import { SANDBOX_KIND } from "../sandbox/doc.js";
import { recoverSandboxLifecycle, staleSandboxTimer } from "../sandbox/lifecycle.js";
import { createSandboxProvider } from "../sandbox/backends.js";
import { observeSandboxActivity } from "../sandbox/activity.js";
import { sandboxWindowQuery } from "../sandbox/report-api.js";
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
import { withoutSchedules } from "./compat.js";
import { createChatHarnessOptions, reconnectChatMcp } from "../agent/chat.js";
import { chatModelConfig, chatModelRef, createChatModels, durableModel } from "../agent/models.js";
import { createMemoryUpdate, recoverMemoryUpdates } from "../memory/schedule.js";
import { createHarnessTelemetry, observeDelegateTiming } from "../telemetry/agent.js";
import { SOCKET_OPEN, type DurableHost, type Socket } from "../host/types.js";
import { authorizeSocket } from "../server/api.js";

const MEMORY_SOURCE_ENTRIES = 200;
const MODEL_KEY = "model";
const STATE_INTERVAL_MS = 50;
const PROGRESS_WAIT_MS = 500;
const ALARM_DOCUMENT_KINDS = new Set([
  CRON_KIND,
  ChatDeliveryDoc.definition.kind,
  DreamingTriggerDoc.definition.kind,
  RequestDeadlinesDoc.definition.kind,
  RunFamily.definition.kind,
  SpaceRefreshDoc.definition.kind,
  SpaceRefreshIndex.definition.kind,
]);

type ClientAttachment = { readonly role: "client"; readonly ready: boolean; readonly incremental?: boolean; readonly schedules?: boolean; readonly authenticated?: boolean };
type HelloMessage = Extract<ClientMessage, { type: "hello" }>;
type ReceiptMessage = Extract<ClientMessage, { type: "prompt.receipts" }>;
type Command = Exclude<ClientMessage, HelloMessage | ReceiptMessage>;

const reportError = (message: string, error: unknown, details: Readonly<Record<string, unknown>> = {}): void => {
  console.error(JSON.stringify({ message, ...details, error: error instanceof Error ? error.message : String(error) }));
};

const isReservedCloseCode = (code: number): boolean => code === 1005 || code === 1006 || code === 1015;

export class BotSession {
  readonly #host: DurableHost;
  #harness!: Harness;
  #root!: Conversation;
  #accountingReady!: () => Promise<void>;
  #view!: { readonly value: ConversationView };
  #models!: Models;
  #selected: ModelRef | undefined;
  #registry: Registry | undefined = undefined;
  #mcpHost: McpHost | undefined = undefined;
  #botServers: Record<string, McpServerConfig> = {};
  #progress: SessionProgress = { messages: [], hiddenEntries: [] };
  readonly #sentEntries = new Map<string, ConversationView["entries"][number]>();
  #sentRest = "";
  #sentOrder: string[] = [];
  #cooling = false;
  #awaiting = false;
  #waitTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  readonly #deferred: Array<() => void> = [];
  #dirty = false;
  #spaceWork: Promise<void> | undefined;
  readonly #alarm: BotAlarm;
  #alarmRetryAt = 0;
  #lastScheduleRunAt = 0;
  #prompts: Promise<void> = Promise.resolve();
  #dreaming: Promise<void> = Promise.resolve();
  readonly #handshakes = new WeakMap<Socket, Promise<boolean>>();
  readonly #transcriptVersions = new WeakMap<ConversationView, Promise<string>>();
  #panel: PanelState = EMPTY_PANEL;
  #assets: AssetItem[] = [];
  #layoutReady = false;
  #chasing: Promise<void> = Promise.resolve();
  #settling: Promise<void> = Promise.resolve();
  readonly #makers = new Map<string, { socket: Socket; make: string }>();
  #mcp: McpStatus[] = [];
  #mcpRequests: Promise<unknown> = Promise.resolve();
  #mcpReconnect: Promise<void> = Promise.resolve();
  #resumeAfterMcp = false;
  #mcpReady: Promise<void> = Promise.resolve();

  readonly #voice: VoiceSession;
  readonly #asr: AsrSessions;

  constructor(host: DurableHost) {
    this.#host = host;
    this.#alarm = new BotAlarm(host.alarm, () => this.#harness.wake(), () => this.#applicationAlarm());
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

  start(openStorage: () => Promise<Storage>): Promise<void> {
    return this.#alarm.run(async () => {
      for (const socket of this.#host.sockets.all()) {
        if (socket.readyState === SOCKET_OPEN && this.#attachmentOf(socket) === null) socket.close(1008, "Reconnect required");
      }
      await this.#initialize(await openStorage());
    });
  }

  recover(): void {
    void this.#reconcileDreaming();
    this.#mcpReady = this.#alarm.run(async () => {
      try {
        await this.#reconnectMcp();
      } catch (error) {
        reportError("MCP reconnect failed", error);
      } finally {
        if (this.#resumeAfterMcp) {
          this.#resumeAfterMcp = false;
          this.#harness.resume();
          this.#chase();
        }
      }
    }).catch((error: unknown) => this.#alarmFailed(error));
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
        onWake: () => { if (this.#harness) this.#alarmChanged(); },
        onReport: (report) => reportError("Harness background task failed", report.error, { kind: report.kind, ...("reason" in report ? { reason: report.reason } : {}), ...("extension" in report ? { extension: report.extension } : {}) }),
      },
      BACKGROUND_CONTEXT,
    );
    this.#harness = harness;
    observeDelegateTiming(harness, telemetry.context);
    harness.observeCommits({ advance: (publication) => {
      if (publication.changes.some((change) => change.type === "document" && (change.record.kind === PanelDoc.definition.kind || change.record.kind === AssetsDoc.definition.kind))) void this.#reconcileDreaming();
      if (publication.changes.some((change) => change.type === "submission" || (change.type === "document" && ALARM_DOCUMENT_KINDS.has(change.record.kind)))) this.#alarmChanged();
    }, end: () => {} });

    void harness.closed.then((end) => {
      if (end.kind === "failed") this.#host.abort("Harness failed");
    });
    this.#selected = await this.#host.storage.get<ModelRef>(MODEL_KEY);
    const model = chatModelRef(this.#host.env, this.#selected);
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model, thinkingLevel: "off" } });
    await root.configure({ model, tools: null }, BACKGROUND_CONTEXT);
    this.#root = root;
    harness.observeCommits({ advance: ({ changes }) => {
      if (changes.some((change) =>
        (change.type === "submission" && change.value.conversationId === root.id && change.value.status === "unanswered") ||
        (change.type === "entry" && change.value.conversationId === root.id &&
          change.value.model?.some((message) => message.role === "toolResult" && message.toolName === SEND_TOOL && !message.isError))
      )) void this.#updateDelivery().catch((error: unknown) => reportError("Chat delivery reconciliation failed", error));
    }, end: () => {} });
    if (await harness.snapshot(ChatDeliveryDoc, BACKGROUND_CONTEXT)) await this.#updateDelivery();
    this.#accountingReady = await observeSandboxActivity(harness, root.id, telemetry.context, BACKGROUND_CONTEXT);
    this.#resumeAfterMcp = !host.catalogReady;
    if (!this.#resumeAfterMcp) harness.resume();
    const update = createMemoryUpdate(this.#host);
    harness.observeCommits({ advance: (publication) => {
      if (publication.changes.some((change) => change.type === "entry" && change.value.conversationId === root.id && CompactionEntry.is(change.value))) {
        void this.#alarm.run(() => recoverMemoryUpdates(harness, root, update)).catch((error: unknown) => reportError("Memory compaction scheduling failed", error));
      }
      if (publication.changes.some((change) => change.type === "document" && change.record.kind === SANDBOX_KIND && change.conversationId === root.id)) {
        void Promise.resolve().then(async () => {
          const timer = await staleSandboxTimer(harness, root.id, BACKGROUND_CONTEXT);
          if (timer !== undefined) await this.#alarm.run(() => harness.abortTask(timer, BACKGROUND_CONTEXT));
        }).catch((error: unknown) => this.#alarmFailed(error));
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
      root.id,
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
    const layoutReady = new Promise<void>((resolve, reject) => trackSnapshot(
      harness,
      async (context) => {
        const panel = await withScheduleOverview(harness, (await harness.snapshot(PanelDoc, context)) ?? EMPTY_PANEL, context);
        const spaces = await spaceEntries(harness, panel.order.filter((id) => ["space", "web"].includes(panel.widgets[id]?.body.kind ?? "")));
        const spaceUpdates = Object.fromEntries(spaces
          .map(([id, entry]) => [id, spaceStatus(entry)]));
        return { panel: { ...panel, spaceUpdates }, assets: (await harness.snapshot(AssetsDoc, context))?.items ?? [] };
      },
      {
        replace: (_context, value) => {
          this.#panel = value.panel;
          this.#assets = value.assets;
          this.#layoutReady = true;
          resolve();
          this.#broadcastState();
        },
      },
      BACKGROUND_CONTEXT,
      (error) => {
        this.#snapshotFailed("layout")(error);
        reject(error);
      },
      (publication) => publication.changes.some((change) => change.type === "document" && (change.record.kind === PanelDoc.definition.kind || change.record.kind === AssetsDoc.definition.kind || change.record.kind === SpaceRefreshDoc.definition.kind || change.record.kind === CRON_KIND)),
    ));
    await Promise.all([layoutReady, harness.commit(async (tx) => {
      const delivery = await tx.doc(DeliveryDoc);
      if (delivery.since !== null) return;
      delivery.since = Math.max(0, ...(await tx.doc(ChatDoc)).messages.map((message) => message.id ?? 0));
    }, BACKGROUND_CONTEXT)]);
  }

  #reconcileDreaming(): Promise<void> {
    this.#dreaming = this.#dreaming.then(() => this.#alarm.run(() => reconcileDreaming(this.#harness, this.#host, chatModelRef(this.#host.env, this.#selected)))).catch((error: unknown) => {
      reportError("Source dreaming reconciliation failed", error);
      return this.#alarm.refresh();
    });
    return this.#dreaming;
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
    if (pathname === "/chat-delivery-window") return chatDeliveryQuery(request, this.#harness);
    if (pathname === "/sandbox-window") return this.#accountingReady().then(() => sandboxWindowQuery(request, this.#harness, BACKGROUND_CONTEXT));
    if (pathname === "/memory/sources.changed" && request.method === "POST") return this.#reconcileDreaming().then(() => new Response(null, { status: 204 }));
    if (pathname === "/memory/source") return this.#memorySource(request);
    if (pathname === "/space-refresh" || pathname === "/space-webhook" || pathname === "/space-device") {
      if (pathname === "/space-webhook" && request.method !== "POST") return Promise.resolve(new Response(null, { status: 405 }));
      const handler = pathname === "/space-webhook" ? receiveSpaceEvent : pathname === "/space-device" ? spaceDevice : handleSpaceRefresh;
      const handle = () => handler(this.#harness, request, this.#host.env);
      return (request.method === "POST" ? this.#alarm.run(handle) : handle()).catch(spaceError);
    }
    if (pathname === "/schedules") return this.#schedulesResponse();
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      const next = this.#mcpRequests.then(() => handleMcpRegistry(request, this.#host, { statuses: () => this.#mcp, reload: (name) => this.#reloadMcp(name) }));
      this.#mcpRequests = next.catch(() => undefined);
      return next;
    }
    return this.#upgrade(request);
  }

  alarm(scheduledAt?: number, coldStart = false): Promise<void> {
    const delay = scheduledAt !== undefined && Number.isFinite(scheduledAt) ? Math.max(0, Date.now() - scheduledAt) : undefined;
    if (delay !== undefined) {
      this.#host.telemetry.metrics?.histogram("lulu.bot.alarm.wake_delay", { unit: "ms" }).record(delay, { "lulu.alarm.cold_start": coldStart });
    }
    const attributes = {
      "lulu.bot.id": this.#host.name,
      "lulu.alarm.cold_start": coldStart,
      "lulu.alarm.wake_delay_ms": delay,
    };
    return this.#host.telemetry.startSpan({ name: "bot.alarm", attributes }, (span) => this.#alarm.run(() => this.#runAlarm(span)));
  }

  async webSocketMessage(socket: Socket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      this.#reject(socket, 1003, "Binary frames are not supported");
      return;
    }
    const attachment = this.#attachmentOf(socket);
    if (attachment === null) {
      this.#reject(socket, 1008, "Reconnect required");
      return;
    }
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
      const next = this.#hello(socket, attachment, frame);
      this.#handshakes.set(socket, next);
      await next;
      return;
    }

    if (this.#attachmentOf(socket)?.ready !== true) {
      this.#reject(socket, 1008, "Hello required");
      return;
    }

    if (frame.type === "prompt.receipts") {
      await this.#updateDelivery(frame).catch((error: unknown) => {
        reportError("Chat receipt commit failed", error);
        socket.close(1011, "Retry delivery receipts");
      });
      return;
    }

    try {
      await this.#host.telemetry.startSpan(
        { name: `bot.command ${frame.type}`, attributes: { "lulu.bot.id": this.#host.name, "lulu.command": frame.type } },
        (span) => {
          if (frame.type === "prompt.submit") span.setAttributes({ "lulu.prompt.chars": frame.content.length, "lulu.prompt.when_busy": frame.whenBusy });
          return this.#handle(socket, frame, span);
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
    const attachment = this.#host.sockets.attachment(socket) as ClientAttachment | null;
    if (this.#host.env.LULU_CHAT_TOKEN !== undefined && attachment?.authenticated !== true) return null;
    return attachment;
  }

  async #hello(socket: Socket, attachment: ClientAttachment, hello: HelloMessage): Promise<boolean> {
    const config = await this.#config();
    const view = this.#view.value;
    const version = hello.transcriptVersion === undefined ? undefined : await this.#transcriptVersion(view);
    const currentVersion = this.#view.value === view ? version : undefined;
    const resumed = currentVersion !== undefined && currentVersion === hello.transcriptVersion;
    const state = this.#stateMessage(resumed ? [] : undefined, !resumed);
    if (currentVersion !== undefined) state.view.transcriptVersion = currentVersion;
    this.#host.sockets.attach(socket, { ...attachment, ready: true, incremental: hello.incremental === true, schedules: hello.schedules === true } satisfies ClientAttachment);
    this.#send(socket, { type: "models", config });
    this.#send(socket, state);
    return true;
  }

  #transcriptVersion(view: ConversationView): Promise<string> {
    let version = this.#transcriptVersions.get(view);
    if (version === undefined) {
      const bytes = new TextEncoder().encode(JSON.stringify([view.conversation, view.entries]));
      version = crypto.subtle.digest("SHA-256", bytes).then((digest) =>
        Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
      this.#transcriptVersions.set(view, version);
    }
    return version;
  }

  #detach(socket: Socket): void {
    this.#voice.detach(socket);
    this.#asr.cancel(socket);
    for (const [requestId, maker] of this.#makers) if (maker.socket === socket) this.#makers.delete(requestId);
  }

  async #handle(socket: Socket, command: Command, telemetry: TelemetryContext = this.#host.telemetry): Promise<void> {
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
      case "history.load": {
        const page = await this.#root.entries({ maxEntryId: (command.before - 1) as EntryId }, HISTORY_PAGE_SIZE + 1, undefined, BACKGROUND_CONTEXT);
        const items = [...page.items];
        const earlier = items.length > HISTORY_PAGE_SIZE ? Number(items.pop()!.id) : null;
        this.#send(socket, { type: "history", entries: items.reverse(), before: earlier });
        this.#acknowledge(socket, command.requestId);
        return;
      }
      case "prompt.submit": {
        const queuedAt = Date.now();
        const release = this.#host.env.LULU_RELEASE ?? "unknown";
        return telemetry.startSpan({
          name: "chat.delivery.received",
          attributes: {
            "lulu.bot.id": this.#host.name, "lulu.request.id": command.requestId, "lulu.release": release,
            "lulu.prompt.chars": command.content.length, "lulu.prompt.when_busy": command.whenBusy,
          },
        }, (received) => received.startSpan({ name: "prompt.admission", attributes: {
          "lulu.bot.id": this.#host.name, "lulu.agent": "chat", "lulu.conversation.id": String(this.#root.id), "lulu.conversation.kind": "root",
          "lulu.memory.request_id": command.requestId,
        } }, (span) => this.#inPromptOrder(() => this.#submitPrompt(socket, command, { release, received, span, queuedAt }))));
      }
      case "prompt.abort":
        return this.#inPromptOrder(async () => {
          if (this.#resumeAfterMcp) await this.#mcpReady;
          await this.#alarm.run(async () => {
            await markDeliveryCancellation(this.#harness);
            await this.#root.abort(BACKGROUND_CONTEXT);
          });
          this.#broadcastState();
          this.#acknowledge(socket, command.requestId);
        });
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
      case "widget.drop": {
        const keep = command.type === "widget.keep";
        const entries = keep ? await entryRange(this.#root, 0, undefined, BACKGROUND_CONTEXT) : [];
        await this.#alarm.run(() => keepWidget(this.#harness, entries, command.origin, keep, command.requestId));
        this.#acknowledge(socket, command.requestId);
        return;
      }
      case "layout.order":
        await this.#alarm.run(() => orderCards(this.#harness, command.ids));
        this.#acknowledge(socket, command.requestId);
        return;
      case "widget.check":
        await checkItem(this.#harness, command.id, command.index, command.done);
        this.#acknowledge(socket, command.requestId);
        return;
      case "widget.make": {
        if (this.#resumeAfterMcp) await this.#mcpReady;
        const make = await this.#inPromptOrder(async () => {
          const entries = await entryRange(this.#root, 0, undefined, BACKGROUND_CONTEXT);
          return this.#alarm.run(() => startMake(this.#harness, this.#root, entries, command));
        });
        this.#makers.set(command.requestId, { socket, make: make.requestId });
        setTimeout(() => void this.#settleMakes(), Math.max(0, make.at + MAKE_TIMEOUT_MS - Date.now()) + 100);
        await this.#settleMakes();
        return;
      }
    }
  }

  async #submitPrompt(socket: Socket, command: Extract<Command, { type: "prompt.submit" }>, timing: { release: string; received: TelemetrySpan; span: TelemetrySpan; queuedAt: number }): Promise<void> {
    const { release, received, span, queuedAt } = timing;
    span.setAttributes({ "lulu.prompt.queue_ms": Date.now() - queuedAt });
    const injection = await prepareInjection(this.#host, this.#harness, command.requestId, command.content, this.#view.value, chatModelRef(this.#host.env, this.#selected), span);
    span.setAttributes({ "lulu.prompt.memory_ready_ms": Date.now() - queuedAt });
    if (this.#resumeAfterMcp) await this.#mcpReady;
    const { request, firstBinding } = await this.#alarm.run(() => admitPrompt(this.#harness, this.#root, this.#view.value, command, injection, { release, span: received }));
    span.setAttributes({ "lulu.prompt.admission_ms": Date.now() - queuedAt, "lulu.prompt.replay": !firstBinding, "lulu.memory.outcome": injection.outcome, "lulu.memory.selected": injection.selected.length });
    if (request) observeDelivery(this.#host.telemetry, this.#host.name, { request, stage: "accepted", at: request.acceptedAt });
    else received.setAttributes({ "lulu.delivery.replayed": true });
    this.#broadcastState();
    this.#acknowledge(socket, command.requestId);
  }

  async #updateDelivery(receipt?: ReceiptMessage): Promise<void> {
    for (const event of await reconcileDelivery(this.#harness, this.#root, Date.now(), receipt)) {
      observeDelivery(this.#host.telemetry, this.#host.name, event);
    }
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
    if (this.#resumeAfterMcp) return;
    this.#chasing = this.#chasing
      .then(() => chaseDeliveries(this.#harness, this.#root, this.#view.value.entries, (work) => this.#alarm.run(work)))
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

  async #upgrade(request: Request): Promise<Response> {
    if (!await authorizeSocket(request, this.#host.env.LULU_CHAT_TOKEN)) return new Response(null, { status: 401 });
    return this.#host.sockets.upgrade({ role: "client", ready: false, authenticated: this.#host.env.LULU_CHAT_TOKEN !== undefined } satisfies ClientAttachment).response;
  }

  #config() {
    return chatModelConfig(this.#models, this.#host.env, this.#selected);
  }

  #stateMessage(entries: ConversationView["entries"] = this.#view.value.entries, reset = false): Extract<ServerMessage, { type: "state" }> {
    const { conversation, docs, before, entries: all } = this.#view.value;
    return {
      type: "state",
      view: { conversation, docs, before, deliveryReceipts: true, ...(reset ? { reset: true } : {}), order: all.map((entry) => String(entry.id)), entries },
      progress: this.#progress,
      mcp: this.#mcp,
      panel: this.#panel,
      assets: this.#assets,
    };
  }

  async #reloadMcp(name?: string): Promise<McpStatus[]> {
    this.#botServers = await mcpStore(this.#host).servers();
    await this.#alarm.run(() => this.#reconnectMcp(name));
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
    if (!this.#layoutReady) return;
    const all = this.#view.value.entries;
    const changed = all.filter((entry) => this.#sentEntries.get(String(entry.id)) !== entry);
    const { view, ...rest } = this.#stateMessage(changed);
    const order = view.order!;
    const orderChanged = order.length !== this.#sentOrder.length || order.some((id, index) => id !== this.#sentOrder[index]);
    const signature = JSON.stringify({ ...rest, view: { ...view, order: undefined, entries: [] } });
    if (changed.length === 0 && !orderChanged && signature === this.#sentRest) return;
    this.#sentEntries.clear();
    for (const entry of all) this.#sentEntries.set(String(entry.id), entry);
    this.#sentOrder = order;
    if (!orderChanged) delete view.order;
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
    if (message.type === "state" && message.view.order === undefined && this.#attachmentOf(socket)?.incremental !== true) {
      message = { ...message, view: { ...message.view, order: this.#view.value.entries.map((entry) => String(entry.id)) } };
    }
    if (message.type === "state" && this.#attachmentOf(socket)?.incremental !== true) {
      message = { ...message, mcp: message.mcp.map((server) => server.state === "idle" ? { ...server, state: "failed", error: "Preparing tools" } : server) };
    }
    if (this.#attachmentOf(socket)?.schedules !== true) message = withoutSchedules(message);
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      reportError("Socket delivery failed", error);
      this.#reject(socket, 1011, "Reconnect to recover state");
    }
  }

  #reject(socket: Socket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  async #runAlarm(span: TelemetrySpan): Promise<void> {
    if (this.#resumeAfterMcp) await this.#mcpReady;
    const now = Date.now();
    this.#harness.resume();
    const selected = chatModelRef(this.#host.env, this.#selected);
    try {
      await this.#reconcileDreaming();
      await expireRequests(this.#harness, this.#root, now);
      await this.#updateDelivery();
      await recoverMemoryUpdates(this.#harness, this.#root, createMemoryUpdate(this.#host));
      const outcome = await fireSchedules(this.#harness, this.#root, selected, now);
      this.#lastScheduleRunAt = now;
      span.setAttributes({ "lulu.cron.fired": outcome.fired.length, "lulu.cron.expired": outcome.expired.length });
      await abortRuns(this.#harness, outcome.expired);
      this.#spaceWork ??= refreshDueSpaces(this.#harness, this.#host.env, now).then(() => sendSpacePushes(this.#harness, this.#host.env, Date.now())).finally(() => { this.#spaceWork = undefined; });
      await this.#spaceWork;
      this.#alarmRetryAt = 0;
    } catch (error) {
      reportError("Schedule run failed", error);
      this.#alarmRetryAt = Date.now() + RECOVERY_ALARM_DELAY_MS;
    }
  }

  async #schedulesResponse(): Promise<Response> {
    return Response.json(await scheduleEntries(this.#harness));
  }

  async #applicationAlarm(): Promise<number> {
    const now = Date.now();
    const deadlines = await Promise.all([
      nextScheduleAlarm(this.#harness, this.#lastScheduleRunAt),
      nextSpaceAlarm(this.#harness),
      nextPushAlarm(this.#harness, this.#host.env),
      nextDeliveryAlarm(this.#harness),
    ]);
    return Math.min(this.#alarmRetryAt || Infinity, ...deadlines.map((at) => at === undefined ? Infinity : at > now ? at : Math.max(now + 1000, this.#alarmRetryAt)));
  }

  #alarmChanged(): void {
    void this.#alarm.refresh().catch((error: unknown) => this.#alarmFailed(error));
  }

  #alarmFailed(error: unknown): void {
    reportError("Alarm reconciliation failed", error);
    this.#host.abort("Alarm reconciliation failed");
  }
}
