import type {
  BotAccess,
  ClientMessage,
  ConversationView,
  ExecutorStatus,
  McpStatus,
  ModelConfig,
  ModelRef,
  ServerMessage,
  SessionProgress,
} from "../protocol";
import { newId } from "./ids";

export type Command = Exclude<ClientMessage, { type: "hello" }>;

export interface Request {
  readonly command: Command;
  readonly state: "sending" | "failed";
  readonly error?: string;
}

export interface Snapshot {
  readonly link: "connecting" | "online" | "offline";
  readonly access?: BotAccess;
  readonly view?: ConversationView;
  readonly progress?: SessionProgress;
  readonly models?: ModelConfig;
  readonly executors: readonly ExecutorStatus[];
  readonly mcp: readonly McpStatus[];
  readonly requests: readonly Request[];
  readonly halt?: "unauthorized" | "forbidden" | "not-found";
}

const MAX_BACKOFF_MS = 15_000;

export function botPath(id: string): string {
  return `/bots/${encodeURIComponent(id)}`;
}

function socketUrl(id: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/bots/${encodeURIComponent(id)}/ws`;
}

export class BotStore {
  readonly #botId: string;
  readonly #listeners = new Set<() => void>();
  readonly #requests = new Map<string, Request>();
  readonly #voiceListeners = new Set<(event: Record<string, unknown>) => void>();
  #snapshot: Snapshot;
  #socket: WebSocket | undefined;
  #timer: number | undefined;
  #attempts = 0;

  constructor(botId: string) {
    this.#botId = botId;
    this.#snapshot = { link: "connecting", executors: [], mcp: [], requests: [] };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): Snapshot => this.#snapshot;

  start(): void {
    this.#connect();
  }

  stop(): void {
    window.clearTimeout(this.#timer);
    this.#timer = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
  }

  submit(content: string): void {
    this.#dispatch({ type: "prompt.submit", requestId: newId(), content, whenBusy: "followUp" });
  }

  abort(): void {
    this.#dispatch({ type: "prompt.abort", requestId: newId() });
  }

  startVoice(): void {
    this.#dispatch({ type: "voice.start", requestId: newId() });
  }

  stopVoice(): void {
    this.#dispatch({ type: "voice.stop", requestId: newId() });
  }

  muteVoice(muted: boolean): void {
    this.#dispatch({ type: "voice.mute", requestId: newId(), muted });
  }

  sendVoiceAudio(audio: string): void {
    this.#transmit({ type: "voice.audio", requestId: "voice", audio });
  }

  onVoice(listener: (event: Record<string, unknown>) => void): () => void {
    this.#voiceListeners.add(listener);
    return () => {
      this.#voiceListeners.delete(listener);
    };
  }

  selectModel(model: ModelRef): void {
    this.#dispatch({ type: "model.select", requestId: newId(), model });
  }

  selectExecutor(owner: string, name: string): void {
    this.#dispatch({ type: "executor.select", requestId: newId(), owner, name });
  }

  retry(requestId: string): void {
    const request = this.#requests.get(requestId);
    if (request !== undefined) this.#dispatch(request.command);
  }

  dismiss(requestId: string): void {
    this.#requests.delete(requestId);
    this.#publish({});
  }

  #connect(): void {
    const socket = new WebSocket(socketUrl(this.#botId));
    this.#socket = socket;
    socket.onopen = () => {
      this.#attempts = 0;
      this.#hello();
      for (const request of this.#requests.values()) {
        if (request.state === "sending") this.#transmit(request.command);
      }
      this.#publish({ link: "online" });
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      this.#receive(JSON.parse(event.data) as ServerMessage);
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      if (event.code === 4401) {
        this.#publish({ link: "offline", halt: "unauthorized" });
        return;
      }
      if (event.code === 4403) {
        this.#publish({ link: "offline", halt: "forbidden", access: undefined });
        return;
      }
      if (event.code === 4404) {
        this.#publish({ link: "offline", halt: "not-found" });
        return;
      }
      this.#publish({ link: "offline" });
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.#attempts);
      this.#attempts += 1;
      this.#timer = window.setTimeout(() => this.#connect(), delay);
    };
  }

  #hello(): void {
    this.#transmit({ type: "hello" });
  }

  #receive(message: ServerMessage): void {
    if (message.type === "state") {
      this.#publish({ view: message.view, progress: message.progress, executors: message.executors, mcp: message.mcp });
    } else if (message.type === "models") {
      this.#publish({ models: message.config });
    } else if (message.type === "access") {
      this.#publish({ access: message.access, halt: undefined });
    } else if (message.type === "voice") {
      for (const listener of this.#voiceListeners) listener(message.event);
    } else {
      this.#settle(message);
    }
  }

  #settle(result: Extract<ServerMessage, { type: "result" }>): void {
    const request = this.#requests.get(result.requestId);
    if (request === undefined) return;
    if (result.ok) this.#requests.delete(result.requestId);
    else this.#requests.set(result.requestId, { command: request.command, state: "failed", error: result.error });
    this.#publish({});
  }

  #dispatch(command: Command): void {
    this.#requests.set(command.requestId, { command, state: "sending" });
    this.#transmit(command);
    this.#publish({});
  }

  #transmit(message: ClientMessage): void {
    const socket = this.#socket;
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  #publish(patch: Partial<Omit<Snapshot, "requests">>): void {
    this.#snapshot = { ...this.#snapshot, ...patch, requests: [...this.#requests.values()] };
    for (const listener of this.#listeners) listener();
  }
}
