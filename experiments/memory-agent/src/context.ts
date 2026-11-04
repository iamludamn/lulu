import type { IFileSystem } from "just-bash";

const description = (text: string): string => /^description:\s*(.*)$/m.exec(text)?.[1] ?? "";

async function markdown(fs: IFileSystem, dir: string, out: string[]): Promise<void> {
  for (const name of (await fs.readdir(dir)).sort()) {
    if (dir === "/" && name === ".git") continue;
    const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
    if ((await fs.stat(path)).isDirectory) await markdown(fs, path, out);
    else if (name.endsWith(".md")) out.push(path);
  }
}

export async function getContext(fs: IFileSystem): Promise<string> {
  const paths: string[] = [];
  await markdown(fs, "/", paths);
  const system: string[] = [];
  const tree: string[] = [];
  for (const path of paths) {
    const text = await fs.readFile(path);
    if (path.startsWith("/system/")) system.push(`### ${path.slice(1)}\n${text.trim()}`);
    else tree.push(`${path.slice(1)}: ${description(text)}`);
  }
  return `<memory>\n${system.join("\n\n")}\n\n### 其他记忆（路径: description，需要时用 bash 读取）\n${tree.join("\n")}\n</memory>`;
}
