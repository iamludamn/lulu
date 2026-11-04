import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { Bash } from "just-bash";
import { dream, loadSnapshot } from "../snapshot.js";

const PATH = "/var/tmp/snapshot/u1.db";
const FILES = Number(process.env.FILES ?? 200);
const HOLD_MS = 1500;

const seed = `for i in $(seq 0 ${FILES - 1}); do g=$((i % 4)); case $g in 0) d=system;; 1) d=people;; 2) d=areas;; *) d=topics;; esac; mkdir -p /$d; printf '%s\\n' '---' "description: memory file $i about topic $((i % 7))" '---' "fact line about the user." > /$d/f$i.md; done; mkdir -p /.git/objects && for i in $(seq 1 600); do echo x > /.git/objects/o$i; done`;

if (process.argv[2] === "dreamer") {
  await dream(PATH, async (fs) => {
    console.log("HOLDING");
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    await fs.writeFile("/system/new.md", "---\ndescription: written by dreaming\n---\nnew fact\n");
  });
  console.log("DONE");
} else {
  await mkdir("/var/tmp/snapshot", { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${PATH}${suffix}`, { force: true });
  const seeded = await dream(PATH, async (fs) => {
    const { Bash: B } = await import("just-bash");
    await new B({ fs, cwd: "/", python: false, javascript: false }).exec(seed);
  });
  console.log(`初始数据已写入，版本 ${seeded.version}，${FILES} 个文件加 600 个 git 对象`);

  const times: number[] = [];
  let snapshot = await loadSnapshot(PATH);
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    snapshot = await loadSnapshot(PATH);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(`读入快照：${snapshot.files} 个文件（已排除 .git），p50 ${times[2]?.toFixed(0)} 毫秒，最慢 ${times[4]?.toFixed(0)} 毫秒，版本 ${snapshot.version}`);

  let bash = new Bash({ fs: snapshot.fs, cwd: "/", python: false, javascript: false });
  const probes = ["cat /system/f0.md | head -n 2", "grep -rl 'topic 3' / | wc -l", "ls /system | wc -l", "find / -name '*.md' | wc -l"];
  for (const command of probes) {
    const run: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      await bash.exec(command);
      run.push(performance.now() - start);
    }
    run.sort((a, b) => a - b);
    console.log(`热路径 ${command} | p50 ${run[10]?.toFixed(2)} 毫秒`);
  }

  const child = spawn(process.execPath, ["--import", "tsx", process.argv[1] ?? "", "dreamer"], { stdio: ["ignore", "pipe", "inherit"], env: process.env });
  await new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("HOLDING")) resolve();
    });
  });
  const duringStart = performance.now();
  let served = 0;
  const reading = (async () => {
    while (performance.now() - duringStart < HOLD_MS - 300) {
      await bash.exec("cat /system/f0.md");
      served += 1;
    }
  })();
  const reload = loadSnapshot(PATH);
  await reading;
  console.log(`dreaming 持锁期间：热路径用旧快照继续读，完成 ${served} 次读取，无报错`);
  const next = await reload;
  console.log(`重新读入：等锁 ${next.lockWaitMs.toFixed(0)} 毫秒后拿到版本 ${next.version}，${next.files} 个文件，新文件可见：${(await next.fs.exists("/system/new.md")) ? "是" : "否"}`);
  bash = new Bash({ fs: next.fs, cwd: "/", python: false, javascript: false });
  console.log(`新快照读取：${(await bash.exec("cat /system/new.md | tail -n 1")).stdout.trim()}`);
  await new Promise((resolve) => child.on("close", resolve));
}
