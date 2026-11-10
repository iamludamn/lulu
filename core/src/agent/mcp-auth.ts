import type { AuthProvider, UnauthorizedContext } from "@earendil-works/pi-mcp";
import { refreshAuthorization } from "@earendil-works/pi-mcp/oauth";
import type { McpHostServices } from "../host/types.js";

type RefreshOptions = Parameters<typeof refreshAuthorization>[1];

const REFRESH_SKEW_MS = 60_000;
const refreshes = new WeakMap<McpHostServices, Promise<unknown>>();

interface StoredTokens {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly [key: string]: unknown;
}

interface StoredAuth {
  readonly discovery?: {
    readonly authorizationServerUrl?: string;
    readonly authorizationServerMetadata?: unknown;
    readonly resourceMetadata?: { readonly resource?: string };
  };
  readonly clientInformation?: unknown;
  readonly tokens?: StoredTokens;
  readonly tokensExpireAt?: number;
}

function expiryOf(tokens: StoredTokens): number | undefined {
  return typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : undefined;
}

async function readAll(host: McpHostServices): Promise<Record<string, StoredAuth>> {
  try {
    return JSON.parse((await host.readMcpAuth()) ?? "{}") as Record<string, StoredAuth>;
  } catch {
    return {};
  }
}

export function authKey(name: string, serverUrl: string): string {
  return `mcp__${name}|${serverUrl}`;
}

export class McpFileAuthProvider implements AuthProvider {
  constructor(
    private readonly name: string,
    private readonly serverUrl: string,
    private readonly host: McpHostServices,
  ) {}

  private key(state: Record<string, StoredAuth>): string | undefined {
    const exact = authKey(this.name, this.serverUrl);
    if (state[exact] !== undefined) return exact;
    const legacy = `mcp__${this.name}`;
    return state[legacy] === undefined ? undefined : legacy;
  }

  private async current(): Promise<{ all: Record<string, StoredAuth>; key: string | undefined; state: StoredAuth | undefined }> {
    const all = await readAll(this.host);
    const key = this.key(all);
    return { all, key, state: key === undefined ? undefined : all[key] };
  }

  async token(): Promise<string | undefined> {
    const { state } = await this.current();
    const stored = state?.tokens;
    if (stored?.access_token === undefined) return undefined;
    const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
    if (expired && stored.refresh_token !== undefined) await this.refresh();
    return (await this.current()).state?.tokens?.access_token ?? stored.access_token;
  }

  async onUnauthorized(context: UnauthorizedContext): Promise<void> {
    const { state } = await this.current();
    if (state?.tokens?.access_token === context.token) return;
    await this.refresh();
  }

  private refresh(): Promise<void> {
    const previous = refreshes.get(this.host) ?? Promise.resolve();
    const next = previous.then(() => this.renew());
    refreshes.set(this.host, next.catch(() => undefined));
    return next;
  }

  private async renew(): Promise<void> {
    const { all, key, state } = await this.current();
    if (key === undefined || state === undefined) return;
    const refreshToken = state.tokens?.refresh_token;
    const serverUrl = state.discovery?.authorizationServerUrl;
    if (refreshToken === undefined || serverUrl === undefined || state.clientInformation === undefined) return;
    const metadata = state.discovery?.authorizationServerMetadata as RefreshOptions["metadata"];
    const tokens = await refreshAuthorization(serverUrl, {
      clientInformation: state.clientInformation as RefreshOptions["clientInformation"],
      refreshToken,
      ...(metadata === undefined ? {} : { metadata }),
      ...(state.discovery?.resourceMetadata?.resource === undefined ? {} : { resource: state.discovery.resourceMetadata.resource }),
    });
    const updated: StoredTokens = tokens as unknown as StoredTokens;
    all[key] = { ...state, tokens: updated, ...(expiryOf(updated) === undefined ? {} : { tokensExpireAt: expiryOf(updated) }) };
    await this.host.writeMcpAuth(`${JSON.stringify(all, null, 2)}\n`);
  }
}
