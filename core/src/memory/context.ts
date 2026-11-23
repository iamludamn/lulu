import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";
import { memorySpan } from "./telemetry.js";
import { descriptionOf, isSystemPath, SYSTEM_FILE_CHARACTERS, type ReadableFiles } from "./files.js";

const clipSystem = (text: string): string => (text.length > SYSTEM_FILE_CHARACTERS ? `${text.slice(0, SYSTEM_FILE_CHARACTERS)}\n...[已截断]` : text);

const CATALOG_HEADING = "### 其他记忆（路径: description，需要时用 memory_read / memory_grep 读取）";
const NOTICE = "（记忆由后台整理，你只能读取，不能写入；用户要你记住的事会被自动整理进去。）";

export function contextCoverage(context: string | undefined): "none" | "template" | "catalog" | "content" | "unknown" {
  if (!context) return "none";
  if (context.startsWith("<memory>\n{")) {
    try {
      const parsed = JSON.parse(context.slice("<memory>\n".length, -"\n</memory>".length)) as { context?: string; selected?: { text?: string | null }[] };
      if (typeof parsed.context === "string") return parsed.context.trim() === "" ? "none" : "content";
      if (Array.isArray(parsed.selected)) return parsed.selected.some((item) => typeof item.text === "string" && item.text.trim() !== "") ? "content" : parsed.selected.length > 0 ? "catalog" : "none";
    } catch {}
  }
  const split = context.indexOf(CATALOG_HEADING);
  if (!context.startsWith("<memory>\n") || split < 0) return "unknown";
  const system = context.slice("<memory>\n".length, split)
    .replace(/^### [^\n]*\n/gm, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/gm, "")
    .trim();
  if (system !== "") return "content";
  const catalog = context.slice(split + CATALOG_HEADING.length).replace(NOTICE, "").replace(/\n<\/memory>$/, "").trim();
  return catalog === "" ? "template" : "catalog";
}

export function getContext(files: ReadableFiles, telemetry: TelemetryContext = NOOP_TELEMETRY_CONTEXT): Promise<string> {
  return memorySpan(telemetry, "memory.context.build", {}, async (span) => {
    const paths = (await files.files()).filter((path) => path.endsWith(".md")).sort();
    const texts = await Promise.all(paths.map(async (path) => [path, (await files.read(path)) ?? ""] as const));
    const system: string[] = [];
    const tree: string[] = [];
    for (const [path, text] of texts) {
      if (isSystemPath(path)) system.push(`### ${path}\n${clipSystem(text.trim())}`);
      else tree.push(`${path}: ${descriptionOf(text)}`);
    }
    const context = `<memory>\n${system.join("\n\n")}\n\n${CATALOG_HEADING}\n${NOTICE}\n${tree.join("\n")}\n</memory>`;
    span.setAttributes({ "lulu.memory.files": texts.length, "lulu.memory.clipped_files": texts.filter(([path, text]) => isSystemPath(path) && text.trim().length > SYSTEM_FILE_CHARACTERS).length, "lulu.memory.characters": context.length });
    return context;
  });
}
