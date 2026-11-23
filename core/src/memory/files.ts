import type { MemoryResource } from "./doc.js";

export interface MemoryCommit {
  readonly oid: string;
  readonly message: string;
  readonly at: number;
}

export type PublishedMemory = { version: string; files: Record<string, string> };
export type PublishedCatalog = { resources: MemoryResource[]; cacheHit: boolean; fileReads: number; sqlRowsRead: number };

export interface MemoryFiles {
  published(): Promise<PublishedMemory>;
  publishedCatalog(): Promise<PublishedCatalog>;
  readVersion(path: string, version: string): Promise<string | undefined>;
  files(): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  changed(): Promise<string[]>;
  discard(path: string): Promise<void>;
  commit(message: string): Promise<string | undefined>;
  commits(depth: number): Promise<MemoryCommit[]>;
}

export type ReadableFiles = { files(): Promise<string[]>; read(path: string, version?: string): Promise<string | undefined> };

export const SYSTEM_FILE_CHARACTERS = 1500;

const SYSTEM_PATH = /^system\/[^/.\\\r\n][^/\\\r\n]*\.md$/;
const TOPIC_PATH = /^(people|areas|topics|spaces|assets)\/[^/.\\\r\n][^/\\\r\n]*\.md$/;
const DAILY_PATH = /^log\/\d{4}-\d{2}-\d{2}\.md$/;
const KEEP_PATH = /^(system|people|areas|topics|spaces|assets|log)\/\.keep$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const DESCRIPTION = /^description:[ \t]*(.*)$/m;

export const SEED: Readonly<Record<string, string>> = {
  "system/profile.md": "---\ndescription: 用户是谁、长期偏好\n---\n",
  "system/feedback.md": "---\ndescription: 用户对助手的纠正与偏好\n---\n",
  "system/now.md": "---\ndescription: 当前在做的事与近期状态\n---\n",
};

export const isSystemPath = (path: string): boolean => SYSTEM_PATH.test(path);

export const isMemoryFile = (path: string): boolean => SYSTEM_PATH.test(path) || TOPIC_PATH.test(path) || DAILY_PATH.test(path);

export const isStoredFile = (path: string): boolean => isMemoryFile(path) || KEEP_PATH.test(path);

export const hasFrontmatter = (text: string): boolean => FRONTMATTER.test(text);

export const descriptionOf = (text: string): string => {
  const block = FRONTMATTER.exec(text)?.[1];
  return block === undefined ? "" : (DESCRIPTION.exec(block)?.[1] ?? "").trim();
};

const SENSITIVE: readonly RegExp[] = [
  /(?:password|passwd|passphrase|secret|token|api[ _-]?key|密码|口令|密钥)\s*(?:[:=：]|是|为|is\b)/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];

export const isSensitive = (text: string): boolean => SENSITIVE.some((pattern) => pattern.test(text));

export async function guardChanges(files: MemoryFiles): Promise<{ blocked: string[] }> {
  const blocked: string[] = [];
  for (const path of await files.changed()) {
    if (isSensitive((await files.read(path)) ?? "")) {
      await files.discard(path);
      blocked.push(path);
    }
  }
  return { blocked };
}

export function memoryResources(snapshot: PublishedMemory): MemoryResource[] {
  return Object.entries(snapshot.files).filter(([path, text]) => isMemoryFile(path) && text.replace(FRONTMATTER, "").trim() !== "" && !isSensitive(text)).sort(([a], [b]) => a.localeCompare(b)).map(([path, text]) => {
    const frontmatter = FRONTMATTER.exec(text)?.[1] ?? "";
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
