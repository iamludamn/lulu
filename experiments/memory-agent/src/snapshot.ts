import { AgentFS } from "agentfs-sdk";
import { InMemoryFs, type IFileSystem } from "just-bash";
import { wrapAgentFs, type Handle } from "./store.js";

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10000;
const ROOT_INO = 1;
const VERSION_KEY = "memory_version";
const RUNTIME = ["bin", "usr", "dev", "proc"];

const isRuntime = (path: string): boolean => RUNTIME.some((name) => path === `/${name}` || path.startsWith(`/${name}/`));

export type Snapshot = { version: number; fs: InMemoryFs; files: number; lockWaitMs: number };

type Row<T> = T[];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function openLocked(path: string): Promise<{ handle: Handle; lockWaitMs: number }> {
  const start = performance.now();
  for (;;) {
    try {
      return { handle: await AgentFS.open({ path }), lockWaitMs: performance.now() - start };
    } catch (error) {
      if (!/locked by another process/.test((error as Error).message) || performance.now() - start > LOCK_TIMEOUT_MS) throw error;
      await sleep(LOCK_RETRY_MS);
    }
  }
}

const readVersion = async (handle: Handle): Promise<number> => {
  const row = (await handle.getDatabase().prepare("SELECT value FROM fs_config WHERE key = ?").get(VERSION_KEY)) as { value: string } | undefined;
  return Number(row?.value ?? 0);
};

export async function loadSnapshot(path: string, exclude: readonly string[] = [".git", ...RUNTIME]): Promise<Snapshot> {
  const { handle, lockWaitMs } = await openLocked(path);
  try {
    const db = handle.getDatabase();
    const [inodes, dentries, chunks, version] = [
      (await db.prepare("SELECT ino, mode FROM fs_inode").all()) as Row<{ ino: number; mode: number }>,
      (await db.prepare("SELECT parent_ino, name, ino FROM fs_dentry").all()) as Row<{ parent_ino: number; name: string; ino: number }>,
      (await db.prepare("SELECT ino, chunk_index, data FROM fs_data ORDER BY ino, chunk_index").all()) as Row<{ ino: number; data: Uint8Array }>,
      await readVersion(handle),
    ];
    const modes = new Map(inodes.map((row) => [row.ino, row.mode]));
    const children = new Map<number, { name: string; ino: number }[]>();
    for (const row of dentries) children.set(row.parent_ino, [...(children.get(row.parent_ino) ?? []), { name: row.name, ino: row.ino }]);
    const parts = new Map<number, Uint8Array[]>();
    for (const row of chunks) parts.set(row.ino, [...(parts.get(row.ino) ?? []), row.data]);
    const fs = new InMemoryFs();
    let files = 0;
    const build = async (ino: number, path: string): Promise<void> => {
      for (const child of children.get(ino) ?? []) {
        if (ino === ROOT_INO && exclude.includes(child.name)) continue;
        const target = `${path === "/" ? "" : path}/${child.name}`;
        if (((modes.get(child.ino) ?? 0) & S_IFMT) === S_IFDIR) {
          await fs.mkdir(target, { recursive: true });
          await build(child.ino, target);
        } else {
          await fs.writeFile(target, Buffer.concat(parts.get(child.ino)?.map((part) => Buffer.from(part)) ?? []));
          files += 1;
        }
      }
    };
    await build(ROOT_INO, "/");
    return { version, fs, files, lockWaitMs };
  } finally {
    await handle.close();
  }
}

export async function dream<T>(path: string, run: (fs: IFileSystem) => Promise<T>): Promise<{ version: number; result: T; lockWaitMs: number }> {
  const { handle, lockWaitMs } = await openLocked(path);
  try {
    const db = handle.getDatabase();
    await db.exec("BEGIN");
    try {
      const result = await run(await wrapAgentFs(handle));
      const version = (await readVersion(handle)) + 1;
      await db.prepare("INSERT OR REPLACE INTO fs_config (key, value) VALUES (?, ?)").run(VERSION_KEY, String(version));
      await db.exec("COMMIT");
      return { version, result, lockWaitMs };
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    await handle.close();
  }
}

type FileState = Map<string, Buffer | null>;

async function stateOf(fs: InMemoryFs): Promise<FileState> {
  const state: FileState = new Map();
  for (const path of fs.getAllPaths()) {
    if (path === "/" || isRuntime(path)) continue;
    const stat = await fs.stat(path);
    if (stat.isDirectory) state.set(path, null);
    else if (stat.isFile) state.set(path, Buffer.from(await fs.readFileBuffer(path)));
  }
  return state;
}

const depth = (path: string): number => path.split("/").length;

export class MemoryChangedError extends Error {}

export type Dreamt<T> = { version: number; result: T; changed: number; loadMs: number; commitMs: number; lockWaitMs: number };

export async function dreamInMemory<T>(path: string, run: (fs: InMemoryFs) => Promise<T>): Promise<Dreamt<T>> {
  const loadStart = performance.now();
  const loaded = await loadSnapshot(path, RUNTIME);
  const before = await stateOf(loaded.fs);
  const loadMs = performance.now() - loadStart;
  const result = await run(loaded.fs);
  const after = await stateOf(loaded.fs);
  const removed = [...before.keys()].filter((key) => !after.has(key) || (before.get(key) === null) !== (after.get(key) === null)).sort((a, b) => depth(b) - depth(a));
  const dirs = [...after].filter(([key, value]) => value === null && !before.has(key)).map(([key]) => key).sort((a, b) => depth(a) - depth(b));
  const files = [...after].filter(([key, value]) => value !== null && (!before.has(key) || before.get(key) === null || !(before.get(key) as Buffer).equals(value)));
  const changed = removed.length + dirs.length + files.length;
  if (changed === 0) return { version: loaded.version, result, changed, loadMs, commitMs: 0, lockWaitMs: 0 };
  const { handle, lockWaitMs } = await openLocked(path);
  const commitStart = performance.now();
  try {
    const db = handle.getDatabase();
    await db.exec("BEGIN");
    try {
      if ((await readVersion(handle)) !== loaded.version) throw new MemoryChangedError(`memory changed during dreaming: ${path}`);
      const fs = await wrapAgentFs(handle);
      for (const key of removed) await fs.rm(key, { recursive: true, force: true });
      for (const key of dirs) await fs.mkdir(key, { recursive: true });
      for (const [key, value] of files) await fs.writeFile(key, value as Buffer);
      const version = loaded.version + 1;
      await db.prepare("INSERT OR REPLACE INTO fs_config (key, value) VALUES (?, ?)").run(VERSION_KEY, String(version));
      await db.exec("COMMIT");
      return { version, result, changed, loadMs, commitMs: performance.now() - commitStart, lockWaitMs };
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    await handle.close();
  }
}
