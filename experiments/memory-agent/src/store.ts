import { Bash, type IFileSystem } from "just-bash";
import { AgentFS } from "agentfs-sdk";
import { agentfs } from "agentfs-sdk/just-bash";
import { createGit, type GitCommandName } from "just-git";

const IDENTITY = { name: "memory-agent", email: "memory@pistack.local" };

const AGENT_GIT = new Set<GitCommandName>(["log", "show", "diff", "status", "checkout"]);
export const ALL_GIT: GitCommandName[] = [
  "init", "clone", "fetch", "pull", "push", "add", "blame", "commit", "status", "log", "branch", "tag", "checkout", "describe", "diff",
  "reset", "merge", "cherry-pick", "revert", "rebase", "mv", "rm", "remote", "config", "show", "stash", "rev-parse", "ls-files",
  "ls-tree", "clean", "switch", "restore", "reflog", "repack", "gc", "bisect", "grep", "shortlog", "worktree",
];

const SEED: Record<string, string> = {
  "system/profile.md": "---\ndescription: 用户是谁、长期偏好\n---\n",
  "system/feedback.md": "---\ndescription: 用户对助手的纠正与偏好\n---\n",
  "people/.keep": "",
  "areas/.keep": "",
  "topics/.keep": "",
};

export type Memory = {
  fs: IFileSystem;
  agentBash: Bash;
  hostBash: Bash;
  commit: (message: string) => Promise<boolean>;
  close: () => Promise<void>;
};

export const AGENT_DISABLED: GitCommandName[] = ALL_GIT.filter((name) => !AGENT_GIT.has(name));

export const shell = (fs: IFileSystem, disabled: GitCommandName[]) =>
  new Bash({
    fs,
    cwd: "/",
    python: false,
    javascript: false,
    customCommands: [createGit({ identity: IDENTITY, cwd: "/", network: false, disabled })],
  });

export type Handle = Awaited<ReturnType<typeof AgentFS.open>>;

export async function wrapAgentFs(handle: Handle): Promise<IFileSystem> {
  const base = await agentfs(handle);
  return Object.assign(Object.create(base) as IFileSystem, {
    realpath: async (target: string) => base.resolvePath("/", target),
    utimes: async () => undefined,
  });
}

export async function openMemory(path: string): Promise<Memory> {
  const handle = await AgentFS.open({ path });
  const fs = await wrapAgentFs(handle);
  const hostBash = shell(fs, []);
  const agentBash = shell(fs, AGENT_DISABLED);
  await seed(fs, hostBash);
  const commit = (message: string) => commitAll(hostBash, message);
  return { fs, agentBash, hostBash, commit, close: () => handle.close() };
}

export async function seed(fs: IFileSystem, host: Bash): Promise<boolean> {
  if (await fs.exists("/.git")) return false;
  for (const [file, content] of Object.entries(SEED)) {
    await fs.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    await fs.writeFile(`/${file}`, content);
  }
  await host.exec("git init && git add -A && git commit -m 'init memory'");
  return true;
}

export async function commitAll(host: Bash, message: string): Promise<boolean> {
  const status = await host.exec("git status --porcelain");
  if (status.stdout.trim() === "") return false;
  const result = await host.exec(`git add -A && git commit -m ${JSON.stringify(message)}`);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return true;
}
