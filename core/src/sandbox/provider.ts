import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
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

const idempotencyKeyOf = async (scope: string, key: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope}:${key}`))), (byte) => byte.toString(16).padStart(2, "0")).join("");

export function createSandboxProvider(env: Environment, scope: string, telemetry: TelemetryContext): SandboxProvider | undefined {
  const apiKey = env.E2B_API_KEY;
  if (!apiKey) return undefined;
  const template = env.E2B_TEMPLATE;
  return {
    create(key) {
      return telemetry.startSpan({ name: "sandbox.create", attributes: { "lulu.bot.id": scope, "lulu.sandbox.key": key, "lulu.sandbox.template": template ?? "default" } }, async (span) => {
        void sweep(apiKey).catch(() => undefined);
        const options = { apiKey, idempotencyKey: await idempotencyKeyOf(scope, key), timeoutMs: SANDBOX_IDLE_MS, metadata: METADATA, lifecycle: { onTimeout: "pause" as const } };
        const sandbox = template ? await Sandbox.create(template, options) : await Sandbox.create(options);
        span.setAttributes({ "lulu.sandbox.id": sandbox.sandboxId });
        const home = await sandbox.commands.run("pwd");
        return { id: sandbox.sandboxId, cwd: home.stdout.trim() };
      });
    },
    connect(handle) {
      return telemetry.startSpan({ name: "sandbox.connect", attributes: { "lulu.bot.id": scope, "lulu.sandbox.id": handle.id } }, async () => {
        return new SandboxExecutionEnv(await Sandbox.connect(handle.id, { apiKey, timeoutMs: SANDBOX_IDLE_MS }), handle.cwd, telemetry);
      });
    },
    kill(id) {
      return telemetry.startSpan({ name: "sandbox.kill", attributes: { "lulu.bot.id": scope, "lulu.sandbox.id": id } }, async () => {
        await Sandbox.kill(id, { apiKey });
      });
    },
  };
}
