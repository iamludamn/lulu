import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { openMemory } from "../store.js";

const run = promisify(execFile);

export type Exec = { stdout: string; stderr: string; exitCode: number };

export type Backend = {
  name: "A" | "B";
  id: string;
  exec: (command: string) => Promise<Exec>;
  stats: () => Promise<Stats>;
  suspend: () => Promise<void>;
  resume: () => Promise<void>;
  close: () => Promise<void>;
};

export type Stats = { cpuUsec: number; memoryBytes: number; anonBytes: number; diskBytes: number };

const DATA_DIR = new URL("../../data/bench/", import.meta.url).pathname;
const IMAGE = "pistack-mem-b";
const RUNTIME = process.env.B_RUNTIME;
const VOLUME = process.env.B_VOLUME === "1";

export async function openA(id: string): Promise<Backend> {
  const path = `${DATA_DIR}${id}.db`;
  await rm(path, { force: true });
  await rm(`${path}-wal`, { force: true });
  await rm(`${path}-shm`, { force: true });
  let memory = await openMemory(path);
  return {
    name: "A",
    id,
    exec: async (command) => {
      const result = await memory.hostBash.exec(command);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
    stats: async () => {
      globalThis.gc?.();
      const [cpu, current, detail] = await Promise.all([cgroup("cpu.stat"), cgroup("memory.current"), cgroup("memory.stat")]);
      const usage = process.cpuUsage();
      const sizes = await Promise.all(["", "-wal", "-shm"].map((suffix) => stat(`${path}${suffix}`).then((info) => info.size, () => 0)));
      return {
        cpuUsec: cpu ? Number(/usage_usec (\d+)/.exec(cpu)?.[1]) : usage.user + usage.system,
        memoryBytes: current ? Number(current) : process.memoryUsage().rss,
        anonBytes: Number(/^anon (\d+)/m.exec(detail ?? "")?.[1] ?? 0),
        diskBytes: sizes.reduce((a, b) => a + b, 0),
      };
    },
    suspend: () => memory.close(),
    resume: async () => {
      memory = await openMemory(path);
    },
    close: () => memory.close(),
  };
}

export async function openB(id: string): Promise<Backend> {
  const name = `pistack-mem-${id}`;
  await run("docker", ["rm", "-f", name]).catch(() => undefined);
  const flags = [...(RUNTIME ? ["--runtime", RUNTIME] : []), ...(VOLUME ? ["-v", `/var/tmp/pistack-mem/${id}:/m`] : [])];
  await run("docker", ["run", "-d", "--name", name, ...flags, IMAGE, "sleep", "infinity"]);
  const inside = (command: string) => run("docker", ["exec", name, "bash", "-c", command], { maxBuffer: 64 * 1024 * 1024 });
  const cid = (await run("docker", ["inspect", "-f", "{{.Id}}", name])).stdout.trim();
  const scope = `/sys/fs/cgroup/system.slice/docker-${cid}.scope`;
  return {
    name: "B",
    id,
    exec: async (command) => {
      try {
        const { stdout, stderr } = await inside(command);
        return { stdout, stderr, exitCode: 0 };
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string; code?: number };
        return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", exitCode: typeof failed.code === "number" ? failed.code : 1 };
      }
    },
    stats: async () => {
      const [cpu, memory, detail, disk] = await Promise.all([
        readFile(`${scope}/cpu.stat`, "utf8"),
        readFile(`${scope}/memory.current`, "utf8"),
        readFile(`${scope}/memory.stat`, "utf8"),
        run("docker", ["ps", "-a", "-s", "--filter", `name=^${name}$`, "--format", "{{.Size}}"]),
      ]);
      return { cpuUsec: Number(/usage_usec (\d+)/.exec(cpu)?.[1]), memoryBytes: Number(memory), anonBytes: Number(/^anon (\d+)/m.exec(detail)?.[1] ?? 0), diskBytes: writableBytes(disk.stdout) };
    },
    suspend: async () => {
      await run("docker", ["stop", "-t", "0", name]);
    },
    resume: async () => {
      await run("docker", ["start", name]);
    },
    close: async () => {
      await run("docker", ["rm", "-f", name]);
    },
  };
}

const cgroup = (file: string) => readFile(`/sys/fs/cgroup/${file}`, "utf8").catch(() => undefined);

const UNITS: Record<string, number> = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9 };

function writableBytes(size: string): number {
  const match = /^([\d.]+)\s*([kMG]?B)/.exec(size.trim());
  return match ? Number(match[1]) * (UNITS[match[2]] ?? 1) : 0;
}

export type Sys = { read: () => Promise<number>; memory: () => Promise<number>; close: () => Promise<void> };

const JIFFY_USEC = 10_000;

export async function openSys(): Promise<Sys> {
  return {
    read: async () => {
      const fields = (await readFile("/proc/stat", "utf8")).split("\n")[0]?.trim().split(/\s+/).slice(1).map(Number) ?? [];
      const busy = fields.slice(0, 8).reduce((a, b) => a + b, 0) - (fields[3] ?? 0) - (fields[4] ?? 0);
      return busy * JIFFY_USEC;
    },
    memory: async () => {
      const text = await readFile("/proc/meminfo", "utf8");
      const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
      return (kb("MemTotal") - kb("MemFree") - kb("Buffers") - kb("Cached") - kb("SReclaimable")) * 1024;
    },
    close: async () => undefined,
  };
}
