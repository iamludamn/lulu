import type { ArtifactObject } from "./object.js";
import { SKILLS } from "./skills.js";

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_LIMIT = 100;
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

type Args = Record<string, unknown>;

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly properties: Record<string, unknown>;
  readonly required: string[];
  run(store: ArtifactObject, args: Args): Promise<unknown>;
}

const text = { type: "string" };
const name = { type: "string", description: "Relative path such as reports/q3.md" };
const version = { type: "integer", description: "Defaults to the latest version" };
const requestId = { type: "string", description: "Idempotency key; retries with the same value return the same result" };

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const optionalString = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const edits = (value: unknown): { old_str: string; new_str: string }[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error("edits must be a non-empty array of { old_str, new_str }");
  return value.map((item) => {
    const pair = item as { old_str?: unknown; new_str?: unknown };
    if (typeof pair.old_str !== "string" || typeof pair.new_str !== "string") throw new Error("each edit needs string old_str and new_str");
    return { old_str: pair.old_str, new_str: pair.new_str };
  });
};
const optionalInt = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) ? value : undefined);

const TOOLS: Tool[] = [
  {
    name: "list",
    description: "List the latest version of each saved artifact, optionally under a name prefix.",
    properties: { prefix: text, limit: { type: "integer" } },
    required: [],
    run: async (store, args) => ({ artifacts: await store.list(str(args.prefix), optionalInt(args.limit) ?? DEFAULT_LIMIT) }),
  },
  {
    name: "stat",
    description: "Show metadata and available versions of an artifact.",
    properties: { name, version },
    required: ["name"],
    run: (store, args) => store.stat(str(args.name), optionalInt(args.version)),
  },
  {
    name: "read",
    description: "Read a small text artifact inline (up to 256 KiB). Larger files: use download_url.",
    properties: { name, version },
    required: ["name"],
    run: (store, args) => store.read(str(args.name), optionalInt(args.version)),
  },
  {
    name: "write",
    description: "Save a small text file (up to 256 KiB) as a new artifact version. Larger or binary files: use upload_url and commit.",
    properties: { name, content: text, contentType: text, requestId },
    required: ["name", "content"],
    run: (store, args) => store.write(str(args.name), str(args.content), optionalString(args.contentType) ?? TEXT_CONTENT_TYPE, optionalString(args.requestId)),
  },
  {
    name: "edit",
    description:
      "Change a small text artifact in place instead of rewriting it: each old_str must occur exactly once in the latest version and is replaced by new_str, in order, all or none. Saves a new version.",
    properties: {
      name,
      edits: { type: "array", items: { type: "object", properties: { old_str: text, new_str: text }, required: ["old_str", "new_str"] } },
      requestId,
    },
    required: ["name", "edits"],
    run: (store, args) => store.edit(str(args.name), edits(args.edits), optionalString(args.requestId)),
  },
  {
    name: "upload_url",
    description:
      "Reserve a new artifact version and get a presigned PUT url. Upload from the sandbox with `curl -sS -X PUT -H 'content-type: <type>' -T <file> '<url>'`, then call commit with the uploadId.",
    properties: { name, size: { type: "integer", description: "File size in bytes" }, contentType: text, requestId },
    required: ["name", "size"],
    run: (store, args) => store.uploadUrl(str(args.name), optionalInt(args.size) ?? -1, optionalString(args.contentType) ?? DEFAULT_CONTENT_TYPE, optionalString(args.requestId)),
  },
  {
    name: "commit",
    description: "Finish an upload started with upload_url. The artifact only exists after commit succeeds.",
    properties: { uploadId: text },
    required: ["uploadId"],
    run: (store, args) => store.commit(str(args.uploadId)),
  },
  {
    name: "download_url",
    description: "Get a short-lived presigned GET url for an artifact. Fetch it from the sandbox with `curl -sS -o <file> '<url>'`.",
    properties: { name, version },
    required: ["name"],
    run: (store, args) => store.downloadUrl(str(args.name), optionalInt(args.version)),
  },
  {
    name: "skill",
    description: "Read a skill: written guidance for a kind of work. Without a name, lists the available skills with their descriptions.",
    properties: { name: { type: "string", description: "Skill name from the list" } },
    required: [],
    run: async (_store, args) => {
      const wanted = str(args.name);
      if (wanted === "") return { skills: Object.entries(SKILLS).map(([skillName, { description }]) => ({ name: skillName, description })) };
      const skill = SKILLS[wanted];
      if (skill === undefined) throw new Error(`unknown skill ${wanted}`);
      return { name: wanted, description: skill.description, body: skill.body };
    },
  },
  {
    name: "delete",
    description: "Delete an artifact. A later write under the same name starts it again.",
    properties: { name },
    required: ["name"],
    run: (store, args) => store.delete(str(args.name)),
  },
];

const INSTRUCTIONS = "Durable storage for user files. Sandboxes are temporary: save anything the user should keep as an artifact.";

function reply(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function failure(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

async function call(store: ArtifactObject, params: { name?: unknown; arguments?: unknown }) {
  const tool = TOOLS.find((candidate) => candidate.name === params.name);
  if (tool === undefined) throw new Error(`unknown tool ${String(params.name)}`);
  const structured = await tool.run(store, (params.arguments ?? {}) as Args);
  return { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
}

export async function handleMcp(request: Request, store: ArtifactObject): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const message = (await request.json().catch(() => null)) as { id?: unknown; method?: unknown; params?: Record<string, unknown> } | null;
  if (message === null || typeof message.method !== "string") return failure(null, -32700, "Parse error");
  if (message.id === undefined) return new Response(null, { status: 202 });
  switch (message.method) {
    case "initialize":
      return reply(message.id, {
        protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "artifact", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply(message.id, {});
    case "tools/list":
      return reply(message.id, {
        tools: TOOLS.map(({ name: toolName, description, properties, required }) => ({
          name: toolName,
          description,
          inputSchema: { type: "object", properties, required },
        })),
      });
    case "tools/call":
      try {
        return reply(message.id, await call(store, message.params ?? {}));
      } catch (error) {
        return reply(message.id, { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
      }
    default:
      return failure(message.id, -32601, `Method not found: ${message.method}`);
  }
}
