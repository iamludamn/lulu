import { otlpMetrics } from "./otlp-metrics.js";
import { isSensitive } from "../memory/guard.js";
import { NOOP_TELEMETRY_CONTEXT, type AttributeValue, type SpanAttributes, type SpanLink, type SpanOptions, type SpanStatus, type TelemetryContext, type TelemetrySpan, type TelemetryCarrier, type TelemetryPropagation } from "@earendil-works/pi-telemetry";
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
  links: { traceId: string; spanId: string; attributes: OtlpAttribute[] }[];
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
  for (const [key, value] of Object.entries(attributes ?? {})) if (value !== undefined) target.set(key, Array.isArray(value) ? [...value] : value);
};

type Parent = { traceId: string; spanId: string; attributes: SpanAttributes };
const SCOPE = ["lulu.request.id", "lulu.release", "lulu.bot.id", "lulu.agent", "lulu.conversation.id", "lulu.conversation.kind", "lulu.delegate.run.id", "lulu.delegate.generation", "lulu.task.id", "lulu.sandbox.id", "lulu.sandbox.backend", "gen_ai.tool.name"] as const;

class OtlpParent implements TelemetryContext {
  constructor(readonly exporter: OtlpExporter, readonly parent: Parent) {}
  get metrics() { return this.exporter.metrics; }
  get propagation() { return this.exporter.propagation; }
  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    return run(new OtlpSpan(this.exporter, options, this.parent), callback);
  }
}

class OtlpSpan implements TelemetrySpan {
  readonly #exporter: OtlpExporter;
  readonly #traceId: string;
  readonly #spanId = hex(8);
  readonly #parentSpanId: string | undefined;
  readonly #name: string;
  readonly #start = Date.now();
  readonly #attributes = new Map<string, AttributeValue>();
  readonly #links: Finished["links"] = [];
  readonly #events: Finished["events"] = [];
  #status: SpanStatus | undefined = undefined;
  #ended = false;

  constructor(exporter: OtlpExporter, options: SpanOptions, parent: Parent | undefined) {
    this.#exporter = exporter;
    this.#traceId = parent === undefined ? hex(16) : parent.traceId;
    this.#parentSpanId = parent === undefined ? undefined : parent.spanId;
    this.#name = options.name;
    merge(this.#attributes, parent?.attributes);
    merge(this.#attributes, options.attributes);
    for (const link of options.links ?? []) this.addLink(link);
  }

  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    return run(new OtlpSpan(this.#exporter, options, this.reference), callback);
  }

  get metrics() { return this.#exporter.metrics; }
  get propagation() { return this.#exporter.propagation; }
  get reference(): Parent {
    return { traceId: this.#traceId, spanId: this.#spanId, attributes: Object.fromEntries(SCOPE.map((key) => [key, this.#attributes.get(key)])) };
  }

  addEvent(name: string, attributes?: SpanAttributes): void {
    if (this.#ended) return;
    const event = new Map<string, AttributeValue>();
    merge(event, attributes);
    this.#events.push({ timeUnixNano: nanos(Date.now()), name, attributes: attributesOf(event) });
  }

  addLink(link: SpanLink): void {
    if (this.#ended) return;
    const parent = link.context instanceof OtlpSpan ? link.context.reference : link.context instanceof OtlpParent ? link.context.parent : undefined;
    if (!parent) return;
    const attributes = new Map<string, AttributeValue>();
    merge(attributes, link.attributes);
    this.#links.push({ traceId: parent.traceId, spanId: parent.spanId, attributes: attributesOf(attributes) });
  }

  setAttributes(attributes: SpanAttributes): void {
    if (!this.#ended) merge(this.#attributes, attributes);
  }

  setStatus(status: SpanStatus): void {
    if (this.#ended) return;
    const raw = status.status === "error" ? status.error?.message : undefined;
    const message = raw === undefined ? undefined : this.#attributes.get("lulu.agent") === "memory" || isSensitive(raw) ? "operation failed: [redacted]" : raw.slice(0, 300);
    this.#status = status.status === "error" ? { status: "error", error: status.error === undefined ? undefined : { name: status.error.name, message: message ?? "operation failed" } } : status;
  }

  finish(failure: { error: unknown } | undefined): void {
    if (this.#ended) return;
    if (failure !== undefined && this.#status === undefined) {
      const error = failure.error;
      this.setStatus({ status: "error", error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } });
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
      links: this.#links,
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
  readonly #measurements = otlpMetrics(() => this.#schedule(), (attributes) => attributesOf(new Map(Object.entries(attributes).filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined))));
  readonly metrics = this.#measurements.metrics;
  readonly propagation: TelemetryPropagation = {
    inject: (context): TelemetryCarrier | undefined => {
      const parent = context instanceof OtlpSpan ? context.reference : context instanceof OtlpParent ? context.parent : undefined;
      if (!parent) return undefined;
      return { traceparent: `00-${parent.traceId}-${parent.spanId}-01`, ...Object.fromEntries(SCOPE.flatMap((key) => typeof parent.attributes[key] === "string" ? [[key, parent.attributes[key] as string]] : [])) };
    },
    extract: (carrier) => {
      const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/.exec(carrier?.traceparent ?? "");
      if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return this;
      return new OtlpParent(this, { traceId: match[1]!, spanId: match[2]!, attributes: Object.fromEntries(SCOPE.flatMap((key) => typeof carrier?.[key] === "string" ? [[key, carrier[key]]] : [])) });
    },
  };

  constructor(config: OtlpConfig) {
    this.#config = config;
  }

  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    return run(new OtlpSpan(this, options, undefined), callback);
  }

  push(span: Finished): void {
    this.#finished.push(span);
    this.#schedule();
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#config.waitUntil(new Promise<void>((resolve) => setTimeout(resolve, 1000)).then(() => this.#flush()));
  }

  async #flush(): Promise<void> {
    this.#scheduled = false;
    const spans = this.#finished;
    this.#finished = [];
    const metrics = this.#measurements.drain();
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: this.#config.service } }] },
          scopeSpans: [{ scope: { name: "lulu" }, spans }],
        },
      ],
    };
    await Promise.all([
      spans.length === 0 ? undefined : this.#send(this.#config.url, body),
      metrics.length === 0 ? undefined : this.#send(this.#config.url.replace(/\/v1\/traces$/, "/v1/metrics"), {
        resourceMetrics: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: this.#config.service } }] }, scopeMetrics: [{ scope: { name: "lulu" }, metrics }] }],
      }),
    ]);
  }

  async #send(url: string, body: unknown): Promise<void> {
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...this.#config.headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
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
