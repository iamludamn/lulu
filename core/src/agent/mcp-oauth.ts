import { authorizeMcp, McpOAuthProvider, type McpOAuthState, type McpOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import { authKey } from "./mcp-auth.js";
import type { RegistryHost, RegistryHooks } from "./mcp-registry.js";
import { McpRegistryError } from "./mcp-config.js";
import { mcpStore } from "./mcp-store.js";

type AuthDoc = Record<string, McpOAuthState & { expiresAt?: number }>;
const AUTH_PREFIX = "mcp__";
const json = (body: unknown): Response => Response.json(body);

async function readAuth(host: RegistryHost): Promise<AuthDoc> {
  try {
    return JSON.parse((await mcpStore(host, host.name).readAuth()) ?? "{}") as AuthDoc;
  } catch {
    return {};
  }
}

const writeAuth = (host: RegistryHost, doc: AuthDoc): Promise<void> => mcpStore(host, host.name).writeAuth(`${JSON.stringify(doc, null, 2)}\n`);

function authStore(host: RegistryHost, key: string): McpOAuthStateStore {
  return {
    async load() {
      return (await readAuth(host))[key];
    },
    async save(state) {
      const doc = await readAuth(host);
      doc[key] = { ...state, ...(state.oauthState === undefined ? {} : { expiresAt: doc[key]?.expiresAt ?? Date.now() + 10 * 60_000 }) };
      await writeAuth(host, doc);
    },
  };
}

function provider(host: RegistryHost, origin: string, key: string, serverUrl: string, onRedirect: (url: URL) => void): McpOAuthProvider {
  return new McpOAuthProvider({
    serverUrl,
    redirectUrl: `${origin}/api/bots/${host.name}/mcp/callback`,
    clientMetadata: { client_name: "lulu" },
    store: authStore(host, key),
    onRedirect,
  });
}

export async function loginMcp(host: RegistryHost, hooks: RegistryHooks, name: string, origin: string): Promise<Response> {
  const config = (await mcpStore(host, host.name).servers())[name];
  if (config === undefined) throw new McpRegistryError(404, `Unknown server "${name}"`);
  if (Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization")) {
    throw new McpRegistryError(400, "This server sends its own Authorization header");
  }
  let authorizationUrl: URL | undefined = undefined;
  const key = authKey(name, config.url);
  const doc = await readAuth(host);
  if (doc[key] !== undefined) {
    const { oauthState: _state, codeVerifier: _verifier, expiresAt: _expiresAt, ...saved } = doc[key];
    doc[key] = saved;
    await writeAuth(host, doc);
  }
  const oauth = provider(host, origin, key, config.url, (url) => {
    authorizationUrl = url;
  });
  try {
    if ((await authorizeMcp(oauth, { serverUrl: config.url, skipRefresh: true, signal: AbortSignal.timeout(15_000) })) === "AUTHORIZED") {
      await hooks.reload(name);
      return json({ authorized: true });
    }
  } catch (error) {
    throw new McpRegistryError(502, error instanceof Error ? error.message : String(error));
  }
  if (authorizationUrl === undefined) throw new McpRegistryError(502, "The authorization server gave no authorization URL");
  return json({ authorizationUrl: String(authorizationUrl) });
}

export async function callbackMcp(host: RegistryHost, hooks: RegistryHooks, params: URLSearchParams, origin: string): Promise<Response> {
  const back = (query: Record<string, string>): Response => Response.redirect(`${origin}/mcp?${new URLSearchParams(query)}`, 302);
  const state = params.get("state");
  const code = params.get("code");
  const doc = await readAuth(host);
  const key = state === null || state === "" ? undefined : Object.keys(doc).find((candidate) => doc[candidate]?.oauthState === state);
  const entry = key === undefined ? undefined : doc[key];
  if (key === undefined || entry === undefined || entry.expiresAt === undefined || entry.expiresAt < Date.now()) return back({ error: "Unknown or expired sign-in" });
  const name = key.slice(AUTH_PREFIX.length, key.indexOf("|"));
  const config = (await mcpStore(host, host.name).servers())[name];
  const { oauthState: _state, expiresAt: _expiresAt, ...saved } = entry;
  doc[key] = saved;
  await writeAuth(host, doc);
  if (config?.url !== entry.serverUrl) return back({ error: "The server changed. Connect again.", server: name });
  if (params.has("error")) return back({ error: params.get("error_description") ?? params.get("error") ?? "Sign-in was refused", server: name });
  if (code === null) return back({ error: "The authorization response had no code", server: name });
  try {
    await authorizeMcp(provider(host, origin, key, entry.serverUrl, () => undefined), {
      serverUrl: entry.serverUrl,
      authorizationCode: code,
      signal: AbortSignal.timeout(15_000),
      ...(params.has("iss") ? { iss: params.get("iss") as string } : {}),
    });
    await hooks.reload(name);
  } catch (error) {
    return back({ error: error instanceof Error ? error.message : String(error), server: name });
  }
  return back({ login: name });
}

export async function removeMcpAuth(host: RegistryHost, name: string): Promise<void> {
  const doc = await readAuth(host);
  const kept = Object.entries(doc).filter(([key]) => key !== `${AUTH_PREFIX}${name}` && !key.startsWith(`${AUTH_PREFIX}${name}|`));
  if (kept.length !== Object.keys(doc).length) await writeAuth(host, Object.fromEntries(kept));
}
