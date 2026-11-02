import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import type { MemoryCommit, MemoryFiles } from "@lulu/core/memory/files.js";

const DIR = "/memory";
const GIT = `${DIR}/.git`;
const IDENTITY = { name: "lulu memory", email: "memory@lulu.invalid" };

const absolute = (path: string): string => `${DIR}/${path}`;

const parent = (path: string): string => path.slice(0, path.lastIndexOf("/"));

const isNotFound = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const orUndefined = <T>(error: unknown): T | undefined => {
  if (isNotFound(error)) return undefined;
  throw error;
};

export function createMemoryFiles(storage: DurableObjectStorage): MemoryFiles {
  const { fs, git } = new Workspace({ storage, git: createGitClient(), defaultGitIdentity: IDENTITY });
  let chain: Promise<unknown> = Promise.resolve();
  let ready: Promise<void> | undefined;

  const init = async (): Promise<void> => {
    if ((await fs.stat(`${GIT}/HEAD`).catch(orUndefined)) !== undefined) return;
    await fs.rm(GIT, { recursive: true, force: true });
    await fs.mkdir(DIR, { recursive: true });
    await git.init({ dir: DIR, defaultBranch: "main" });
  };

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain
      .then(() =>
        (ready ??= init().catch((error: unknown) => {
          ready = undefined;
          throw error;
        })),
      )
      .then(task);
    chain = run.catch(() => undefined);
    return run;
  };

  const head = (): Promise<string | undefined> => git.revParse({ dir: DIR, ref: "HEAD" }).catch(() => undefined);

  const tracked = async (oid: string | undefined): Promise<string[]> => (oid === undefined ? [] : git.lsFiles({ dir: DIR, ref: oid }));

  const working = async (): Promise<string[]> =>
    (await fs.find(DIR, "**", { exclude: [".git"] }))
      .filter((entry) => entry.type === "file")
      .map((entry) => entry.path.slice(DIR.length + 1))
      .sort();

  const read = (path: string): Promise<string | undefined> => fs.readFile(absolute(path), "utf8").catch(orUndefined<string>);

  const committed = async (oid: string | undefined, path: string): Promise<string | undefined> =>
    oid === undefined ? undefined : git.catFile({ dir: DIR, oid, filepath: path }).then(({ bytes }) => new TextDecoder().decode(bytes), () => undefined);

  const write = async (path: string, content: string): Promise<void> => {
    await fs.mkdir(parent(absolute(path)), { recursive: true });
    await fs.writeFile(absolute(path), content);
  };

  const remove = (path: string): Promise<void> => fs.rm(absolute(path), { force: true });

  const changed = async (): Promise<string[]> => {
    const oid = await head();
    const paths = [...new Set([...(await tracked(oid)), ...(await working())])].sort();
    const out: string[] = [];
    for (const path of paths) if ((await committed(oid, path)) !== (await read(path))) out.push(path);
    return out;
  };

  return {
    files: () => serial(working),
    read: (path) => serial(() => read(path)),
    write: (path, content) => serial(() => write(path, content)),
    remove: (path) => serial(() => remove(path)),
    changed: () => serial(changed),
    discard: (path) =>
      serial(async () => {
        const content = await committed(await head(), path);
        await (content === undefined ? remove(path) : write(path, content));
      }),
    commit: (message) =>
      serial(async () => {
        if ((await changed()).length === 0) return undefined;
        const files = await working();
        const gone = (await git.lsFiles({ dir: DIR })).filter((path) => !files.includes(path));
        await git.rm({ dir: DIR, paths: gone });
        await git.add({ dir: DIR, paths: files });
        return (await git.commit({ dir: DIR, message })).oid;
      }),
    commits: (depth) =>
      serial(async (): Promise<MemoryCommit[]> => {
        if ((await head()) === undefined) return [];
        return (await git.log({ dir: DIR, depth })).map(({ oid, message, committer }) => ({
          oid,
          message: message.endsWith("\n") ? message.slice(0, -1) : message,
          at: committer.timestamp * 1000,
        }));
      }),
  };
}
