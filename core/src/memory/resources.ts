import type { MemoryResource } from "./doc.js";
import type { PublishedMemory } from "./files.js";
import { descriptionOf, isMemoryFile, isSystemPath } from "./paths.js";
import { isSensitive } from "./guard.js";

export function memoryResources(snapshot: PublishedMemory): MemoryResource[] {
  return Object.entries(snapshot.files).filter(([path, text]) => isMemoryFile(path) && text.replace(/^---\r?\n[\s\S]*?\r?\n---/, "").trim() !== "" && !isSensitive(text)).sort(([a], [b]) => a.localeCompare(b)).map(([path, text]) => {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    const sourceLine = /^sourceRefs:[ \t]*(.*)$/m.exec(frontmatter)?.[1];
    let sourceRefs: string[] = [];
    try {
      const parsed: unknown = JSON.parse(sourceLine ?? "[]");
      if (Array.isArray(parsed)) sourceRefs = parsed.filter((value): value is string => typeof value === "string");
    } catch {}
    const type = isSystemPath(path) ? "system" : path.startsWith("people/") ? "person" : path.startsWith("spaces/") ? "space" : path.startsWith("assets/") ? "asset" : path.startsWith("log/") ? "log" : "topic";
    return { id: `memory:${path}`, type, summary: descriptionOf(text).slice(0, 500) || path, sourceRefs, version: snapshot.version, contentRef: path };
  });
}
