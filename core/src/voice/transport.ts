import type { DurableHost, Socket } from "../host/types.js";

export interface Transport {
  connect(): Promise<void>;
  send(event: Record<string, unknown>): void;
  onEvent(listener: (event: Record<string, unknown>) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export type Endpoint = { url: string; headers: Record<string, string> };

export class HostTransport implements Transport {
  readonly #connect: DurableHost["connect"];
  readonly #endpoint: Endpoint;
  #socket: Socket | undefined;
  #events: Array<(event: Record<string, unknown>) => void> = [];
  #closes: Array<() => void> = [];

  constructor(connect: DurableHost["connect"], endpoint: Endpoint) {
    this.#connect = connect;
    this.#endpoint = endpoint;
  }

  async connect(): Promise<void> {
    const { status, socket } = await this.#connect(this.#endpoint.url, this.#endpoint.headers, {
      message: (data) => {
        const event = parse(String(data));
        if (event !== undefined) for (const listener of this.#events) listener(event);
      },
      close: () => {
        this.#socket = undefined;
        for (const listener of this.#closes) listener();
      },
    });
    if (socket === undefined) throw new Error(`Voice upstream refused the connection (HTTP ${status})`);
    this.#socket = socket;
  }

  send(event: Record<string, unknown>): void {
    this.#socket?.send(JSON.stringify(event));
  }

  onEvent(listener: (event: Record<string, unknown>) => void): void {
    this.#events.push(listener);
  }

  onClose(listener: () => void): void {
    this.#closes.push(listener);
  }

  close(): void {
    this.#socket?.close(1000, "voice stopped");
  }
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
