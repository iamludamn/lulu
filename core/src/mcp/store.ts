import type { DurableHost } from "../host/types.js";
import type { McpServerConfig } from "./extension.js";

function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

async function keyOf(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(secret: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyOf(secret), bytesOf(text)));
  const sealed = new Uint8Array(iv.length + cipher.length);
  sealed.set(iv);
  sealed.set(cipher, iv.length);
  return toBase64(sealed);
}

async function open(secret: string, sealed: string): Promise<string> {
  const bytes = fromBase64(sealed);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await keyOf(secret), bytes.slice(12));
  return new TextDecoder().decode(plain);
}

export type McpStoreHost = Pick<DurableHost, "env" | "kv" | "storage" | "name">;

export function mcpStore(host: McpStoreHost) {
  const secret = host.env.MCP_ENCRYPTION_KEY;
  const configPrefix = `mcp:config:${host.name}:`;
  const authKey = `mcp:auth:${host.name}`;
  return {
    async readAuth(): Promise<string | undefined> {
      if (secret === undefined) return undefined;
      const stored = await host.storage.get<string>(authKey);
      const sealed = stored ?? await host.kv.get(authKey);
      return sealed === null ? undefined : open(secret, sealed);
    },
    async writeAuth(content: string): Promise<void> {
      if (secret === undefined) throw new Error("MCP_ENCRYPTION_KEY is not configured");
      await host.storage.put({ [authKey]: await seal(secret, content) });
    },
    async put(name: string, config: Pick<McpServerConfig, "url" | "headers">): Promise<void> {
      if (secret === undefined) throw new Error("MCP_ENCRYPTION_KEY is not configured");
      await host.kv.put(configPrefix + name, await seal(secret, JSON.stringify(config)));
    },
    async remove(name: string): Promise<void> {
      await host.kv.delete(configPrefix + name);
    },
    async servers(): Promise<Record<string, McpServerConfig>> {
      if (secret === undefined) return {};
      const servers = Object.create(null) as Record<string, McpServerConfig>;
      for (const name of await host.kv.list(configPrefix)) {
        const sealed = await host.kv.get(name);
        if (sealed === null) continue;
        servers[name.slice(configPrefix.length)] = JSON.parse(await open(secret, sealed)) as McpServerConfig;
      }
      return servers;
    },
  };
}
