import { mkdir } from "node:fs/promises";
import { openA, openB, openSys, type Backend } from "./backend.js";

const WHICH = process.argv[2] === "B" ? "B" : "A";
const TASKS = Number(process.argv[3] ?? 60);
const CONCURRENCY = Number(process.argv[4] ?? 10);
const GIT = "git init -q && git config user.email a@b.c && git config user.name n";

const SEED = `mkdir -p /m && cd /m && for i in $(seq 1 20); do printf '%s\\n' '---' "description: memory file $i" '---' "line one of file $i" > f$i.md; done && ${GIT} && git add -A && git commit -qm seed`;

const TASK = [
  "cd /m && cat f1.md f2.md f3.md | wc -l",
  "cd /m && grep -rl 'file 3' . | wc -l",
  "cd /m && sed -i 's/line one/line uno/' f1.md && git add -A && git commit -qm edit1",
  "cd /m && echo 'new fact' >> f2.md && git add -A && git commit -qm edit2",
  "cd /m && git log --oneline | wc -l",
  "cd /m && git status --porcelain | wc -l",
  "cd /m && find . -name '*.md' | wc -l",
  "cd /m && git show HEAD:f2.md | wc -l",
];

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
const sec = (usec: number) => (usec / 1e6).toFixed(2);

await mkdir(new URL("../../data/bench/", import.meta.url).pathname, { recursive: true });
const sys = await openSys();
const open = WHICH === "A" ? openA : openB;
const pool = async <T>(items: number, size: number, task: (index: number) => Promise<T>): Promise<T[]> => {
  const results: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items) {
        const index = next++;
        results[index] = await task(index);
      }
    }),
  );
  return results;
};

const users: Backend[] = [];
await pool(TASKS, CONCURRENCY, async (i) => {
  const backend = await open(`x4-${i}`);
  await backend.exec(SEED);
  await backend.suspend();
  users[i] = backend;
});

const probe = users[0];
if (!probe) throw new Error("no users");
await probe.resume();
const check = await probe.exec("cd /m && ls | wc -l");
await probe.suspend();

const zero = { cpuUsec: 0, memoryBytes: 0, anonBytes: 0, diskBytes: 0 };
const before = WHICH === "A" ? await probe.stats() : zero;
const vmBefore = await sys.read();
const memBefore = await sys.memory();
let peakVm = memBefore;
let peakCgroup = before.memoryBytes;
let peakAnon = before.anonBytes;
const sampler = setInterval(() => {
  void sys.memory().then((value) => {
    peakVm = Math.max(peakVm, value);
  });
  if (WHICH === "A")
    void probe.stats().then((stats) => {
      peakCgroup = Math.max(peakCgroup, stats.memoryBytes);
      peakAnon = Math.max(peakAnon, stats.anonBytes);
    });
}, 100);

const latencies: number[] = [];
const started = performance.now();
await pool(TASKS, CONCURRENCY, async (i) => {
  const backend = users[i];
  if (!backend) return;
  const start = performance.now();
  await backend.resume();
  for (const command of TASK) await backend.exec(command);
  await backend.suspend();
  latencies.push(performance.now() - start);
});
const elapsed = performance.now() - started;
clearInterval(sampler);

const after = WHICH === "A" ? await probe.stats() : zero;
const vmAfter = await sys.read();
const memAfter = await sys.memory();
latencies.sort((a, b) => a - b);

console.log(`\n方案 ${WHICH}，${TASKS} 个任务，并发 ${CONCURRENCY}，每个任务 ${TASK.length} 条命令，用户数据已存在，任务前恢复、任务后挂起`);
console.log(`恢复后数据完整性检查（应为 20）：${check.stdout.trim()}`);
console.log(`总耗时 ${(elapsed / 1000).toFixed(1)} 秒，每任务延迟 p50 ${Math.round(latencies[Math.floor(latencies.length / 2)] ?? 0)} ms，p95 ${Math.round(latencies[Math.floor(latencies.length * 0.95)] ?? 0)} ms`);
if (WHICH === "A") {
  console.log(`CPU 每任务 ${(((after.cpuUsec - before.cpuUsec) / 1e6 / TASKS) * 1000).toFixed(0)} 毫秒（容器 cgroup）`);
  console.log(`峰值匿名内存增量 ${mb(peakAnon - before.anonBytes)} MB，峰值 cgroup 内存增量 ${mb(peakCgroup - before.memoryBytes)} MB，任务后匿名内存增量 ${mb(after.anonBytes - before.anonBytes)} MB`);
} else {
  console.log(`CPU 每任务 ${(((vmAfter - vmBefore) / 1e6 / TASKS) * 1000).toFixed(0)} 毫秒（整台虚拟机）`);
}
console.log(`虚拟机整体：峰值内存增量 ${mb(peakVm - memBefore)} MB，任务后内存增量 ${mb(memAfter - memBefore)} MB`);

await Promise.all(users.map((backend) => backend.close()));
