import { mkdir } from "node:fs/promises";
import { openA, openB, openSys, type Backend, type Stats, type Sys } from "./backend.js";

const WHICH = process.argv[2] === "B" ? "B" : "A";
const USERS = Number(process.argv[3] ?? 10);
const IDLE_SECONDS = Number(process.argv[4] ?? 60);
const FILE_COUNTS = process.env.SKIP_IO === "1" ? [] : [20, 200, 1000];
const GIT = "git init -q && git config user.email a@b.c && git config user.name n";

const seedCommand = (files: number) =>
  `mkdir -p /m && cd /m && for i in $(seq 1 ${files}); do printf '%s\\n' '---' "description: memory file $i about topic $((i % 7))" '---' "line one of file $i" "line two of file $i" > f$i.md; done && ${GIT} && git add -A && git commit -qm seed`;

const WORKLOAD = [
  "cd /m && cat f1.md f2.md f3.md | wc -l",
  "cd /m && grep -rl 'topic 3' . | wc -l",
  "cd /m && sed -i 's/line one/line uno/' f1.md && git add -A && git commit -qm edit1",
  "cd /m && echo 'new fact' >> f2.md && git add -A && git commit -qm edit2",
  "cd /m && git log --oneline | wc -l",
  "cd /m && git status --porcelain | wc -l",
  "cd /m && find . -name '*.md' | wc -l",
  "cd /m && git diff HEAD~1 --stat | tail -n 1",
  "cd /m && grep -n 'description' f5.md",
  "cd /m && git show HEAD:f2.md | wc -l",
];

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

const timed = async <T>(task: () => Promise<T>): Promise<[T, number]> => {
  const start = performance.now();
  const value = await task();
  return [value, performance.now() - start];
};

const total = async (backends: Backend[], sys?: Sys): Promise<Stats & { vmCpuUsec: number }> => {
  const vmCpuUsec = (await sys?.read()) ?? 0;
  const all = await Promise.all(backends.map((backend) => backend.stats()));
  const disk = all.reduce((sum, stats) => sum + stats.diskBytes, 0);
  if (backends[0]?.name === "A") return { cpuUsec: all[0]?.cpuUsec ?? 0, memoryBytes: all[0]?.memoryBytes ?? 0, diskBytes: disk, anonBytes: all[0]?.anonBytes ?? 0, vmCpuUsec };
  return { cpuUsec: all.reduce((sum, stats) => sum + stats.cpuUsec, 0), memoryBytes: all.reduce((sum, stats) => sum + stats.memoryBytes, 0), anonBytes: all.reduce((sum, stats) => sum + stats.anonBytes, 0), diskBytes: disk, vmCpuUsec };
};

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
const sec = (usec: number) => (usec / 1e6).toFixed(2);

type Report = {
  name: string;
  openMs: number;
  openCpuSec: string;
  workloadCpuSec: string;
  idleCpuSec: string;
  vmOpenSec: string;
  vmWorkloadSec: string;
  vmIdleSec: string;
  memoryMb: string;
  memoryPerUserMb: string;
  memoryBaseMb: string;
  vmMemoryPerUserMb: string;
  anonPerUserMb: string;
  diskMb: string;
  p50: number;
  p95: number;
  io: Record<number, Record<string, number>>;
};

async function ioBench(backend: Backend): Promise<Report["io"]> {
  const result: Report["io"] = {};
  for (const files of FILE_COUNTS) {
    const dir = `/io${files}`;
    const steps: [string, string][] = [
      ["write", `mkdir -p ${dir} && cd ${dir} && for i in $(seq 1 ${files}); do printf '%s\\n' 'memory line' "content number $i" > f$i.md; done`],
      ["read", `cd ${dir} && cat f*.md | wc -c`],
      ["grep", `cd ${dir} && grep -rl 'number ${files} ' . | wc -l`],
      ["gitAdd", `cd ${dir} && ${GIT} && git add -A && git commit -qm all`],
      ["gitStatus", `cd ${dir} && git status --porcelain | wc -l`],
      ["editCommit", `cd ${dir} && for i in $(seq 1 10); do echo more >> f$i.md; done && git add -A && git commit -qm edit`],
    ];
    result[files] = {};
    for (const [name, command] of steps) {
      const [, ms] = await timed(() => backend.exec(command));
      result[files][name] = Math.round(ms);
    }
  }
  return result;
}

async function measure(open: (id: string) => Promise<Backend>, sys?: Sys): Promise<Report> {
  const base = await open("probe").then(async (probe) => {
    const stats = probe.name === "A" ? await probe.stats() : { cpuUsec: 0, memoryBytes: 0, anonBytes: 0, diskBytes: 0 };
    await probe.close();
    return stats;
  });
  const vmBase0 = (await sys?.read()) ?? 0;
  if (sys) await new Promise((resolve) => setTimeout(resolve, IDLE_SECONDS * 1000));
  const vm0 = (await sys?.read()) ?? 0;
  const vmMem0 = (await sys?.memory()) ?? 0;
  const vmNoise = vm0 - vmBase0;
  const [backends, openMs] = await timed(() => Promise.all(Array.from({ length: USERS }, (_, i) => open(`x3-${i}`))));
  const name = backends[0]?.name ?? "?";
  const afterOpen = await total(backends, sys);
  await Promise.all(backends.map((backend) => backend.exec(seedCommand(20))));
  const afterSeed = await total(backends, sys);
  const latencies: number[] = [];
  await Promise.all(
    backends.map(async (backend) => {
      for (const command of WORKLOAD) {
        const [, ms] = await timed(() => backend.exec(command));
        latencies.push(ms);
      }
    }),
  );
  const afterWorkload = await total(backends, sys);
  await new Promise((resolve) => setTimeout(resolve, IDLE_SECONDS * 1000));
  const afterIdle = await total(backends, sys);
  const vmMem1 = (await sys?.memory()) ?? 0;
  const first = backends[0];
  const io = first === undefined ? {} : await ioBench(first);
  const report: Report = {
    name,
    openMs: Math.round(openMs),
    openCpuSec: sec(afterOpen.cpuUsec - base.cpuUsec),
    workloadCpuSec: sec(afterWorkload.cpuUsec - afterSeed.cpuUsec),
    idleCpuSec: sec(afterIdle.cpuUsec - afterWorkload.cpuUsec),
    vmOpenSec: sys ? sec(afterOpen.vmCpuUsec - vm0) : "-",
    vmWorkloadSec: sys ? sec(afterWorkload.vmCpuUsec - afterSeed.vmCpuUsec) : "-",
    vmIdleSec: sys ? sec(afterIdle.vmCpuUsec - afterWorkload.vmCpuUsec - vmNoise) : "-",
    memoryMb: mb(afterIdle.memoryBytes - base.memoryBytes),
    memoryPerUserMb: mb((afterIdle.memoryBytes - base.memoryBytes) / USERS),
    memoryBaseMb: mb(base.memoryBytes),
    anonPerUserMb: mb((afterIdle.anonBytes - base.anonBytes) / USERS),
    vmMemoryPerUserMb: sys ? mb((vmMem1 - vmMem0) / USERS) : "-",
    diskMb: mb(afterIdle.diskBytes),
    p50: Math.round(percentile(latencies, 0.5)),
    p95: Math.round(percentile(latencies, 0.95)),
    io,
  };
  await Promise.all(backends.map((backend) => backend.close()));
  return report;
}

await mkdir(new URL("../../data/bench/", import.meta.url).pathname, { recursive: true });
const sys = WHICH === "B" ? await openSys() : undefined;
const reports = [await measure(WHICH === "A" ? openA : openB, sys)];
await sys?.close();

console.log(`\nN=${USERS} 用户，空闲 ${IDLE_SECONDS} 秒，方案 ${WHICH}`);
console.log("方案 | 打开耗时ms | 打开CPU秒 | 工作负载CPU秒 | 空闲CPU秒 | 虚拟机打开CPU秒 | 虚拟机工作负载CPU秒 | 虚拟机空闲CPU秒(扣噪声) | 内存增量MB | 每用户MB | 虚拟机内存每用户MB | 匿名内存每用户MB | 固定MB | 磁盘MB | 命令p50ms | 命令p95ms");
for (const r of reports) console.log([r.name, r.openMs, r.openCpuSec, r.workloadCpuSec, r.idleCpuSec, r.vmOpenSec, r.vmWorkloadSec, r.vmIdleSec, r.memoryMb, r.memoryPerUserMb, r.vmMemoryPerUserMb, r.anonPerUserMb, r.memoryBaseMb, r.diskMb, r.p50, r.p95].join(" | "));
console.log("\nIO（单用户，毫秒）");
console.log("方案 | 文件数 | write | read | grep | gitAdd | gitStatus | editCommit");
for (const r of reports)
  for (const files of FILE_COUNTS) {
    const io = r.io[files] ?? {};
    console.log([r.name, files, io.write, io.read, io.grep, io.gitAdd, io.gitStatus, io.editCommit].join(" | "));
  }
