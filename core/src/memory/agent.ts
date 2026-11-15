import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { createHarnessTelemetry } from "../telemetry/agent.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  type EntryId,
  Harness,
  type ModelRef,
  section,
  type Storage,
  type Submission,
} from "@earendil-works/pi-durable";
import { memorySpan } from "./telemetry.js";
import { getContext } from "./context.js";
import type { Episode } from "./doc.js";
import type { MemoryFiles } from "./files.js";
import { guardChanges } from "./guard.js";
import { consolidateTask, MEMORY_RULES, rememberTask } from "./rules.js";
import { createReadTools, createWriteTools } from "./tools.js";

const EXTENSION = "pistack.memory-agent";
const LOG_DEPTH = 200;
const SUMMARY_CHARACTERS = 200;

export type MemoryAgentOptions = {
  readonly files: MemoryFiles;
  readonly models: Models;
  readonly model: ModelRef;
  readonly sessionId: string;
  readonly botId: string;
  readonly telemetry: TelemetryContext;
};

export type MemoryRun = { committed: boolean; outcome: "committed" | "replay" | "empty" | "unchanged" | "blocked"; blocked: number };

const trailer = (message: string, key: string): string | undefined =>
  message
    .split("\n")
    .find((line) => line.startsWith(`${key}: `))
    ?.slice(key.length + 2);

export async function lastThrough(files: MemoryFiles): Promise<number> {
  for (const { message } of await files.commits(LOG_DEPTH)) {
    const through = trailer(message, "through");
    if (through !== undefined) return Number(through);
  }
  return 0;
}

const committedBefore = async (files: MemoryFiles, requestId: string): Promise<boolean> =>
  (await files.commits(LOG_DEPTH)).some(({ message }) => trailer(message, "requestId") === requestId);

const today = (): string => new Date().toISOString().slice(0, 10);

const summaryOf = (reply: string): string | undefined => {
  const line = reply
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line?.slice(0, SUMMARY_CHARACTERS);
};

export class MemoryAgent {
  readonly #files: MemoryFiles;
  readonly #models: Models;
  readonly #model: ModelRef;
  readonly #sessionId: string;
  readonly #botId: string;
  readonly #telemetry: TelemetryContext;
  #harness!: Harness;
  #root!: Conversation;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryAgentOptions) {
    this.#files = options.files;
    this.#models = options.models;
    this.#model = options.model;
    this.#sessionId = options.sessionId;
    this.#botId = options.botId;
    this.#telemetry = options.telemetry;
  }

  async start(storage: Storage): Promise<void> {
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: EXTENSION,
        tools: [...createReadTools(this.#files, this.#telemetry), ...createWriteTools(this.#files)],
        sections: [section("rules", () => MEMORY_RULES, { tag: false }), section("memory", () => getContext(this.#files, this.#telemetry), { tag: false })],
      }),
    );
    const telemetry = createHarnessTelemetry(this.#telemetry, { "lulu.agent": "memory", "lulu.bot.id": this.#botId }, () => this.#root?.id);
    registry.install(telemetry.extension);
    const harness = await Harness.open(
      storage,
      {
        models: this.#models,
        registry,
        telemetry: telemetry.context,
        onReport: () => console.error(JSON.stringify({ message: "Memory agent background task failed", sessionId: this.#sessionId, category: "background_task" })),
      },
      BACKGROUND_CONTEXT,
    );
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: this.#model, thinkingLevel: "off" } });
    await root.configure({ model: this.#model }, BACKGROUND_CONTEXT);
    this.#harness = harness;
    this.#root = root;
    harness.resume();
  }

  remember(requestId: string, episodes: readonly Episode[], through: number): Promise<MemoryRun> {
    return this.#serial(() => memorySpan(this.#telemetry, "memory.remember", { "lulu.memory.request_id": requestId, "lulu.memory.episodes": episodes.length, "lulu.memory.cursor.target": through }, async (span) => {
      const result: MemoryRun = episodes.length === 0 ? { committed: false, outcome: "empty", blocked: 0 } : await this.#run(requestId, rememberTask(episodes, today()), "记忆更新", [`through: ${through}`]);
      span.setAttributes({ "lulu.memory.outcome": result.outcome, "lulu.memory.blocked": result.blocked });
      return result;
    }));
  }

  consolidate(requestId: string): Promise<MemoryRun> {
    return this.#serial(() => memorySpan(this.#telemetry, "memory.consolidate", { "lulu.memory.request_id": requestId }, async (span) => {
      const result = await this.#run(requestId, consolidateTask(today()), "整理", []);
      span.setAttributes({ "lulu.memory.outcome": result.outcome, "lulu.memory.blocked": result.blocked });
      return result;
    }));
  }

  async close(): Promise<void> {
    await this.#harness.close(BACKGROUND_CONTEXT);
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #run(requestId: string, task: string, fallback: string, trailers: readonly string[]): Promise<MemoryRun> {
    if (await committedBefore(this.#files, requestId)) return { committed: false, outcome: "replay", blocked: 0 };
    const submission = await this.#submit(requestId, task);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    if (settled.status !== "done" || settled.type !== "input") throw new Error(`Memory agent run ${requestId} ${settled.status}`);
    const summary = summaryOf(await this.#reply(settled.answer)) ?? fallback;
    const { blocked } = await guardChanges(this.#files);
    if ((await this.#files.changed()).length === 0) return { committed: false, outcome: blocked.length > 0 ? "blocked" : "unchanged", blocked: blocked.length };
    const lines = [`requestId: ${requestId}`, ...trailers, ...(blocked.length === 0 ? [] : [`blocked: ${blocked.join(",")}`])];
    const committed = (await this.#files.commit(`${summary}\n\n${lines.join("\n")}`)) !== undefined;
    return { committed, outcome: committed ? "committed" : "unchanged", blocked: blocked.length };
  }

  async #submit(requestId: string, task: string): Promise<Submission> {
    for (let attempt = 1; ; attempt += 1) {
      const key = attempt === 1 ? requestId : `${requestId}#${attempt}`;
      const existing = await this.#harness.commit((tx) => tx.submissionByRequest(this.#root.id, key), BACKGROUND_CONTEXT);
      if (existing?.status === "unanswered") continue;
      if (existing === undefined) {
        for (const path of await this.#files.changed()) await this.#files.discard(path);
        await this.#root.reset(undefined, BACKGROUND_CONTEXT);
      }
      return this.#root.submit({ type: "input", content: task, requestId: key }, BACKGROUND_CONTEXT);
    }
  }

  async #reply(answer: EntryId): Promise<string> {
    const entry = (await this.#root.context(BACKGROUND_CONTEXT)).entries.find((candidate) => candidate.id === answer);
    const message = entry?.model?.[0];
    if (message === undefined || message.role !== "assistant") return "";
    return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  }
}
