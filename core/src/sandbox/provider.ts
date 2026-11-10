import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export type SandboxHandle = { id: string; cwd: string };

export class SandboxGone extends Error {}

export interface SandboxProvider {
  create(key: string): Promise<SandboxHandle>;
  connect(handle: SandboxHandle): Promise<ExecutionEnv>;
}
