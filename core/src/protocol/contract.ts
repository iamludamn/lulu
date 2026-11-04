export type BusyMode = "steer" | "followUp";

export interface ToolSlot {
  readonly callId: string;
  readonly name: string;
  readonly status: "pending" | "running" | "done";
}

export interface LiveState {
  readonly run?: unknown;
  readonly generation?: { readonly message?: unknown };
  readonly tools?: readonly ToolSlot[];
}

export type MessageState = "todo" | "processing" | "done";

export interface SubtaskProgress {
  id: string;
  description: string;
  running: boolean;
}

export interface MessageProgress {
  id: number;
  requestId: string;
  at: number | null;
  entry: string | null;
  answer: string | null;
  text: string;
  after: number | null;
  state: MessageState;
  error: string | null;
  subtasks: SubtaskProgress[];
}

export interface SessionProgress {
  messages: MessageProgress[];
  hiddenEntries: string[];
}

export interface ModelRef {
  provider: string;
  id: string;
}

export interface ModelConfig {
  model: ModelRef | null;
  overridden: boolean;
  models: ModelRef[];
}

export type Schedule = { kind: "once"; at: number } | { kind: "daily"; time: string; tz: string };

export type ScheduleEntry = {
  id: string;
  name: string;
  schedule: Schedule;
  state: "active" | "paused" | "done" | "missed";
  nextRunAt: number | null;
  lastRun: { scheduledFor: number; status: "running" | "done" | "failed" | "closed" } | null;
};

export interface McpStatus {
  readonly name: string;
  readonly source: "bot" | "platform";
  readonly state: "connected" | "failed" | "needs-auth";
  readonly tools: number;
  readonly error?: string;
  readonly checkedAt: number;
}

export interface MemoryCommit {
  readonly oid: string;
  readonly message: string;
  readonly at: number;
}

export interface MemoryListing {
  readonly files: readonly string[];
  readonly commits: readonly MemoryCommit[];
}

export const LIVE_DOC = "pi.live";
