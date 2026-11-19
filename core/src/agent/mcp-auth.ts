import type { McpOAuthServerStore, McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import { mcpStore, type McpStoreHost } from "./mcp-store.js";

type AuthEntry = McpOAuthState & { expiresAt?: number };
type AuthDoc = Record<string, AuthEntry>;

const AUTH_PREFIX = "mcp__";
const SIGN_IN_TTL_MS = 10 * 60_000;
const authLocks = new WeakMap<McpStoreHost["storage"], Promise<unknown>>();

export function mcpAuthStore(host: McpStoreHost) {
  const storage = mcpStore(host);
  const read = async () => JSON.parse((await storage.readAuth()) ?? "{}") as AuthDoc;
  const write = (doc: AuthDoc) => storage.writeAuth(JSON.stringify(doc));

  // All credential mutations share a lock because the encrypted document contains every server.
  function withLock<T>(run: () => Promise<T>): Promise<T> {
    const next = (authLocks.get(host.storage) ?? Promise.resolve()).then(run);
    authLocks.set(host.storage, next.catch(() => undefined));
    return next;
  }

  return {
    withLock,
    server(name: string, serverUrl: string): McpOAuthServerStore {
      const legacyKey = AUTH_PREFIX + name;
      const key = `${legacyKey}|${serverUrl}`;
      return {
        async load() {
          const doc = await read();
          const legacy = doc[legacyKey];
          return doc[key] ?? (legacy?.serverUrl === serverUrl ? legacy : undefined);
        },
        async save(state) {
          const doc = await read();
          const previous = doc[key];
          const expiresAt = state.oauthState === undefined ? undefined
            : state.oauthState === previous?.oauthState ? previous.expiresAt
            : Date.now() + SIGN_IN_TTL_MS;
          doc[key] = { ...state, expiresAt };
          if (doc[legacyKey]?.serverUrl === serverUrl) delete doc[legacyKey];
          await write(doc);
        },
        withRefreshLock: withLock,
      };
    },
    async pending(state: string | null) {
      if (!state) return undefined;
      for (const [key, entry] of Object.entries(await read())) {
        const separator = key.indexOf("|");
        if (separator === -1 || !key.startsWith(AUTH_PREFIX) || entry.oauthState !== state || (entry.expiresAt ?? 0) <= Date.now()) continue;
        return { name: key.slice(AUTH_PREFIX.length, separator), entry };
      }
      return undefined;
    },
    remove(name: string): Promise<void> {
      return withLock(async () => {
        const prefix = AUTH_PREFIX + name;
        const doc = await read();
        const keys = Object.keys(doc).filter((key) => key === prefix || key.startsWith(prefix + "|"));
        if (keys.length === 0) return;
        for (const key of keys) delete doc[key];
        await write(doc);
      });
    },
  };
}
