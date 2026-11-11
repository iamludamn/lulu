import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { Environment } from "../host/types.js";
import { createE2bProvider, type E2bProviderConfig } from "./e2b/provider.js";
import type { SandboxProvider } from "./provider.js";

type BackendConfig = E2bProviderConfig & { type: "e2b" };
const CONFIG_FIELDS = new Set(["domain", "apiUrl", "sandboxUrl", "template", "apiKeyEnv"]);

function readConfigs(value: string | undefined): Record<string, BackendConfig> {
  if (!value) return { e2b: { type: "e2b" } };
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SANDBOX_BACKENDS must be an object");
  const configs: Record<string, BackendConfig> = { e2b: { type: "e2b" } };
  for (const [name, config] of Object.entries(parsed)) {
    if (!name || !config || typeof config !== "object" || Array.isArray(config) || !("type" in config) || config.type !== "e2b") throw new Error(`Invalid sandbox backend configuration: ${name}`);
    for (const [field, setting] of Object.entries(config)) {
      if (field !== "type" && (!CONFIG_FIELDS.has(field) || typeof setting !== "string" || !setting)) throw new Error(`Invalid sandbox backend field: ${name}.${field}`);
    }
    Object.defineProperty(configs, name, { value: config, enumerable: true, configurable: true, writable: true });
  }
  return configs;
}

export function createSandboxProvider(env: Environment, scope: string, telemetry: TelemetryContext): SandboxProvider | undefined {
  const backend = env.SANDBOX_BACKEND ?? "e2b";
  const providers = new Map<string, SandboxProvider>();
  for (const [name, config] of Object.entries(readConfigs(env.SANDBOX_BACKENDS))) {
    const provider = createE2bProvider(env, scope, telemetry, name, config);
    if (provider) providers.set(name, provider);
  }
  const selected = providers.get(backend);
  if (!selected && !env.SANDBOX_BACKENDS && !env.SANDBOX_BACKEND) return undefined;
  const get = (name: string): SandboxProvider => {
    const provider = providers.get(name);
    if (!provider) throw new Error(`Sandbox backend is not configured: ${name}`);
    return provider;
  };
  return {
    backend,
    profile: selected?.profile ?? "default",
    open: (request, context) => get(request.backend).open(request, context),
    renew: (ref, context) => get(ref.backend).renew(ref, context),
    idle: (ref, requestId, context) => get(ref.backend).idle(ref, requestId, context),
    destroy: (ref, requestId, context) => get(ref.backend).destroy(ref, requestId, context),
  };
}
