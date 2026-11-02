import type { MemoryFiles } from "./files.js";
import { hasFrontmatter, isSystemPath, SEED } from "./paths.js";

interface LegacySource {
  files(): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
}

const DESCRIPTION_CHARACTERS = 80;
const LEGACY_SYSTEM: Readonly<Record<string, string>> = {
  "profile.md": "system/profile.md",
  "feedback.md": "system/feedback.md",
  "now.md": "system/now.md",
};
const LEGACY_NAMED = /^(people|topics)\/[^/.\\\r\n][^/\\\r\n]*\.md$/;
const LEGACY_LOG = /^log\/\d{4}-\d{2}-\d{2}\.md$/;

const targetPath = (path: string): string | undefined =>
  LEGACY_SYSTEM[path] ?? (LEGACY_NAMED.test(path) || LEGACY_LOG.test(path) ? path : undefined);

const describe = (path: string, body: string): string => {
  const line = body.split("\n").map((text) => text.replace(/^[\s#]+/, "").trim()).find((text) => text !== "");
  return (line ?? (path.split("/").pop() ?? path).replace(/\.md$/, "")).slice(0, DESCRIPTION_CHARACTERS);
};

const withFrontmatter = (path: string, text: string): string => {
  if (hasFrontmatter(text)) return text;
  if (text.trim() === "" && isSystemPath(path)) return SEED[path] ?? `---\ndescription: ${describe(path, "")}\n---\n`;
  return `---\ndescription: ${describe(path, text)}\n---\n${text}`;
};

export async function migrateLegacy(legacy: LegacySource, target: MemoryFiles): Promise<{ migrated: string[] }> {
  const existing = new Set(await target.files());
  for (const [path, content] of Object.entries(SEED)) {
    if (!existing.has(path)) await target.write(path, content);
  }
  const migrated: string[] = [];
  for (const source of await legacy.files()) {
    const path = targetPath(source);
    if (path === undefined) continue;
    await target.write(path, withFrontmatter(path, (await legacy.read(source)) ?? ""));
    migrated.push(path);
  }
  return { migrated };
}
