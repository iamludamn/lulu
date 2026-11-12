import type { DurableHost } from "../host/types.js";
import type { ReadableFiles } from "./files.js";

type Stub = Pick<DurableHost, "objects">;

const memory = (host: Stub, botId: string) => host.objects.MEMORY.getByName(botId);

export async function memoryContext(host: Stub, botId: string): Promise<string> {
  const response = await memory(host, botId).fetch("https://memory/context");
  if (!response.ok) throw new Error(`memory context failed (${response.status})`);
  return response.text();
}

export async function memoryRemember(host: Stub, botId: string, requestId: string, conversationId: string, through: number): Promise<void> {
  const response = await memory(host, botId).fetch(`https://memory/remember?through=${through}`, { method: "POST", headers: { "x-lulu-request-id": requestId, "x-lulu-conversation-id": conversationId } });
  if (!response.ok) throw new Error(`memory update failed (${response.status})`);
}

export function remoteFiles(host: Stub, botId: string): ReadableFiles {
  return {
    files: async () => {
      const response = await memory(host, botId).fetch("https://memory/listing");
      if (!response.ok) throw new Error(`memory listing failed (${response.status})`);
      return ((await response.json()) as { files: string[] }).files;
    },
    read: async (path) => {
      const response = await memory(host, botId).fetch(`https://memory/file?path=${encodeURIComponent(path)}`);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`memory file failed (${response.status})`);
      return response.text();
    },
  };
}
