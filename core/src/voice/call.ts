import type { Cut, Line, LineEvents, LineSettings, ToolCall, ToolResult } from "./line.js";
import { type Names, QUIET_WINDOW_SECONDS, renderInstructions } from "./prompt.js";
import { MAX_REQUEST_CHARACTERS, TOOLS } from "./tools.js";

const QUIET_WINDOW_MS = QUIET_WINDOW_SECONDS * 1000;
const OVERHEARD_BUDGET = { seeds: 120, chars: 60_000 };

export type Written = { writer: "you" | "them"; text: string };
export type Landing = { key?: string; kind?: "outcome" | "progress" };

export interface Channel {
  send(request: string): Promise<string>;
  recent(): Promise<Written[]>;
}

export interface CallEnds {
  ready(): void;
  caller(text: string): void;
  agent?(text: string): void;
  failed(message: string): void;
  closed(): void;
}

export const digest = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash.toString(16);
};

export class Call implements LineEvents {
  readonly #channel: Channel;
  readonly #names: Names;
  readonly #ends: CallEnds;
  readonly #now: () => number;
  #line: Line | undefined;
  #early: Array<(line: Line) => void> = [];
  #seen = new Map<string, number>();
  #told = new Set<string>();
  #lastOverheard: string | undefined;
  #seeds = 0;
  #chars = 0;
  #lastSpokenAt = 0;
  #lastCallerAt = 0;
  #lastEntryAt = 0;

  constructor(channel: Channel, names: Names, ends: CallEnds, now: () => number = Date.now) {
    this.#channel = channel;
    this.#names = names;
    this.#ends = ends;
    this.#now = now;
  }

  settings(voice: string): LineSettings {
    return { instructions: renderInstructions(this.#names), tools: TOOLS, voice };
  }

  async start(line: Line): Promise<void> {
    this.#line = line;
    await line.start();
  }

  landed(text: string, { key = digest(text), kind = "outcome" }: Landing = {}): void {
    const now = this.#now();
    const last = this.#seen.get(key);
    if (this.#told.has(key) || (last !== undefined && now - last < QUIET_WINDOW_MS)) return;
    this.#seen.set(key, now);
    this.#lastEntryAt = now;
    const at = new Date(now).toISOString();
    const worthy = kind === "outcome" || now - this.#lastSpokenAt >= QUIET_WINDOW_MS;
    if (worthy) this.#lastSpokenAt = now;
    this.#with((line) => (worthy ? line.report([{ key, text, progress: kind === "progress" }]) : line.note([{ kind: "landed", key, text, at }])));
  }

  overheard(text: string): void {
    if (this.#lastOverheard === text) return;
    if (this.#seeds >= OVERHEARD_BUDGET.seeds || this.#chars + text.length > OVERHEARD_BUDGET.chars) return;
    this.#lastOverheard = text;
    this.#seeds += 1;
    this.#chars += text.length;
    this.#lastEntryAt = this.#now();
    const at = new Date(this.#lastEntryAt).toISOString();
    this.#with((line) => line.note([{ kind: "overheard", key: digest(text), text, at }]));
  }

  ready(): void {
    this.#ends.ready();
    this.#lastSpokenAt = this.#now();
    this.#line?.say(`你好${this.#names.userName}，我是${this.#names.agentName}，在呢。`);
    for (const action of this.#early.splice(0)) if (this.#line !== undefined) action(this.#line);
  }

  caller(text: string): void {
    this.#lastCallerAt = this.#now();
    this.#ends.caller(text);
  }

  agent(text: string): void {
    this.#lastSpokenAt = this.#now();
    this.#ends.agent?.(text);
  }

  cut(cut: Cut): void {
    for (const key of cut.reported) this.#told.add(key);
  }

  failed(message: string): void {
    this.#ends.failed(message);
  }

  closed(): void {
    this.#ends.closed();
  }

  async tools(calls: ToolCall[]): Promise<ToolResult[]> {
    return Promise.all(calls.map((call) => this.#run(call)));
  }

  #with(action: (line: Line) => void): void {
    if (this.#line === undefined) this.#early.push(action);
    else action(this.#line);
  }

  async #run(call: ToolCall): Promise<ToolResult> {
    try {
      switch (call.name) {
        case "send_task":
          return await this.#sendTask(call.arguments);
        case "recall_text_messages":
          return { output: JSON.stringify({ messages: await this.#channel.recent() }) };
        case "stay_silent":
          return this.#stayQuiet();
        case "end_the_call":
          return { output: JSON.stringify({ status: "hanging_up" }), hangup: true };
        default:
          return { output: JSON.stringify({ error: `unknown tool ${call.name}` }) };
      }
    } catch (error) {
      return { output: JSON.stringify({ error: error instanceof Error ? error.message : "tool failed" }) };
    }
  }

  async #sendTask(raw: string): Promise<ToolResult> {
    const request = (JSON.parse(raw) as { request?: unknown }).request;
    if (typeof request !== "string" || request.trim() === "") return { output: JSON.stringify({ error: "request is required" }) };
    if (request.length > MAX_REQUEST_CHARACTERS) return { output: JSON.stringify({ rejected: `request is over ${MAX_REQUEST_CHARACTERS} characters` }) };
    await this.#channel.send(request.trim());
    return { output: JSON.stringify({ receipt: "under way" }) };
  }

  #stayQuiet(): ToolResult {
    if (this.#lastCallerAt > this.#lastEntryAt) {
      return { output: JSON.stringify({ error: "they just talked to you; speak" }) };
    }
    return { output: "{}", quiet: true };
  }
}
