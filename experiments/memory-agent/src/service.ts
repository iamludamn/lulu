import { mkdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, Harness, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { getContext } from "./context.js";
import { createMemoryAgentExtension, type MemoryView } from "./extension.js";
import { memoryModelRef, models } from "./model.js";
import { READ_PROMPT, WRITE_PROMPT } from "./prompt.js";
import { serial } from "./queue.js";
import { dreamInMemory, loadSnapshot, type Snapshot } from "./snapshot.js";
import { ALL_GIT, AGENT_DISABLED, commitAll, seed, shell } from "./store.js";

export type Turn = { role: "user" | "assistant"; text: string };

type Role = "writer" | "reader";

type Runtime = { harness: Harness; root: Conversation; current: { view?: MemoryView } };

const DATA_DIR = process.env.MEMORY_DATA_DIR ?? new URL("../data/", import.meta.url).pathname;
const runtimes = new Map<string, Promise<Runtime>>();
const snapshots = new Map<string, Snapshot>();

const memoryPath = (userId: string) => `${DATA_DIR}${userId}.memory.db`;

async function open(userId: string, role: Role): Promise<Runtime> {
  await mkdir(DATA_DIR, { recursive: true });
  const current: Runtime["current"] = {};
  const registry = createRegistry();
  registry.install(
    createMemoryAgentExtension(() => {
      if (!current.view) throw new Error("no memory view for this run");
      return current.view;
    }),
  );
  const harness = await Harness.open(await openNodeSqliteStorage(`${DATA_DIR}${userId}.${role}.durable.db`), { models, registry }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: memoryModelRef(), thinkingLevel: "off" } });
  harness.resume();
  return { harness, root, current };
}

function runtimeOf(userId: string, role: Role): Promise<Runtime> {
  const key = `${role}:${userId}`;
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = open(userId, role);
    runtimes.set(key, runtime);
  }
  return runtime;
}

async function converse(runtime: Runtime, view: MemoryView, requestId: string, task: string): Promise<string> {
  runtime.current.view = view;
  await runtime.root.reset(undefined, BACKGROUND_CONTEXT);
  const submission = await runtime.root.submit({ type: "input", content: task, requestId }, BACKGROUND_CONTEXT);
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  if (settled.status !== "done" || settled.type !== "input") throw new Error(`memory run ${requestId} ${settled.status}`);
  const answer = await runtime.root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
  const message = answer?.model?.[0];
  const content = message && "content" in message && Array.isArray(message.content) ? message.content : [];
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

const transcript = (turns: readonly Turn[]): string =>
  `以下是刚结束的会话（已去掉工具输出）。提取值得长期记住的内容并写入记忆。\n\n${turns.map((turn) => `${turn.role === "user" ? "用户" : "助手"}: ${turn.text}`).join("\n")}`;

async function write(userId: string, requestId: string, task: string, label: string) {
  const runtime = await runtimeOf(userId, "writer");
  const dreamt = await dreamInMemory(memoryPath(userId), async (fs) => {
    const host = shell(fs, []);
    await seed(fs, host);
    await converse(runtime, { fs, bash: shell(fs, AGENT_DISABLED), prompt: WRITE_PROMPT }, requestId, task);
    return commitAll(host, `${label}: ${requestId}`);
  });
  snapshots.delete(userId);
  return { committed: dreamt.result, version: dreamt.version, changed: dreamt.changed, loadMs: Math.round(dreamt.loadMs), commitMs: Math.round(dreamt.commitMs), lockWaitMs: Math.round(dreamt.lockWaitMs) };
}

export const remember = (userId: string, requestId: string, turns: readonly Turn[]) => serial(userId, () => write(userId, requestId, transcript(turns), "remember"));

export const consolidate = (userId: string, requestId: string) =>
  serial(userId, () => write(userId, requestId, "离线整理：合并重复、去掉过时状态、精简超限文件。没有需要整理的就回复“无变更”。", "consolidate"));

export async function snapshotOf(userId: string): Promise<Snapshot> {
  const cached = snapshots.get(userId);
  if (cached) return cached;
  const loaded = await loadSnapshot(memoryPath(userId));
  snapshots.set(userId, loaded);
  return loaded;
}

export const invalidate = (userId: string): void => {
  snapshots.delete(userId);
};

export const context = async (userId: string): Promise<string> => getContext((await snapshotOf(userId)).fs);

export async function ask(userId: string, requestId: string, question: string): Promise<{ answer: string; version: number }> {
  const runtime = await runtimeOf(userId, "reader");
  const snapshot = await snapshotOf(userId);
  const answer = await converse(runtime, { fs: snapshot.fs, bash: shell(snapshot.fs, ALL_GIT), prompt: READ_PROMPT }, requestId, question);
  return { answer, version: snapshot.version };
}

export async function closeAll(): Promise<void> {
  for (const runtime of runtimes.values()) await (await runtime).harness.close(BACKGROUND_CONTEXT);
}
