import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  run: { type: 'string' },
  tempo: { type: 'string' },
  input: { type: 'string' },
  start: { type: 'string' },
  end: { type: 'string' },
  help: { type: 'boolean' },
} });
if (values.help) {
  console.log('node ops/observability/delegate-timing.mjs --run <run-id> (--tempo <base-url> | --input <trace-json>) [--start <ISO-time>] [--end <ISO-time>]');
  process.exit(0);
}
if (!values.run || Boolean(values.tempo) === Boolean(values.input)) throw new Error('Provide --run and exactly one of --tempo or --input');
const end = values.end ? Date.parse(values.end) : Date.now();
const start = values.start ? Date.parse(values.start) : end - 86400000;
if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Invalid time range');
const warnings = [];
const spans = new Map();
function collect(value) {
  if (!value || typeof value !== 'object') return;
  if (value.spanId && value.startTimeUnixNano && value.endTimeUnixNano) spans.set(`${value.traceId}:${value.spanId}`, value);
  else for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(collect);
    else collect(child);
  }
}
async function get(path) {
  const response = await fetch(`${values.tempo.replace(/\/$/, '')}${path}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Tempo returned HTTP ${response.status}`);
  return response.json();
}
if (values.input) collect(JSON.parse(await readFile(values.input, 'utf8')));
else {
  const query = new URLSearchParams({ q: `{ span.lulu.delegate.run.id = ${JSON.stringify(values.run)} }`, start: String(Math.floor(start / 1000)), end: String(Math.ceil(end / 1000)), limit: '1000' });
  const result = await get(`/api/search?${query}`);
  if ((result.traces?.length ?? 0) >= 1000) throw new Error('Trace search limit reached; use narrower time ranges and combine the exported traces with --input');
  for (const trace of result.traces ?? []) collect(await get(`/api/traces/${trace.traceID}`));
}
const attributes = (span) => Object.fromEntries((span.attributes ?? []).map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue]));
const matched = [...spans.values()].map((span) => ({ ...span, attributes: attributes(span) })).filter((span) => span.attributes['lulu.delegate.run.id'] === values.run);
const summaries = matched.filter((span) => span.name === 'delegate.run').sort((a, b) => Number(b.attributes['lulu.delegate.ended_at']) - Number(a.attributes['lulu.delegate.ended_at']));
const summary = summaries[0]?.attributes;
const runStart = summary ? Number(summary['lulu.delegate.started_at']) : undefined;
const runEnd = summary ? Number(summary['lulu.delegate.ended_at']) : undefined;
if (!summary) warnings.push('No settled run summary found: the run may still be active, predate instrumentation, or have missing telemetry');
if (summary && values.tempo && (runStart < start || runEnd > end)) warnings.push('The run extends outside the search range; widen --start/--end to include its sandbox operations');
function timing(name) {
  const operations = matched.filter((span) => span.name === name);
  const intervals = operations.map((span) => [
    Math.max(Number(BigInt(span.startTimeUnixNano) / 1000000n), runStart ?? -Infinity),
    Math.min(Number(BigInt(span.endTimeUnixNano) / 1000000n), runEnd ?? Infinity),
  ]).filter(([a, b]) => b >= a).sort((a, b) => a[0] - b[0]);
  let unionMs = 0;
  let accumulatedMs = 0;
  let left;
  let right;
  for (const [a, b] of intervals) {
    accumulatedMs += b - a;
    if (right === undefined || a > right) {
      if (right !== undefined) unionMs += right - left;
      [left, right] = [a, b];
    } else right = Math.max(right, b);
  }
  if (right !== undefined) unionMs += right - left;
  return { observedOperations: operations.length, unionMs, accumulatedMs };
}
const sandbox = timing('sandbox.use');
const commands = timing('sandbox.exec');
const agentRunMs = summary ? Math.max(0, runEnd - runStart) : null;
console.log(JSON.stringify({
  runId: values.run,
  status: summary?.['lulu.delegate.status'] ?? null,
  startedAt: runStart ?? null,
  endedAt: runEnd ?? null,
  agentRunMs,
  sandbox,
  commands,
  sandboxFraction: agentRunMs > 0 ? sandbox.unionMs / agentRunMs : null,
  warnings: [...warnings, 'Durations reflect observed spans, not billed sandbox lifetime; missing or crash-interrupted spans can undercount. Run duration includes stopped gaps when the same run is resumed.'],
}, null, 2));
