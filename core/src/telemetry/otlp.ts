import { NOOP_TELEMETRY_CONTEXT, type AttributeValue, type SpanAttributes, type SpanOptions, type SpanStatus, type TelemetryContext, type TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { Environment } from "../host/types.js";

export type OtlpConfig = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly service: string;
  waitUntil(task: Promise<unknown>): void;
};

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: OtlpValue[] } };
type OtlpAttribute = { key: string; value: OtlpValue };

type Finished = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 1;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  events: { timeUnixNano: string; name: string; attributes: OtlpAttribute[] }[];
  status: { code: 0 | 1 | 2; message?: string };
};

const nanos = (ms: number): string => String(BigInt(ms) * 1_000_000n);

const hex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");

const scalar = (value: string | number | boolean): OtlpValue => {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
};

const encode = (value: AttributeValue): OtlpValue =>
  typeof value === "object" ? { arrayValue: { values: value.map(scalar) } } : scalar(value);

const attributesOf = (attributes: ReadonlyMap<string, AttributeValue>): OtlpAttribute[] =>
  Array.from(attributes, ([key, value]) => ({ key, value: encode(value) }));

const merge = (target: Map<string, AttributeValue>, attributes: SpanAttributes | undefined): void => {
  for (const [key, value] of Object.entries(attributes ?? {})) if (value !== undefined) target.set(key, value);
};

class OtlpSpan implements TelemetrySpan {
  readonly #exporter: OtlpExporter;
  readonly #traceId: string;
  readonly #spanId = hex(8);
  readonly #parentSpanId: string | undefined;
  readonly #name: string;
  readonly #start = Date.now();
  readonly #attributes = new Map<string, AttributeValue>();
  readonly #events: Finished["events"] = [];
  #status: SpanStatus | undefined = undefined;
  #ended = false;

  constructor(exporter: OtlpExporter, options: SpanOptions, parent: OtlpSpan | undefined) {
    this.#exporter = exporter;
    this.#traceId = parent === undefined ? hex(16) : parent.#traceId;
    this.#parentSpanId = parent === undefined ? undefined : parent.#spanId;
    this.#name = options.name;
    merge(this.#attributes, options.attributes);
  }

  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    return run(new OtlpSpan(this.#exporter, options, this), callback);
  }

  addEvent(name: string, attributes?: SpanAttributes): void {
    if (this.#ended) return;
    const event = new Map<string, AttributeValue>();
    merge(event, attributes);
    this.#events.push({ timeUnixNano: nanos(Date.now()), name, attributes: attributesOf(event) });
  }

  setAttributes(attributes: SpanAttributes): void {
    if (!this.#ended) merge(this.#attributes, attributes);
  }

  setStatus(status: SpanStatus): void {
    if (!this.#ended) this.#status = status;
  }

  finish(failure: { error: unknown } | undefined): void {
    if (this.#ended) return;
    if (failure !== undefined && this.#status === undefined) {
      const error = failure.error;
      this.#status = { status: "error", error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } };
    }
    this.#ended = true;
    const status = this.#status ?? { status: "ok" };
    this.#exporter.push({
      traceId: this.#traceId,
      spanId: this.#spanId,
      parentSpanId: this.#parentSpanId,
      name: this.#name,
      kind: 1,
      startTimeUnixNano: nanos(this.#start),
      endTimeUnixNano: nanos(Date.now()),
      attributes: attributesOf(this.#attributes),
      events: this.#events,
      status: status.status === "ok" ? { code: 1 } : { code: 2, message: status.error === undefined ? undefined : `${status.error.name}: ${status.error.message}` },
    });
  }
}

function run<T>(span: OtlpSpan, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
  let result: Promise<T>;
  try {
    result = Promise.resolve(callback(span));
  } catch (error) {
    result = Promise.reject(error);
  }
  return result.then(
    (value) => {
      span.finish(undefined);
      return value;
    },
    (error: unknown) => {
      span.finish({ error });
      throw error;
    },
  );
}

class OtlpExporter implements TelemetryContext {
  readonly #config: OtlpConfig;
  #finished: Finished[] = [];
  #scheduled = false;

  constructor(config: OtlpConfig) {
    this.#config = config;
  }

  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    return run(new OtlpSpan(this, options, undefined), callback);
  }

  push(span: Finished): void {
    this.#finished.push(span);
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#config.waitUntil(Promise.resolve().then(() => this.#flush()));
  }

  async #flush(): Promise<void> {
    this.#scheduled = false;
    const spans = this.#finished;
    this.#finished = [];
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: this.#config.service } }] },
          scopeSpans: [{ scope: { name: "lulu" }, spans }],
        },
      ],
    };
    try {
      const response = await fetch(this.#config.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.#config.headers },
        body: JSON.stringify(body),
      });
      if (!response.ok) console.error(JSON.stringify({ message: "OTLP export rejected", status: response.status }));
    } catch (error) {
      console.error(JSON.stringify({ message: "OTLP export failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

const parseHeaders = (raw: string | undefined): Record<string, string> =>
  Object.fromEntries(
    (raw ?? "")
      .split(",")
      .map((pair) => pair.trim())
      .filter((pair) => pair.includes("="))
      .map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at).trim(), decodeURIComponent(pair.slice(at + 1).trim())];
      }),
  );

export function createTelemetry(env: Environment, waitUntil: OtlpConfig["waitUntil"]): TelemetryContext {
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!base) return NOOP_TELEMETRY_CONTEXT;
  return new OtlpExporter({
    url: `${base.replace(/\/+$/, "")}/v1/traces`,
    headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    service: env.OTEL_SERVICE_NAME ?? "lulu",
    waitUntil,
  });
}
