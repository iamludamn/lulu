import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { MemoryResource } from "./doc.js";
import type { DurableHost } from "../host/types.js";

type Stub = Pick<DurableHost, "objects">;

const memory = (host: Stub, botId: string) => host.objects.MEMORY.getByName(botId);

export async function memoryCatalog(host: Stub, botId: string, telemetry: TelemetryContext): Promise<MemoryResource[]> {
  const traceparent = telemetry.propagation?.inject(telemetry)?.traceparent;
  const response = await memory(host, botId).fetch("https://memory/catalog", traceparent === undefined ? undefined : { headers: { traceparent } });
  if (!response.ok) throw new Error("Memory catalog unavailable");
  return response.json() as Promise<MemoryResource[]>;
}

export async function memoryRemember(host: Stub, botId: string, requestId: string, conversationId: string, through: number): Promise<void> {
  const response = await memory(host, botId).fetch(`https://memory/remember?through=${through}`, { method: "POST", headers: { "x-lulu-request-id": requestId, "x-lulu-conversation-id": conversationId } });
  if (!response.ok) throw new Error(`memory update failed (${response.status})`);
}

export async function readMemoryResource(host: Stub, botId: string, resource: MemoryResource): Promise<string | undefined> {
  const query = new URLSearchParams({ path: resource.contentRef, version: resource.version });
  const response = await memory(host, botId).fetch(`https://memory/file?${query}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Memory resource read failed (${response.status})`);
  return response.text();
}

export async function memoryRetrieve(host: Stub, botId: string, input: import("./retrieval.js").RetrievalInput): Promise<import("./doc.js").MemoryInjection> {
  const response = await memory(host, botId).fetch("https://memory/retrieve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error("Memory retrieval failed");
  return response.json() as Promise<import("./doc.js").MemoryInjection>;
}
