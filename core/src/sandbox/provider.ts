import type { Context } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export type SandboxRef = { backend: string; resource: JsonObject };
export type SandboxRequest = { backend: string; profile: string; key: string; requestId: string; createApp?: string; ref: SandboxRef | null; cwd: string };
export type OpenedSandbox = { ref: SandboxRef; cwd: string; env: ExecutionEnv };

export class WorkspaceLost extends Error {}

export interface SandboxProvider {
  readonly backend: string;
  readonly profile: string;
  open(request: SandboxRequest, context: Context): Promise<OpenedSandbox>;
  renew(ref: SandboxRef, context: Context): Promise<void>;
  idle(ref: SandboxRef, requestId: string, context: Context): Promise<SandboxRef>;
  destroy(ref: SandboxRef, requestId: string, context: Context): Promise<void>;
}
