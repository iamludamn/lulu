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

export const MCP_MASK = "***";
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;
