import type { McpStatus } from "./contract.js";

export interface McpServerView {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface McpRegistryView {
  readonly servers: readonly McpServerView[];
  readonly statuses: readonly McpStatus[];
}

export interface McpServerInput {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface McpCatalogValue {
  readonly description?: string;
  readonly default?: string;
  readonly placeholder?: string;
  readonly value?: string;
  readonly isRequired?: boolean;
  readonly isSecret?: boolean;
  readonly format?: string;
  readonly choices?: readonly string[];
}

export interface McpCatalogHeader extends McpCatalogValue {
  readonly name: string;
  readonly variables?: Readonly<Record<string, McpCatalogValue>>;
}

export interface McpCatalogRemote {
  readonly url: string;
  readonly headers: readonly McpCatalogHeader[];
  readonly variables: Readonly<Record<string, McpCatalogValue>>;
}

export interface McpCatalogServer {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly websiteUrl?: string;
  readonly remotes: readonly McpCatalogRemote[];
}

export interface McpCatalogPage {
  readonly servers: readonly McpCatalogServer[];
  readonly nextCursor?: string;
  readonly fetchedAt: number;
  readonly stale: boolean;
}

export const MCP_MASK = "***";
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;
