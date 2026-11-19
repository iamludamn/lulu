import { defineTask, type Task } from "@earendil-works/pi-durable";

export const PREVIOUS_SANDBOX_APP = "pistack";

export const STORED_EXTENSION_NAMES = {
  artifact: "pistack.artifact",
  chat: "pistack.chat",
  cron: "pistack.cron",
  delegate: "pistack.delegate",
  environment: "pistack.environment",
  mcp: "pistack.mcp",
  memory: "pistack.memory",
  memoryAgent: "pistack.memory-agent",
  memoryRetrieval: "pistack.memory-retrieval",
  panel: "pistack.panel",
  send: "pistack.send",
} as const;

export const STORED_DOC_KINDS = {
  assets: "pistack.assets",
  chatMessages: "pistack.chat.messages",
  cronJobs: "pistack.cron.jobs",
  delegateIndex: "pistack.delegate.index",
  delegateRun: "pistack.delegate.run",
  delivery: "pistack.delivery",
  make: "pistack.make",
  panel: "pistack.panel",
  sandbox: "pistack.sandbox",
  spaceRefresh: "pistack.space-refresh",
  spaceRefreshIndex: "pistack.space-refresh-index",
} as const;

export const RENAMED_TASKS = {
  delegateAnchor: { current: "lulu.delegate.anchor", previous: "pistack.delegate.anchor" },
  delegateWait: { current: "lulu.delegate.wait", previous: "pistack.delegate.wait" },
  memoryUpdate: { current: "lulu.memory.update", previous: "pistack.memory.update" },
  sandboxLifecycle: { current: "lulu.sandbox.lifecycle", previous: "pistack.sandbox.lifecycle" },
} as const;

export function withPreviousTaskName<Input, Checkpoint extends { phase: string }, Result, Hooks extends object>(
  task: Task<Input, Checkpoint, Result, Hooks>,
  previousName: string,
) {
  return [task, defineTask({ ...task.definition, name: previousName })];
}
