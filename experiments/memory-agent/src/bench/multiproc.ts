import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { AgentFS } from "agentfs-sdk";

const PATH = "/var/tmp/multiproc.db";

if (process.argv[2] === "writer") {
  const handle = await AgentFS.open({ path: PATH });
  const db = handle.getDatabase();
  await db.exec("BEGIN");
  await db.exec("INSERT OR REPLACE INTO fs_config (key, value) VALUES ('memory_version', '2')");
  await db.exec("COMMIT");
  console.log("writer: 已提交版本 2");
  await handle.close();
} else {
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${PATH}${suffix}`, { force: true });
  const reader = await AgentFS.open({ path: PATH });
  const db = reader.getDatabase();
  await db.exec("INSERT OR REPLACE INTO fs_config (key, value) VALUES ('memory_version', '1')");
  const read = async () => (await db.prepare("SELECT value FROM fs_config WHERE key = 'memory_version'").get()) as { value: string } | undefined;
  console.log("reader: 初始版本", (await read())?.value);
  const child = spawn(process.execPath, ["--import", "tsx", process.argv[1] ?? "", "writer"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  await new Promise((resolve) => child.on("close", resolve));
  console.log(output.trim());
  console.log("reader: writer 退出后读到的版本", (await read())?.value);
  await reader.close();
  const fresh = await AgentFS.open({ path: PATH });
  console.log("reader: 重新打开后读到的版本", ((await fresh.getDatabase().prepare("SELECT value FROM fs_config WHERE key = 'memory_version'").get()) as { value: string } | undefined)?.value);
  await fresh.close();
}
