import type { McpRegistryView, McpServerInput } from "@lulu/core/protocol/mcp.js";

const BASE = "/api/bots/main/mcp";
const TOKEN_KEY = "lulu.mcp.token";

export class Unauthorized extends Error {}

export function savedToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveToken(token: string): void {
  try {
    if (token === "") localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    return;
  }
}

async function call<T>(token: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (response.status === 401) throw new Unauthorized(data.error);
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}

const server = (name: string): string => `/servers/${encodeURIComponent(name)}`;

export const registry = {
  list: (token: string) => call<McpRegistryView>(token, ""),
  reload: (token: string) => call<McpRegistryView>(token, "/reload", "POST"),
  save: (token: string, name: string, input: McpServerInput) => call<McpRegistryView>(token, server(name), "PUT", input),
  remove: (token: string, name: string) => call<McpRegistryView>(token, server(name), "DELETE"),
  login: (token: string, name: string) => call<Partial<McpRegistryView> & { authorizationUrl?: string }>(token, `${server(name)}/login`, "POST"),
};
