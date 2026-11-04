import { mkdir, rm } from "node:fs/promises";
import { AgentFS } from "agentfs-sdk";
import { agentfs } from "agentfs-sdk/just-bash";
import { Bash, InMemoryFs, type IFileSystem } from "just-bash";
import { openB } from "./backend.js";

const DIR = process.env.HOT_DIR ?? "/var/tmp/hotpath/";
const FILES = Number(process.argv[2] ?? 40);
const REPEAT = Number(process.argv[3] ?? 30);
const GROUPS = ["system", "people", "areas", "topics"];

const content = (i: number) => `---\ndescription: memory file ${i} about topic ${i % 7} with some keywords\n---\n${"fact line about the user and their preferences. ".repeat(20)}\n`;

const OPS: [string, string][] = [
  ["cat 一个文件", "cat /m/system/f0.md"],
  ["cat 三个 system 文件", "cat /m/system/f0.md /m/system/f4.md /m/system/f8.md"],
  ["grep -rl 关键词", "grep -rl 'topic 3' /m"],
  ["读目录树（description）", "grep -r '^description:' /m"],
  ["find 加 wc", "find /m -name '*.md' | wc -l"],
];

const seedCommand = `for i in $(seq 0 ${FILES - 1}); do g=$((i % 4)); case $g in 0) d=system;; 1) d=people;; 2) d=areas;; *) d=topics;; esac; mkdir -p /m/$d; printf '%s\\n' '---' "description: memory file $i about topic $((i % 7)) with some keywords" '---' "fact line about the user and their preferences." > /m/$d/f$i.md; done`;

const percentile = (values: number[], p: number): number => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;

type Runner = { name: string; exec: (command: string) => Promise<unknown> };

async function measure(runner: Runner): Promise<void> {
  const cells: string[] = [];
  for (const [, command] of OPS) {
    await runner.exec(command);
    const times: number[] = [];
    for (let i = 0; i < REPEAT; i++) {
      const start = performance.now();
      await runner.exec(command);
      times.push(performance.now() - start);
    }
    cells.push(`${percentile(times, 0.5).toFixed(1)} / ${percentile(times, 0.95).toFixed(1)}`);
  }
  console.log(`${runner.name} | ${cells.join(" | ")}`);
}

async function openAgent(name: string, sync?: string): Promise<{ fs: IFileSystem; close: () => Promise<void> }> {
  const path = `${DIR}${name}.db`;
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${path}${suffix}`, { force: true });
  const handle = await AgentFS.open({ path });
  if (sync) await handle.getDatabase().exec(`PRAGMA synchronous = ${sync}`);
  const base = await agentfs(handle);
  const fs = Object.assign(Object.create(base) as IFileSystem, { realpath: async (target: string) => base.resolvePath("/", target), utimes: async () => undefined });
  return { fs, close: () => handle.close() };
}

await mkdir(DIR, { recursive: true });
console.log(`记忆库 ${FILES} 个文件，四个目录；每个操作重复 ${REPEAT} 次；单元格为 p50 / p95 毫秒`);
console.log(`方案 | ${OPS.map(([name]) => name).join(" | ")}`);

const plain = await openAgent("hot1");
const plainBash = new Bash({ fs: plain.fs, cwd: "/", python: false, javascript: false });
await plainBash.exec(seedCommand);
await measure({ name: "A1 agentfs 默认（读文件会更新访问时间）", exec: (command) => plainBash.exec(command) });

const relaxed = await openAgent("hot2", "OFF");
const relaxedBash = new Bash({ fs: relaxed.fs, cwd: "/", python: false, javascript: false });
await relaxedBash.exec(seedCommand);
await measure({ name: "A2 agentfs + synchronous=OFF", exec: (command) => relaxedBash.exec(command) });

const hydrateStart = performance.now();
const memory = new InMemoryFs();
let hydrated = 0;
let bytes = 0;
const walk = async (dir: string): Promise<void> => {
  for (const entry of await plain.fs.readdir(dir)) {
    const path = dir === "/" ? `/${entry}` : `${dir}/${entry}`;
    const stat = await plain.fs.stat(path);
    if (stat.isDirectory) {
      await memory.mkdir(path, { recursive: true });
      await walk(path);
    } else if (stat.isFile) {
      const data = await plain.fs.readFileBuffer(path);
      bytes += data.length;
      await memory.writeFile(path, data);
      hydrated += 1;
    }
  }
};
await walk("/");
const hydrateMs = performance.now() - hydrateStart;
const memoryBash = new Bash({ fs: memory, cwd: "/", python: false, javascript: false });
await measure({ name: "A3 InMemoryFs（从 sqlite 一次性读入）", exec: (command) => memoryBash.exec(command) });
console.log(`A3 读入耗时 ${hydrateMs.toFixed(0)} 毫秒，${hydrated} 个文件，${(bytes / 1e3).toFixed(0)} KB`);

await plain.close();
await relaxed.close();

const b = await openB("hot");
await b.exec(seedCommand);
await measure({ name: "B 真 bash（含 docker exec 调用）", exec: (command) => b.exec(command) });
await b.close();
