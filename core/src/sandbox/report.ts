import type { Context } from "@earendil-works/chord/context";
import type { DocumentReader } from "@earendil-works/pi-durable";
import { ACCOUNTING_WINDOW_MS, SandboxAccountingDoc, type SandboxAccounting, type Period } from "./accounting.js";

type Interval = { start: number; end: number };

function union(intervals: readonly Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const { start, end } of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  return merged;
}

function sum(intervals: readonly Interval[]): number {
  return intervals.reduce((ms, { start, end }) => ms + end - start, 0);
}

function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i]!;
    const right = b[j]!;
    const start = Math.max(left.start, right.start);
    const end = Math.min(left.end, right.end);
    if (start < end) result.push({ start, end });
    if (left.end < right.end) i++;
    else j++;
  }
  return result;
}

function add<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

export function sandboxReport(state: SandboxAccounting, from: number, to: number, now: number) {
  const start = Math.max(from, state.since || now, now - ACCOUNTING_WINDOW_MS);
  const end = Math.min(to, now);
  const coveredMs = Math.max(0, end - start);
  const coverage = {
    covered_seconds: coveredMs / 1000,
    uncovered_seconds: (to - from - coveredMs) / 1000,
    observation_age_seconds: state.lastObservedAt ? Math.max(0, now - state.lastObservedAt) / 1000 : null,
  };
  if (!coveredMs) return coverage;

  const periods: Period[] = [...state.history];
  let openSandboxes = 0;
  let openAgents = 0;
  for (const { id: resource, backend, kind, start, validUntil } of Object.values(state.resources)) {
    if (start < end) openSandboxes += 1;
    periods.push({ kind, resource, backend, start, end: kind === "ready" ? Math.min(validUntil, now) : now });
    if (kind === "ready" && now > validUntil) periods.push({ kind: "unknown", resource, backend, start: validUntil, end: now });
  }
  for (const [task, agent] of Object.entries(state.agents)) {
    if (agent.start < end) openAgents += 1;
    periods.push({ kind: "agent", task, delegate: agent.delegate, start: agent.start, end: now });
  }
  for (const [task, link] of Object.entries(state.links)) periods.push({ kind: "association", task, ...link, end: now });

  const online = new Map<string, Interval[]>();
  const agents = new Map<string, Interval[]>();
  const delegates = new Set<string>();
  const links = new Map<string, Extract<Period, { kind: "association" }>[]>();
  let startup = 0;
  let sandboxUnknown = 0;
  let delegateUnknown = 0;
  for (const period of periods) {
    const clipped = { ...period, start: Math.max(start, period.start), end: Math.min(end, period.end) };
    const ms = clipped.end - clipped.start;
    if (ms <= 0) continue;
    switch (clipped.kind) {
      case "ready": add(online, clipped.resource, clipped); break;
      case "startup": startup += ms; break;
      case "unknown": sandboxUnknown += ms; break;
      case "agentUnknown": if (clipped.delegate) delegateUnknown += ms; break;
      case "agent":
        add(agents, clipped.task, clipped);
        if (clipped.delegate) delegates.add(clipped.task);
        break;
      case "association": add(links, clipped.task, clipped); break;
    }
  }

  const delegateWork = new Map<string, Interval[]>();
  const otherWork = new Map<string, Interval[]>();
  for (const [resource, intervals] of online) online.set(resource, union(intervals));
  let activeMs = 0;
  let associatedMs = 0;
  for (const [task, intervals] of agents) {
    const active = union(intervals);
    const delegate = delegates.has(task);
    if (delegate) activeMs += sum(active);
    const associations = new Map<string, Interval[]>();
    for (const link of links.get(task) ?? []) add(associations, link.resource, link);
    for (const [resource, assignments] of associations) {
      const work = intersect(intersect(active, union(assignments)), online.get(resource) ?? []);
      for (const interval of work) add(delegate ? delegateWork : otherWork, resource, interval);
      if (delegate) associatedMs += sum(work);
    }
  }
  let onlineMs = 0;
  let occupiedMs = 0;
  let otherOnlyMs = 0;
  for (const [resource, ready] of online) {
    const delegate = delegateWork.get(resource) ?? [];
    const other = otherWork.get(resource) ?? [];
    const occupied = sum(union(delegate));
    onlineMs += sum(ready);
    occupiedMs += occupied;
    otherOnlyMs += sum(union([...delegate, ...other])) - occupied;
  }

  return {
    ...coverage,
    delegate_active_seconds: activeMs / 1000,
    online_seconds: onlineMs / 1000,
    occupied_seconds: occupiedMs / 1000,
    associated_agent_seconds: associatedMs / 1000,
    occupancy: onlineMs > 0 ? occupiedMs / onlineMs : null,
    parallelism: onlineMs > 0 ? associatedMs / onlineMs : null,
    startup_seconds: startup / 1000,
    other_work_seconds: otherOnlyMs / 1000,
    unassociated_seconds: (onlineMs - occupiedMs - otherOnlyMs) / 1000,
    unknown_sandbox_seconds: sandboxUnknown / 1000,
    unknown_delegate_seconds: delegateUnknown / 1000,
    open_sandboxes: openSandboxes,
    open_agents: openAgents,
  };
}

const QUERY = /^lulu_sandbox_window\{(?:measure="([a-z_]+)",)?from="(\d{1,13})",to="(\d{1,13})"\}$/;
const headers = { "Cache-Control": "no-store" };

function vector(result: Record<string, number | null>, timestamp: number): Response {
  return Response.json({
    status: "success",
    data: {
      resultType: "vector",
      result: Object.entries(result).map(([measure, value]) => ({
        metric: { __name__: "lulu_sandbox_window", measure },
        value: [timestamp / 1000, value === null ? "NaN" : String(value)],
      })),
    },
  }, { headers });
}

export async function sandboxWindowQuery(request: Request, read: DocumentReader, context: Context): Promise<Response> {
  const query = new URL(request.url).searchParams.get("query") ?? "";
  const now = Date.now();
  if (query === "1+1" || query === "vector(1)") return vector({ health: query === "1+1" ? 2 : 1 }, now);
  const match = QUERY.exec(query);
  const from = Number(match?.[2]);
  const to = Number(match?.[3]);
  if (!match || from >= to || to - from > ACCOUNTING_WINDOW_MS) {
    return Response.json({ status: "error", errorType: "bad_data", error: "Select a window of up to seven days" }, { status: 400, headers });
  }
  const state = await read.snapshot(SandboxAccountingDoc, context);
  const result = state ? sandboxReport(state, from, to, now) : { uncovered_seconds: (to - from) / 1000 };
  const measure = match[1];
  return vector(measure ? Object.fromEntries(Object.entries(result).filter(([key]) => key === measure)) : result, to);
}
