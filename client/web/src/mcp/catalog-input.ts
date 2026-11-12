import type { McpCatalogRemote, McpCatalogServer, McpCatalogValue, McpServerInput } from "@lulu/core/protocol/mcp.js";

export interface CatalogField extends McpCatalogValue {
  readonly id: string;
  readonly label: string;
}

const placeholders = (value: string): string[] => [...value.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);

export function catalogFields(remote: McpCatalogRemote): CatalogField[] {
  const urlFields = [...new Set(placeholders(remote.url))].map((name) => ({ ...remote.variables[name], id: `url:${name}`, label: name, isRequired: true }));
  const headerFields = remote.headers.flatMap((header): CatalogField[] => header.value === undefined
    ? [{ ...header, id: `header:${header.name}`, label: header.name }]
    : [...new Set(placeholders(header.value))].filter((name) => header.variables?.[name] !== undefined).map((name) => ({ ...header.variables?.[name], id: `header:${header.name}:${name}`, label: `${header.name} · ${name}`, isRequired: header.isRequired, isSecret: header.isSecret || header.variables?.[name].isSecret })));
  return [...urlFields, ...headerFields];
}

const fieldValue = (field: CatalogField, values: Readonly<Record<string, string>>): string => field.value ?? values[field.id] ?? field.default ?? "";

export function catalogInput(remote: McpCatalogRemote, values: Readonly<Record<string, string>>): McpServerInput | undefined {
  const fields = catalogFields(remote);
  if (fields.some((field) => {
    const value = fieldValue(field, values);
    return (field.isRequired && value.trim() === "") || (value !== "" && field.choices !== undefined && !field.choices.includes(value));
  })) return undefined;
  const url = remote.url.replace(/\{([^{}]+)\}/g, (_match: string, name: string) => encodeURIComponent(fieldValue(fields.find((field) => field.id === `url:${name}`)!, values)));
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username !== "" || parsed.password !== "") return undefined;
  } catch { return undefined; }
  const headers = Object.fromEntries(remote.headers.flatMap((header) => {
    const value = header.value === undefined ? fieldValue({ ...header, id: `header:${header.name}`, label: header.name }, values)
      : header.value.replace(/\{([^{}]+)\}/g, (match: string, name: string) => {
        const field = fields.find((field) => field.id === `header:${header.name}:${name}`);
        return field === undefined ? match : fieldValue(field, values);
      });
    const incomplete = fields.some((field) => field.id.startsWith(`header:${header.name}:`) && fieldValue(field, values).trim() === "");
    return value === "" || incomplete ? [] : [[header.name, value]];
  }));
  return { url, headers };
}

export function catalogName(server: McpCatalogServer, taken: readonly string[]): string {
  const base = (server.title.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || server.name.split("/").at(-1)?.replace(/[^a-zA-Z0-9_-]/g, "-") || "connection").slice(0, 60);
  const used = new Set([...taken, "artifact", "tavily", "exa"].map((name) => name.replaceAll("-", "_")));
  let name = base;
  for (let suffix = 2; used.has(name.replaceAll("-", "_")); suffix++) name = `${base}-${suffix}`;
  return name;
}
