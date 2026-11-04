import { AgentFS } from "agentfs-sdk";
import { agentfs } from "agentfs-sdk/just-bash";
import { Bash, type IFileSystem } from "just-bash";
import { createGit } from "just-git";
import { mkdir } from "node:fs/promises";

const USERS = Number(process.argv[2] ?? 20);
const DIR = "/tmp/memprobe/";
const IDENTITY = { name: "m", email: "m@m" };

const rss = () => {
  globalThis.gc?.();
  return process.memoryUsage().rss;
};
const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

const shell = (fs: IFileSystem) =>
  new Bash({ fs, cwd: "/", python: false, javascript: false, customCommands: [createGit({ identity: IDENTITY, cwd: "/", network: false, disabled: [] })] });

await mkdir(DIR, { recursive: true });
const steps: [string, number][] = [];
const mark = (name: string) => steps.push([name, rss()]);

mark("进程基线");
const handles = [];
for (let i = 0; i < USERS; i++) handles.push(await AgentFS.open({ path: `${DIR}u${i}-${Date.now()}.db` }));
mark("打开 AgentFS");
const fss = [];
for (const handle of handles) {
  const base = await agentfs(handle);
  fss.push(Object.assign(Object.create(base) as IFileSystem, { realpath: async (target: string) => base.resolvePath("/", target), utimes: async () => undefined }));
}
mark("包装成 just-bash 文件系统");
const shells = fss.map((fs) => shell(fs));
mark("创建 1 个 Bash（含 just-git）");
const second = fss.map((fs) => shell(fs));
mark("再创建第 2 个 Bash");
await Promise.all(shells.map((bash) => bash.exec("mkdir -p /m && cd /m && git init -q && echo hi > a.md && git add -A && git -c user.email=a@b -c user.name=n commit -qm x")));
mark("每用户跑一次 git 提交");
shells.length = 0;
second.length = 0;
mark("丢弃两个 Bash");
fss.length = 0;
for (const handle of handles) await handle.close();
handles.length = 0;
mark("关闭 AgentFS");

console.log(`用户数 ${USERS}`);
let previous = steps[0]?.[1] ?? 0;
const base = previous;
for (const [name, value] of steps) {
  console.log(`${name} | 累计 ${mb(value - base)} MB | 本步每用户 ${mb((value - previous) / USERS)} MB`);
  previous = value;
}
console.log(`绝对基线 ${mb(base)} MB`);
