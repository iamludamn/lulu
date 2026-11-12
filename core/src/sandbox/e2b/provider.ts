import { serviceUsage } from "../../telemetry/service.js";
import type { Context } from "@earendil-works/chord";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { NotFoundError, Sandbox } from "e2b";
import type { Environment } from "../../host/types.js";
import { WorkspaceLost, type SandboxProvider, type SandboxRef } from "../provider.js";
import { SANDBOX_LEASE_MS } from "../doc.js";
import { E2bExecutionEnv } from "./env.js";

const idempotencyKeyOf = async (scope: string, key: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope}:${key}`))), (byte) => byte.toString(16).padStart(2, "0")).join("");

const idOf = (ref: SandboxRef): string => {
  if (typeof ref.resource.id !== "string") throw new Error("Invalid E2B sandbox reference");
  return ref.resource.id;
};

async function existing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw error instanceof NotFoundError ? new WorkspaceLost(error.message) : error;
  }
}

export type E2bProviderConfig = { domain?: string; apiUrl?: string; sandboxUrl?: string; template?: string; apiKeyEnv?: string };

export function createE2bProvider(env: Environment, scope: string, telemetry: TelemetryContext, backend = "e2b", config: E2bProviderConfig = {}): SandboxProvider | undefined {
  const apiKey = env[config.apiKeyEnv ?? "E2B_API_KEY"];
  if (!apiKey) return undefined;
  const domain = config.domain ?? env.E2B_DOMAIN ?? "e2b.app";
  const apiUrl = config.apiUrl ?? env.E2B_API_URL ?? `https://api.${domain}`;
  const sandboxUrl = config.sandboxUrl ?? env.E2B_SANDBOX_URL;
  const profile = config.template ?? env.E2B_TEMPLATE ?? "default";
  const options = (context: Context) => ({ apiKey, domain, apiUrl, ...(sandboxUrl ? { sandboxUrl } : {}), signal: context.abortSignal, requestTimeoutMs: 30_000 });
  const measured = <T>(operation: string, run: () => Promise<T>) => serviceUsage(telemetry, backend, operation, run);
  return {
    backend,
    profile,
    open(request, context) {
      return telemetry.startSpan({ name: "sandbox.open", attributes: { "lulu.bot.id": scope, "lulu.sandbox.backend": backend, "lulu.sandbox.key": request.key } }, async (span) => {
        let sandbox;
        if (request.ref) {
          const id = idOf(request.ref);
          sandbox = await existing(() => measured("connect", () => Sandbox.connect(id, { ...options(context), timeoutMs: SANDBOX_LEASE_MS })));
        } else {
          const createOptions = { ...options(context), idempotencyKey: await idempotencyKeyOf(scope, `${backend}:${request.requestId}`), timeoutMs: SANDBOX_LEASE_MS, metadata: { app: "pistack", scope, workspace: request.key, backend }, lifecycle: { onTimeout: "pause" as const } };
          sandbox = request.profile === "default" ? await measured("create", () => Sandbox.create(createOptions)) : await measured("create", () => Sandbox.create(request.profile, createOptions));
          const id = sandbox.sandboxId;
          sandbox = await existing(() => measured("connect", () => Sandbox.connect(id, { ...options(context), timeoutMs: SANDBOX_LEASE_MS })));
        }
        const cwd = request.cwd || (await sandbox.commands.run("pwd", { signal: context.abortSignal })).stdout.trim();
        const ref: SandboxRef = { backend, resource: { id: sandbox.sandboxId } };
        span.setAttributes({ "lulu.sandbox.id": sandbox.sandboxId });
        return { ref, cwd, env: new E2bExecutionEnv(sandbox, cwd, telemetry, scope, backend) };
      });
    },
    renew: (ref, context) => existing(() => measured("renew", () => Sandbox.setTimeout(idOf(ref), SANDBOX_LEASE_MS, options(context)))),
    async idle(ref, _requestId, context) {
      await existing(() => measured("pause", () => Sandbox.pause(idOf(ref), options(context))));
      return ref;
    },
    async destroy(ref, _requestId, context) {
      try {
        await measured("kill", () => Sandbox.kill(idOf(ref), options(context)));
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    },
  };
}
