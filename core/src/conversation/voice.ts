import { meteredVoiceConnect } from "../voice/usage.js";
import { recordModelUsage } from "../telemetry/model.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ConversationView, Harness } from "@earendil-works/pi-durable";
import { chatModelRef } from "../agent/models.js";
import type { DurableHost, Socket } from "../host/types.js";
import type { MessageProgress, ModelRef, SessionProgress } from "../protocol/contract.js";
import type { ClientMessage, ServerMessage } from "../protocol/wire.js";
import { spokenText, sentIn } from "../send/sent.js";
import type { Written } from "../voice/call.js";
import type { Update, Writer } from "../voice/line.js";
import { VoiceRelay, type TaskStatus } from "../voice/relay.js";
import type { Endpoint } from "../voice/transport.js";
import { ChatDoc } from "./progress.js";

export const VOICE_ENDPOINT = "https://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue";
export const VOICE_RESOURCE_ID = "volc.speech.dialog";
const VOICE_MAX_MS = 10 * 60 * 1000;
const VOICE_WRITTEN_LIMIT = 8;
const VOICE_WRITER_PROMPT =
  "你是电话里的助手，要把后台任务的进展用口语转告给用户。输入是一个 JSON 数组，每项是一条进展。用第一人称、普通话，一到两句话，先说结果。不要照念原文字段，不要说工具名、编号、路径、时间。只输出要说的话。";
const VOICE_DEFAULT_NAMES = { agent: "assistant", user: "there" };

export const REPORT_CALL = "call";

export const voiceWriter = (env: DurableHost["env"], writer: Writer): Writer | undefined => (env.DOUBAO_REPORT === REPORT_CALL ? undefined : writer);

export const voiceEndpoint = (env: DurableHost["env"]): Endpoint => ({
  url: env.DOUBAO_WS_URL ?? VOICE_ENDPOINT,
  headers: { "X-Api-Key": env.DOUBAO_API_KEY ?? "", "X-Api-Resource-Id": VOICE_RESOURCE_ID },
});

export type PromptSubmit = Extract<ClientMessage, { type: "prompt.submit" }>;

export type VoiceDeps = {
  readonly host: DurableHost;
  readonly harness: () => Harness;
  readonly models: () => Models;
  readonly selected: () => ModelRef | undefined;
  readonly progress: () => SessionProgress;
  readonly entries: () => ConversationView["entries"];
  readonly send: (socket: Socket, message: ServerMessage) => void;
  readonly submit: (socket: Socket, command: PromptSubmit) => Promise<void>;
};

export class VoiceSession {
  readonly #deps: VoiceDeps;
  readonly #voices = new Map<Socket, VoiceRelay>();
  readonly #delivered = new Map<Socket, Set<number>>();
  readonly #watchers = new Map<string, Array<(status: TaskStatus) => void>>();

  constructor(deps: VoiceDeps) {
    this.#deps = deps;
  }

  async start(socket: Socket, requestId: string): Promise<void> {
    const host = this.#deps.host;
    const apiKey = host.env.DOUBAO_API_KEY;
    if (apiKey === undefined) throw new Error("Voice is not configured");
    if (this.#voices.has(socket)) throw new Error("Voice is already running");
    const relay = new VoiceRelay(
      {
        agentName: VOICE_DEFAULT_NAMES.agent,
        userName: VOICE_DEFAULT_NAMES.user,
        send: (event) => {
          if (event.type === "error") console.error("Voice session failed", { provider: "doubao" });
          this.#deps.send(socket, { type: "voice", event });
        },
        ask: async (request) => {
          const askId = "voice-" + crypto.randomUUID();
          await this.#deps.submit(socket, { type: "prompt.submit", requestId: askId, content: request, whenBusy: "followUp" });
          return askId;
        },
        watch: (taskId, done) => {
          this.#watchers.set(taskId, [...(this.#watchers.get(taskId) ?? []), done]);
        },
        recent: () => this.#written(),
        connect: meteredVoiceConnect((url, headers, handlers) => host.connect(url, headers, handlers), host.telemetry),
      },
      voiceEndpoint(host.env),
      voiceWriter(host.env, { compose: (updates) => this.#compose(updates) }),
    );
    this.#delivered.set(
      socket,
      new Set<number>(this.#deps.progress().messages.filter((entry) => entry.state === "done" && entry.id !== null).map((entry) => entry.id as number)),
    );
    this.#voices.set(socket, relay);
    try {
      await relay.start();
    } catch (error) {
      this.#voices.delete(socket);
      throw error;
    }
    setTimeout(() => {
      if (this.#voices.get(socket) === relay) {
        relay.stop("语音通话已到 10 分钟上限，已自动结束");
        this.#voices.delete(socket);
      }
    }, VOICE_MAX_MS);
    this.#deps.send(socket, { type: "result", requestId, ok: true });
  }

  audio(socket: Socket, audio: string): void {
    this.#voices.get(socket)?.audio(audio);
  }

  mute(socket: Socket, muted: boolean): void {
    this.#voices.get(socket)?.mute(muted);
  }

  stop(socket: Socket, requestId: string): void {
    this.#voices.get(socket)?.stop();
    this.#voices.delete(socket);
    this.#deps.send(socket, { type: "result", requestId, ok: true });
  }

  detach(socket: Socket): void {
    this.#voices.get(socket)?.stop();
    this.#voices.delete(socket);
    this.#delivered.delete(socket);
  }

  async settle(): Promise<void> {
    for (const [taskId, waiters] of [...this.#watchers]) {
      const status = await this.#taskStatus(taskId);
      if (status.status !== "done" && status.status !== "failed") continue;
      this.#watchers.delete(taskId);
      for (const waiter of waiters) waiter(status);
    }
    for (const entry of this.#deps.progress().messages) {
      if (entry.state !== "processing") continue;
      for (const subtask of entry.subtasks) {
        if (!subtask.running) continue;
        for (const relay of this.#voices.values()) relay.overheard(subtask.id, subtask.description);
      }
    }
    const chat = await this.#deps.harness().snapshot(ChatDoc, BACKGROUND_CONTEXT);
    for (const entry of this.#deps.progress().messages) {
      if (entry.state !== "done" || entry.id === null) continue;
      const message = chat?.messages.find((item) => item.id === entry.id);
      if (message === undefined || message.requestId.startsWith("voice-")) continue;
      const text = this.#reply(entry);
      if (text === "") continue;
      for (const [socket, relay] of this.#voices) {
        const delivered = this.#delivered.get(socket) ?? new Set<number>();
        if (delivered.has(entry.id)) continue;
        delivered.add(entry.id);
        this.#delivered.set(socket, delivered);
        relay.deliver(text);
      }
    }
  }

  async #compose(updates: readonly Update[]): Promise<string> {
    const { host } = this.#deps;
    const models = this.#deps.models();
    const model = chatModelRef(host.env, this.#deps.selected());
    await models.getAvailable(model.provider);
    const resolved = models.getModel(model.provider, model.modelId);
    if (resolved === undefined) throw new Error(`model ${model.provider}/${model.modelId} is not available`);
    const reply = await host.telemetry.startSpan({ name: "chat", attributes: { "lulu.agent": "voice-writer", "gen_ai.operation.name": "chat" } }, async (span) => {
      const reply = await models.completeSimple(
        resolved,
        { systemPrompt: VOICE_WRITER_PROMPT, messages: [{ role: "user", content: JSON.stringify(updates.map((update) => update.text)), timestamp: Date.now() }] },
        { sessionId: host.id },
      );
      recordModelUsage(span, reply);
      if (reply.stopReason === "error") {
        console.error("Voice writer model failed", { provider: reply.provider, model: reply.model });
        span.setStatus({ status: "error", error: { name: "Error", message: "voice writer model failed" } });
      }
      return reply;
    });
    return reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  }

  async #written(): Promise<Written[]> {
    const chat = await this.#deps.harness().snapshot(ChatDoc, BACKGROUND_CONTEXT);
    const written: Written[] = [];
    for (const message of chat?.messages ?? []) {
      if (message.requestId.startsWith("voice-")) continue;
      written.push({ writer: "them", text: message.text });
      const progress = this.#deps.progress().messages.find((entry) => entry.id === message.id);
      const answer = progress?.state === "done" ? this.#reply(progress) : "";
      if (answer !== "") written.push({ writer: "you", text: answer });
    }
    return written.slice(-VOICE_WRITTEN_LIMIT);
  }

  #reply(progress: MessageProgress): string {
    if (progress.answer === null) return "";
    const from = Number(progress.entry ?? progress.answer);
    const to = Number(progress.answer);
    return spokenText(sentIn(this.#deps.entries().filter((entry) => Number(entry.id) > from && Number(entry.id) <= to)));
  }

  async #taskStatus(requestId: string): Promise<TaskStatus> {
    const chat = await this.#deps.harness().snapshot(ChatDoc, BACKGROUND_CONTEXT);
    const message = chat?.messages.find((entry) => entry.requestId === requestId);
    if (message === undefined) return { status: "unknown" };
    if (message.id === null) return { status: "running" };
    const progress = this.#deps.progress().messages.find((entry) => entry.id === message.id);
    if (progress === undefined) return { status: "running" };
    if (progress.error !== null) return { status: "failed", error: progress.error };
    if (progress.state === "done") return { status: "done", summary: this.#reply(progress) };
    return { status: "running" };
  }
}
