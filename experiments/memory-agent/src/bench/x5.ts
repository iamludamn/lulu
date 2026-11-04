import { mkdir, readFile, stat } from "node:fs/promises";
import { getContext } from "../context.js";
import { dreamInMemory, loadSnapshot, type Snapshot } from "../snapshot.js";
import { ALL_GIT, shell } from "../store.js";
import { openB, openSys, type Backend } from "./backend.js";

const WHICH = process.argv[2] === "B" ? "B" : "A";
const USERS = Number(process.argv[3] ?? 60);
const TASKS = Number(process.argv[4] ?? 180);
const CONCURRENCY = Number(process.argv[5] ?? 10);
const FILES = 40;
const DIR = "/var/tmp/x5/";

const OPS = [
  "cat /system/f0.md /system/f4.md /system/f8.md",
  "grep -rl 'topic 3' /",
  "ls /people | wc -l",
  "find / -name '*.md' | wc -l",
  "cat /people/f1.md",
];

const seedCommand = (base: string) => `for i in $(seq 0 ${FILES - 1}); do g=$((i % 4)); case $g in 0) d=system;; 1) d=people;; 2) d=areas;; *) d=topics;; esac; mkdir -p ${base}/$d; printf '%s\\n' '---' "description: memory file $i about topic $((i % 7)) with some keywords" '---' "fact line about the user and their preferences." > ${base}/$d/f$i.md; done; cd ${base || "/"} && git init -q && git config user.email a@b.c && git config user.name n && git add -A && git commit -qm seed`;
const bOps = OPS.map((command) => command.replace(/ \/(system|people|areas|topics)/g, " /m/$1").replace("-rl 'topic 3' /", "-rl 'topic 3' /m").replace("find / ", "find /m "));

const cgroup = (file: string) => readFile(`/sys/fs/cgroup/${file}`, "utf8");
const cpuUsec = async () => Number(/usage_usec (\d+)/.exec(await cgroup("cpu.stat"))?.[1]);
const anonBytes = async () => {
  globalThis.gc?.();
  return Number(/^anon (\d+)/m.exec(await cgroup("memory.stat"))?.[1]);
};
const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

const pool = async (items: number, size: number, task: (index: number) => Promise<void>): Promise<void> => {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items) await task(next++);
    }),
  );
};

await mkdir(DIR, { recursive: true });
const latencies: number[] = [];
const report = (cpuPerTask: number, extra: string) => {
  latencies.sort((a, b) => a - b);
  console.log(`方案 ${WHICH}，${USERS} 个用户，${TASKS} 个任务，并发 ${CONCURRENCY}：CPU 每任务 ${(cpuPerTask * 1000).toFixed(0)} 毫秒，延迟 p50 ${Math.round(latencies[Math.floor(latencies.length / 2)] ?? 0)} 毫秒 / p95 ${Math.round(latencies[Math.floor(latencies.length * 0.95)] ?? 0)} 毫秒；${extra}`);
};

if (WHICH === "A") {
  const path = (i: number) => `${DIR}u${i}.db`;
  await pool(USERS, CONCURRENCY, async (i) => {
    await dreamInMemory(path(i), async (fs) => {
      await shell(fs, []).exec(seedCommand(""));
    });
  });
  const sizes = await Promise.all(Array.from({ length: USERS }, async (_, i) => (await Promise.all(["", "-wal"].map((suffix) => stat(`${path(i)}${suffix}`).then((info) => info.size, () => 0)))).reduce((a, b) => a + b, 0)));
  console.log(`磁盘每用户 ${mb(sizes.reduce((a, b) => a + b, 0) / USERS)} MB（sqlite 文件加 WAL）`);
  const loaded0 = await anonBytes();
  const cpu0 = await cpuUsec();
  let peak = loaded0;
  const sampler = setInterval(() => void anonBytes().then((v) => (peak = Math.max(peak, v))), 100);
  await pool(TASKS, CONCURRENCY, async (i) => {
    const start = performance.now();
    const snapshot = await loadSnapshot(path(i % USERS));
    await getContext(snapshot.fs);
    const bash = shell(snapshot.fs, ALL_GIT);
    for (const op of OPS) await bash.exec(op);
    latencies.push(performance.now() - start);
  });
  clearInterval(sampler);
  const cpu = (await cpuUsec()) - cpu0;
  const afterAnon = await anonBytes();
  const held: Snapshot[] = [];
  const before = await anonBytes();
  for (let i = 0; i < Math.min(USERS, 60); i++) held.push(await loadSnapshot(path(i)));
  const resident = ((await anonBytes()) - before) / held.length;
  report(cpu / 1e6 / TASKS, `并发峰值匿名内存增量 ${mb(peak - loaded0)} MB，任务后残留 ${mb(afterAnon - loaded0)} MB，每个常驻快照 ${mb(resident)} MB（含 ${held[0]?.files} 个文件）`);
} else {
  const sys = await openSys();
  const users: Backend[] = [];
  const memBefore = await sys.memory();
  await pool(USERS, CONCURRENCY, async (i) => {
    const backend = await openB(`x5-${i}`);
    await backend.exec(seedCommand("/m"));
    users[i] = backend;
  });
  const resident = (await sys.memory()) - memBefore;
  const vm0 = await sys.read();
  await pool(TASKS, CONCURRENCY, async (i) => {
    const backend = users[i % USERS];
    if (!backend) return;
    const start = performance.now();
    for (const op of bOps) await backend.exec(op);
    latencies.push(performance.now() - start);
  });
  const cpu = await sys.read() - vm0;
  report(cpu / 1e6 / TASKS, `常驻沙箱每个 ${mb(resident / USERS)} MB（整台虚拟机口径）`);
  await Promise.all(users.map((backend) => backend.close()));
}
