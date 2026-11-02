import type { DurableStorage } from "../host/types.js";

const FILE = "file:";
const BYTES = "bytes:";
const GIT_DIR = ".git/";

export function legacySource(storage: DurableStorage) {
  return {
    files: async (): Promise<string[]> =>
      [...(await storage.list({ prefix: FILE })).keys()].map((key) => key.slice(FILE.length)).filter((path) => !path.startsWith(GIT_DIR)),
    read: async (path: string): Promise<string | undefined> => {
      const bytes = await storage.get<Uint8Array>(BYTES + path);
      return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
    },
  };
}
