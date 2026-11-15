import type { ToolRegistration } from "@earendil-works/pi-durable";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";
import { memorySpan } from "./telemetry.js";
import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { MemoryFiles, ReadableFiles } from "./files.js";
import { descriptionOf, hasFrontmatter, isMemoryFile, isSystemPath, SYSTEM_FILE_CHARACTERS } from "./paths.js";

const OUTPUT_CHARACTERS = 4000;
const GREP_MATCHES = 50;
const GREP_LINE_CHARACTERS = 200;

const PathParam = Type.String({ description: "记忆文件路径，如 system/profile.md、people/xiaolin.md" });

const clip = (text: string): string =>
  text.length > OUTPUT_CHARACTERS ? `${text.slice(0, OUTPUT_CHARACTERS)}\n...[已截断 ${text.length - OUTPUT_CHARACTERS} 字符]` : text;

const ok = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text: clip(text) }] });

const fail = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

const markdownPaths = async (files: ReadableFiles): Promise<string[]> => (await files.files()).filter((path) => path.endsWith(".md")).sort();

const within = (path: string, scope: string | undefined): boolean =>
  scope === undefined || scope === "" || path === scope || path.startsWith(scope.endsWith("/") ? scope : `${scope}/`);

const matcher = (pattern: string): ((line: string) => boolean) => {
  try {
    const regex = new RegExp(pattern, "i");
    return (line) => regex.test(line);
  } catch {
    const needle = pattern.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
};

const rejected = (path: string, content: string): string | undefined => {
  if (!isMemoryFile(path)) return `路径不合法：${path}。只允许 system/、people/、areas/、topics/ 下的 .md 文件，或 log/YYYY-MM-DD.md。未写入。`;
  if (!hasFrontmatter(content) || descriptionOf(content) === "") return `${path} 开头缺少 frontmatter 或 description，未写入。请以 ---\\ndescription: ...\\n--- 开头后重试。`;
  return undefined;
};

const sizeNote = (path: string, content: string): string =>
  isSystemPath(path) && content.length > SYSTEM_FILE_CHARACTERS ? `\n注意：${path} 共 ${content.length} 字符，超过 ${SYSTEM_FILE_CHARACTERS}，超出部分不会注入，请精简。` : "";

const withNewline = (content: string): string => (content.endsWith("\n") ? content : `${content}\n`);

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

const alreadyApplied = (text: string, old: string, next: string): boolean => next !== "" && text.includes(next) && !text.split(next).join("\u0000").includes(old);

export function createReadTools(files: ReadableFiles, telemetry: TelemetryContext = NOOP_TELEMETRY_CONTEXT): ToolRegistration[] {
  const read = defineTool({
    name: "memory_read",
    description: "读取一个长期记忆文件的全文。",
    parameters: Type.Object({ path: PathParam }),
    replay: "safe",
    execute: async ({ path }) => memorySpan(telemetry, "memory.retrieve", { "gen_ai.tool.name": "memory_read" }, async (span) => {
      const text = await files.read(path);
      span.setAttributes({ "lulu.memory.outcome": text === undefined || text === "" ? "empty" : "success", "lulu.memory.characters": Math.min(text?.length ?? 0, OUTPUT_CHARACTERS) });
      return text === undefined ? fail(`${path} 不存在。`) : ok(text);
    }),
  });

  const ls = defineTool({
    name: "memory_ls",
    description: "列出所有长期记忆文件，每行一个“路径: description”。",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => memorySpan(telemetry, "memory.retrieve", { "gen_ai.tool.name": "memory_ls" }, async (span) => {
      const paths = await markdownPaths(files);
      const lines = await Promise.all(paths.map(async (path) => `${path}: ${descriptionOf((await files.read(path)) ?? "")}`));
      span.setAttributes({ "lulu.memory.outcome": lines.length === 0 ? "empty" : "success", "lulu.memory.matches": lines.length });
      return ok(lines.length === 0 ? "（空）" : lines.join("\n"));
    }),
  });

  const grep = defineTool({
    name: "memory_grep",
    description: `在长期记忆中搜索，pattern 是正则（不区分大小写），无法解析时按固定字符串匹配。path 可选，限定到某个文件或目录。每行输出“路径:行号:内容”，最多 ${GREP_MATCHES} 条。`,
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String({ description: "文件路径或目录前缀，如 people/" })),
    }),
    replay: "safe",
    execute: async ({ pattern, path }) => memorySpan(telemetry, "memory.retrieve", { "gen_ai.tool.name": "memory_grep" }, async (span) => {
      const test = matcher(pattern);
      const hits: string[] = [];
      for (const file of (await markdownPaths(files)).filter((candidate) => within(candidate, path))) {
        const lines = ((await files.read(file)) ?? "").split("\n");
        for (const [index, line] of lines.entries()) {
          if (!test(line)) continue;
          hits.push(`${file}:${index + 1}:${line.slice(0, GREP_LINE_CHARACTERS)}`);
          if (hits.length > GREP_MATCHES) break;
        }
        if (hits.length > GREP_MATCHES) break;
      }
      span.setAttributes({ "lulu.memory.outcome": hits.length === 0 ? "empty" : "success", "lulu.memory.matches": Math.min(hits.length, GREP_MATCHES), "lulu.memory.clipped": hits.length > GREP_MATCHES });
      if (hits.length === 0) return ok("无匹配。");
      return ok(hits.length > GREP_MATCHES ? `${hits.slice(0, GREP_MATCHES).join("\n")}\n...[匹配过多，请缩小 pattern 或 path]` : hits.join("\n"));
    }),
  });

  return [read, ls, grep];
}

export function createWriteTools(files: MemoryFiles): ToolRegistration[] {
  const write = defineTool({
    name: "memory_write",
    description: "整文件写入一个长期记忆文件（新建或整体重写）。内容必须以含 description 的 frontmatter 开头。",
    parameters: Type.Object({ path: PathParam, content: Type.String() }),
    replay: "safe",
    executionMode: "sequential",
    execute: async ({ path, content }) => {
      const text = withNewline(content);
      const refused = rejected(path, text);
      if (refused !== undefined) return fail(refused);
      await files.write(path, text);
      return ok(`已写入 ${path}。${sizeNote(path, text)}`);
    },
  });

  const edit = defineTool({
    name: "memory_edit",
    description: "把长期记忆文件中唯一出现的 old 精确替换为 new。old 必须与文件内容逐字一致，并带足上下文以保证唯一。",
    parameters: Type.Object({ path: PathParam, old: Type.String(), new: Type.String() }),
    replay: "safe",
    executionMode: "sequential",
    execute: async (args) => {
      const { path, old } = args;
      const next = args.new;
      const text = await files.read(path);
      if (text === undefined) return fail(`${path} 不存在。新建文件请用 memory_write。`);
      if (old === "") return fail("old 不能为空。");
      if (alreadyApplied(text, old, next)) return ok(`${path} 已包含该修改。`);
      const count = occurrences(text, old);
      if (count === 0) return fail(`${path} 中找不到 old。请先 memory_read 确认原文。`);
      if (count > 1) return fail(`${path} 中 old 出现 ${count} 次，请带上更多上下文使其唯一。`);
      const updated = text.replace(old, () => next);
      const refused = rejected(path, updated);
      if (refused !== undefined) return fail(refused);
      await files.write(path, updated);
      return ok(`已修改 ${path}。${sizeNote(path, updated)}`);
    },
  });

  const remove = defineTool({
    name: "memory_delete",
    description: "删除一个长期记忆文件。",
    parameters: Type.Object({ path: PathParam }),
    replay: "safe",
    executionMode: "sequential",
    execute: async ({ path }) => {
      if (!isMemoryFile(path)) return fail(`路径不合法：${path}。`);
      if ((await files.read(path)) === undefined) return ok(`${path} 已不存在。`);
      await files.remove(path);
      return ok(`已删除 ${path}。`);
    },
  });

  return [write, edit, remove];
}
