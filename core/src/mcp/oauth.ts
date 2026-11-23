import { authorizeMcp, McpOAuthProvider, type McpOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import { mcpAuthStore } from "./auth.js";
import type { RegistryHooks } from "./registry.js";
import { McpRegistryError } from "./config.js";
import { mcpStore, type McpStoreHost } from "./store.js";

function provider(host: McpStoreHost, origin: string, serverUrl: string, store: McpOAuthStateStore, onRedirect = (_url: URL) => {}): McpOAuthProvider {
  return new McpOAuthProvider({
    serverUrl,
    redirectUrl: `${origin}/api/bots/${host.name}/mcp/callback`,
    clientMetadata: { client_name: "lulu" },
    store,
    onRedirect,
  });
}

export async function loginMcp(host: McpStoreHost, name: string, origin: string): Promise<Response> {
  const config = (await mcpStore(host).servers())[name];
  if (config === undefined) throw new McpRegistryError(404, `Unknown server "${name}"`);
  if (Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization")) {
    throw new McpRegistryError(400, "This server sends its own Authorization header");
  }
  const auth = mcpAuthStore(host);
  try {
    return await auth.withLock(async () => {
      const store = auth.server(name, config.url);
      const saved = await store.load();
      if (saved?.oauthState !== undefined) await store.save({ ...saved, oauthState: undefined, codeVerifier: undefined });
      let authorizationUrl: string | undefined;
      const oauth = provider(host, origin, config.url, store, (url) => { authorizationUrl = url.href; });
      // An explicit sign-in opens the provider even if the stored grant can still be refreshed.
      await authorizeMcp(oauth, { serverUrl: config.url, skipRefresh: true, signal: AbortSignal.timeout(15_000) });
      if (authorizationUrl === undefined) throw new Error("The authorization server gave no authorization URL");
      return Response.json({ authorizationUrl });
    });
  } catch (error) {
    throw new McpRegistryError(502, error instanceof Error ? error.message : String(error));
  }
}

export async function callbackMcp(host: McpStoreHost, hooks: RegistryHooks, params: URLSearchParams, origin: string): Promise<Response> {
  const back = (query: Record<string, string>): Response => Response.redirect(`${origin}/mcp?${new URLSearchParams(query)}`, 302);
  const auth = mcpAuthStore(host);
  let server: string | undefined;
  try {
    const result = await auth.withLock(async () => {
      const pending = await auth.pending(params.get("state"));
      if (pending === undefined) return back({ error: "Unknown or expired sign-in" });
      const { name, entry } = pending;
      server = name;
      const store = auth.server(name, entry.serverUrl);
      await store.save({ ...entry, oauthState: undefined });
      const config = (await mcpStore(host).servers())[name];
      if (config?.url !== entry.serverUrl) return back({ error: "The server changed. Connect again.", server: name });
      if (params.has("error")) return back({ error: params.get("error_description") ?? params.get("error") ?? "Sign-in was refused", server: name });
      const code = params.get("code");
      if (!code) return back({ error: "The authorization response had no code", server: name });
      await authorizeMcp(provider(host, origin, entry.serverUrl, store), {
        serverUrl: entry.serverUrl,
        authorizationCode: code,
        signal: AbortSignal.timeout(15_000),
        iss: params.get("iss") ?? undefined,
      });
      return name;
    });
    if (typeof result !== "string") return result;
    await hooks.reload(result);
    return back({ login: result });
  } catch (error) {
    return back({ error: error instanceof Error ? error.message : String(error), ...(server === undefined ? {} : { server }) });
  }
}
