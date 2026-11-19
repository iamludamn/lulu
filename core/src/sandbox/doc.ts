import { defineDoc, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import type { SandboxRef } from "./provider.js";
import { STORED_DOC_KINDS } from "../durable-names.js";

export const SANDBOX_KIND = STORED_DOC_KINDS.sandbox;
export const SANDBOX_IDLE_MS = 120_000;
export const SANDBOX_RENEW_MS = 30_000;
export const SANDBOX_LEASE_MS = 120_000;
export const SANDBOX_RETENTION_MS = 7 * 86_400_000;

export type SandboxOperation = { taskId: TaskId; kind: "open" | "renew" | "idle" | "destroy"; requestId: string };
export type SandboxLease = { taskId: TaskId; expiresAt: number };
export type SandboxBinding = {
  key: string | null;
  owner: ConversationId | null;
  backend: string | null;
  createApp?: string;
  profile: string;
  ref: SandboxRef | null;
  cwd: string;
  epoch: number;
  revision: number;
  users: SandboxLease[];
  operation: SandboxOperation | null;
  lifecycleTaskId: TaskId | null;
  lastUsedAt: number;
  idleSince: number | null;
  lost: boolean;
  error: string | null;
};

const initial = (): SandboxBinding => ({ key: null, owner: null, backend: null, profile: "default", ref: null, cwd: "", epoch: 0, revision: 0, users: [], operation: null, lifecycleTaskId: null, lastUsedAt: 0, idleSince: null, lost: false, error: null });

export const SandboxDoc = defineDoc<SandboxBinding>({
  kind: SANDBOX_KIND,
  version: 3,
  migrate: (value) => {
    const { id, ...state } = value;
    return { ...initial(), ...state, backend: id ? "e2b" : null, ref: id ? { backend: "e2b", resource: { id } } : null, lastUsedAt: Date.now() } as SandboxBinding;
  },
  scope: "conversation",
  checkpointWhen: () => false,
  history: "latest",
  fork: "initial",
  initial,
});
