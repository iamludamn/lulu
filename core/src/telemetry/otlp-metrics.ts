import type { HistogramOptions, InstrumentOptions, SpanAttributes, TelemetryMetrics } from "@earendil-works/pi-telemetry";

type Point = { attributes: SpanAttributes; started: number; ended: number; count: number; sum: number; min: number; max: number; buckets: number[] };
type Instrument = { name: string; kind: "counter" | "upDownCounter" | "histogram"; options: HistogramOptions; points: Map<string, Point> };
const DEFAULT_BOUNDARIES = [0, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];

export function otlpMetrics(schedule: () => void, attributesOf: (attributes: SpanAttributes) => unknown[]) {
  const instruments = new Map<string, Instrument>();
  const instrument = (name: string, kind: Instrument["kind"], options: HistogramOptions = {}): Instrument => {
    const key = `${kind}:${name}`;
    let found = instruments.get(key);
    if (!found) {
      found = { name, kind, options: { ...options, boundaries: options.boundaries ?? DEFAULT_BOUNDARIES }, points: new Map() };
      instruments.set(key, found);
    }
    return found;
  };
  const record = (target: Instrument, value: number, attributes: SpanAttributes = {}): void => {
    const entries = Object.entries(attributes).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b));
    const key = JSON.stringify(entries);
    const now = Date.now();
    let point = target.points.get(key);
    if (!point) {
      point = { attributes: Object.fromEntries(entries.map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])), started: now, ended: now, count: 0, sum: 0, min: value, max: value, buckets: Array(target.options.boundaries!.length + 1).fill(0) };
      target.points.set(key, point);
    }
    point.ended = now;
    point.count += 1;
    point.sum += value;
    point.min = Math.min(point.min, value);
    point.max = Math.max(point.max, value);
    const bucket = target.options.boundaries!.findIndex((bound) => value <= bound);
    point.buckets[bucket === -1 ? point.buckets.length - 1 : bucket]! += 1;
    schedule();
  };
  const metrics: TelemetryMetrics = {
    counter: (name: string, options?: InstrumentOptions) => {
      const target = instrument(name, "counter", options);
      return { add: (value, attributes) => record(target, value, attributes) };
    },
    upDownCounter: (name: string, options?: InstrumentOptions) => {
      const target = instrument(name, "upDownCounter", options);
      return { add: (value, attributes) => record(target, value, attributes) };
    },
    histogram: (name: string, options?: HistogramOptions) => {
      const target = instrument(name, "histogram", options);
      return { record: (value, attributes) => record(target, value, attributes) };
    },
  };
  const drain = () => {
    const result = [];
    for (const target of instruments.values()) {
      if (target.points.size === 0) continue;
      const dataPoints = [...target.points.values()].map((point) => ({
        attributes: attributesOf(point.attributes),
        startTimeUnixNano: String(BigInt(point.started) * 1_000_000n),
        timeUnixNano: String(BigInt(point.ended) * 1_000_000n),
        ...(target.kind === "histogram" ? { count: String(point.count), sum: point.sum, min: point.min, max: point.max, explicitBounds: target.options.boundaries, bucketCounts: point.buckets.map(String) } : { asDouble: point.sum }),
      }));
      result.push({ name: target.name, description: target.options.description, unit: target.options.unit,
        ...(target.kind === "histogram" ? { histogram: { aggregationTemporality: 1, dataPoints } } : { sum: { aggregationTemporality: 1, isMonotonic: target.kind === "counter", dataPoints } }),
      });
      target.points.clear();
    }
    return result;
  };
  return { metrics, drain };
}
