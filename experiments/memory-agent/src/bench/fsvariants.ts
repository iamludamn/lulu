import { mkdir, rm } from "node:fs/promises";
import { AgentFS } from "agentfs-sdk";
import { agentfs } from "agentfs-sdk/just-bash";
import { Bash, InMemoryFs, type IFileSystem } from "just-bash";
import { createGit } from "just-git";

const FILES = Number(process.argv[2] ?? 200);
const DIR = "/tmp/fsvariants/";
const IDENTITY = { name: "m", email: "m@m" };
const GIT = "git init -q && git config user.email a@b.c && git config user.name n";

const PHASES: [string, string][] = [
  ["写入", `mkdir -p /m && cd /m && for i in $(seq 1 ${FILES}); do printf '%s\\n' 'memory line' "content number $i" > f$i.md; done`],
  ["读取", "cd /m && cat f*.md | wc -c"],
  ["grep", `cd /m && grep -rl 'number ${FILES} ' . | wc -l`],
  ["git 初始提交", `cd /m && ${GIT} && git add -A && git commit -qm all`],
  ["修改十个文件并提交", "cd /m && for i in $(seq 1 10); do echo more >> f$i.md; done && git add -A && git commit -qm edit"],
];

type Database = { exec: (sql: string) => Promise<unknown>; prepare: (sql: string) => { run: (...a: unknown[]) => Promise<unknown>; get: (...a: unknown[]) => Promise<unknown>; all: (...a: unknown[]) => Promise<unknown> } };

const counter = { statements: 0 };

function instrument(db: Database): void {
  const exec = db.exec.bind(db);
  db.exec = async (sql) => {
    counter.statements += 1;
    return exec(sql);
  };
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    for (const method of ["run", "get", "all"] as const) {
      const original = statement[method].bind(statement);
      statement[method] = async (...args: unknown[]) => {
        counter.statements += 1;
        return original(...args);
      };
    }
    return statement;
  };
}

const shell = (fs?: IFileSystem) =>
  new Bash({ ...(fs ? { fs } : {}), cwd: "/", python: false, javascript: false, customCommands: [createGit({ identity: IDENTITY, cwd: "/", network: false, disabled: [] })] });

async function openAgent(name: string): Promise<{ fs: IFileSystem; db: Database; close: () => Promise<void> }> {
  const path = `${DIR}${name}.db`;
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${path}${suffix}`, { force: true });
  const handle = await AgentFS.open({ path });
  const base = await agentfs(handle);
  const fs = Object.assign(Object.create(base) as IFileSystem, { realpath: async (target: string) => base.resolvePath("/", target), utimes: async () => undefined });
  const db = handle.getDatabase() as unknown as Database;
  return { fs, db, close: () => handle.close() };
}

async function run(label: string, bash: Bash, around?: { before: () => Promise<unknown>; after: () => Promise<unknown> }): Promise<void> {
  const cells: string[] = [];
  const counts: number[] = [];
  counter.statements = 0;
  for (const [, command] of PHASES) {
    const before = counter.statements;
    const start = performance.now();
    await around?.before();
    await bash.exec(command);
    await around?.after();
    cells.push(String(Math.round(performance.now() - start)));
    counts.push(counter.statements - before);
  }
  console.log(`${label} | ${cells.join(" | ")} | SQL 语句 ${counts.join(" / ")}`);
}

await mkdir(DIR, { recursive: true });
console.log(`文件数 ${FILES}（单位毫秒）`);
console.log(`方案 | ${PHASES.map(([name]) => name).join(" | ")} | SQL 语句数`);

const base = await openAgent("v1");
instrument(base.db);
const pragmas = [];
for (const name of ["journal_mode", "synchronous", "page_size"]) {
  try {
    pragmas.push(`${name}=${JSON.stringify(await (base.db as unknown as { prepare: (s: string) => { get: () => Promise<unknown> } }).prepare(`PRAGMA ${name}`).get())}`);
  } catch (error) {
    pragmas.push(`${name}=不支持(${(error as Error).message.slice(0, 40)})`);
  }
}
console.log(`当前 PRAGMA：${pragmas.join("；")}`);
await run("1 agentfs 默认（现方案）", shell(base.fs));
await base.close();

const sync = await openAgent("v2");
instrument(sync.db);
let pragmaNote = `synchronous=${process.env.SYNC ?? "OFF"} 已生效`;
try {
  await sync.db.exec(`PRAGMA synchronous = ${process.env.SYNC ?? "OFF"}`);
} catch (error) {
  pragmaNote = `synchronous 设置失败：${(error as Error).message.slice(0, 60)}`;
}
console.log(pragmaNote);
await run(`2 agentfs + synchronous=${process.env.SYNC ?? "OFF"}`, shell(sync.fs));
await sync.close();

const batched = await openAgent("v3");
instrument(batched.db);
await run("3 agentfs + 每条命令包在一个事务里", shell(batched.fs), { before: () => batched.db.exec("BEGIN"), after: () => batched.db.exec("COMMIT") });
await batched.close();

await run("4 InMemoryFs（纯内存，不持久化）", shell(new InMemoryFs()));

const memory = new InMemoryFs();
await run("5 InMemoryFs（同 4，用于落盘测试）", shell(memory));
const flushTarget = await openAgent("v5");
const bash = shell(flushTarget.fs);
await bash.exec("mkdir -p /m");
const start = performance.now();
await flushTarget.db.exec("BEGIN");
const paths = memory.getAllPaths().filter((path) => path !== "/");
let bytes = 0;
for (const path of paths) {
  const stat = await memory.stat(path);
  if (stat.isDirectory) await flushTarget.fs.mkdir(path, { recursive: true });
  else if (stat.isFile) {
    const content = await memory.readFileBuffer(path);
    bytes += content.length;
    await flushTarget.fs.writeFile(path, content);
  }
}
await flushTarget.db.exec("COMMIT");
const flushMs = Math.round(performance.now() - start);
const hydrateStart = performance.now();
const restored = new InMemoryFs();
let restoredFiles = 0;
const walk = async (dir: string): Promise<void> => {
  for (const name of await flushTarget.fs.readdir(dir)) {
    const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
    const stat = await flushTarget.fs.stat(path);
    if (stat.isDirectory) {
      await restored.mkdir(path, { recursive: true });
      await walk(path);
    } else if (stat.isFile) {
      await restored.writeFile(path, await flushTarget.fs.readFileBuffer(path));
      restoredFiles += 1;
    }
  }
};
await walk("/");
console.log(`内存态落盘：${paths.length} 个路径、${(bytes / 1e6).toFixed(2)} MB，一次事务写入 ${flushMs} 毫秒；从 sqlite 读回内存 ${Math.round(performance.now() - hydrateStart)} 毫秒（${restoredFiles} 个文件）`);
await flushTarget.close();
