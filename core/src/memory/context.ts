import type { MemoryFiles } from "./files.js";
import { descriptionOf, isSystemPath, SYSTEM_FILE_CHARACTERS } from "./paths.js";

const clipSystem = (text: string): string => (text.length > SYSTEM_FILE_CHARACTERS ? `${text.slice(0, SYSTEM_FILE_CHARACTERS)}\n...[已截断]` : text);

export async function getContext(files: MemoryFiles): Promise<string> {
  const paths = (await files.files()).filter((path) => path.endsWith(".md")).sort();
  const texts = await Promise.all(paths.map(async (path) => [path, (await files.read(path)) ?? ""] as const));
  const system: string[] = [];
  const tree: string[] = [];
  for (const [path, text] of texts) {
    if (isSystemPath(path)) system.push(`### ${path}\n${clipSystem(text.trim())}`);
    else tree.push(`${path}: ${descriptionOf(text)}`);
  }
  return `<memory>\n${system.join("\n\n")}\n\n### 其他记忆（路径: description，需要时用 memory_read / memory_grep 读取）
（记忆由后台整理，你只能读取，不能写入；用户要你记住的事会被自动整理进去。）\n${tree.join("\n")}\n</memory>`;
}
