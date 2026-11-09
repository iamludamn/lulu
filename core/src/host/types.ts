import type { CodemodeToolOptions } from "@earendil-works/pi-durable/codemode";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";

export type Environment = Readonly<Record<string, string | undefined>>;

export const SOCKET_OPEN = 1;

export interface Socket {
  readonly readyState: number;
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

export interface ObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ObjectNamespace<Stub extends ObjectStub = ObjectStub> {
  getByName(name: string): Stub;
}

export interface DurableStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string | string[]): Promise<number>;
  deleteAll(): Promise<void>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
}

export interface DurableAlarm {
  get(): Promise<number | null>;
  set(time: number): Promise<void>;
  delete(): Promise<void>;
}

export interface DurableSockets {
  all(): Socket[];
  attachment(socket: Socket): unknown;
  attach(socket: Socket, attachment: unknown): void;
  upgrade(attachment: unknown): { server: Socket; response: Response };
}

export interface KeyValue {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface UpstreamHandlers {
  message(data: unknown): void;
  close(): void;
}

export interface DurableHost {
  readonly env: Environment;
  readonly telemetry: TelemetryContext;
  readMcpAuth(): Promise<string | undefined>;
  writeMcpAuth(content: string): Promise<void>;
  readonly name: string;
  readonly id: string;
  readonly storage: DurableStorage;
  readonly alarm: DurableAlarm;
  readonly sockets: DurableSockets;
  readonly objects: {
    readonly BOTS: ObjectNamespace;
    readonly MEMORY: ObjectNamespace;
    readonly ARTIFACTS: ObjectNamespace;
  };
  readonly kv: KeyValue;
  readonly sandbox: CodemodeToolOptions["sandbox"];
  connect(url: string, headers: Record<string, string>, handlers: UpstreamHandlers): Promise<{ status: number; socket: Socket | undefined }>;
  abort(reason: string): void;
}

export type McpHostServices = Pick<DurableHost, "env" | "readMcpAuth" | "writeMcpAuth" | "telemetry">;
