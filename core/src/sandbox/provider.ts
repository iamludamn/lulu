import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Sandbox } from "e2b";
import type { Environment } from "../host/types.js";
import { SANDBOX_IDLE_MS, SandboxExecutionEnv } from "./env.js";

const RETENTION_MS = 7 * 86_400_000;
const SWEEP_INTERVAL_MS = 86_400_000;
const METADATA = { app: "pistack" };

let sweptAt = 0;

export type SandboxHandle = { id: string; cwd: string };

export interface SandboxProvider {
  create(key: string): Promise<SandboxHandle>;
  connect(handle: SandboxHandle): Promise<ExecutionEnv>;
  kill(id: string): Promise<void>;
}

async function sweep(apiKey: string): Promise<void> {
  const now = Date.now();
  if (now - sweptAt < SWEEP_INTERVAL_MS) return;
  sweptAt = now;
  const pages = Sandbox.list({ apiKey, query: { metadata: METADATA, state: ["paused"] } });
  while (pages.hasNext) {
    for (const sandbox of await pages.nextItems()) {
      if (now - sandbox.endAt.getTime() > RETENTION_MS) await Sandbox.kill(sandbox.sandboxId, { apiKey });
    }
  }
}

export function createSandboxProvider(env: Environment, scope: string): SandboxProvider | undefined {
  const apiKey = env.E2B_API_KEY;
  if (!apiKey) return undefined;
  const template = env.E2B_TEMPLATE;
  return {
    async create(key) {
      void sweep(apiKey).catch(() => undefined);
      const options = { apiKey, idempotencyKey: `${scope}:${key}`, timeoutMs: SANDBOX_IDLE_MS, metadata: METADATA, lifecycle: { onTimeout: "pause" as const } };
      const sandbox = template ? await Sandbox.create(template, options) : await Sandbox.create(options);
      const home = await sandbox.commands.run("pwd");
      return { id: sandbox.sandboxId, cwd: home.stdout.trim() };
    },
    async connect(handle) {
      return new SandboxExecutionEnv(await Sandbox.connect(handle.id, { apiKey, timeoutMs: SANDBOX_IDLE_MS }), handle.cwd);
    },
    async kill(id) {
      await Sandbox.kill(id, { apiKey });
    },
  };
}
