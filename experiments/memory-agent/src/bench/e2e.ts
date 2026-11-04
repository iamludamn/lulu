import { spawn } from "node:child_process";
import { ask, closeAll, consolidate, context, invalidate, remember } from "../service.js";

const USER = process.env.E2E_USER ?? `e2e-${Date.now()}`;
const SESSIONS = [
  [
    { role: "user" as const, text: "我叫吴佳豪，在杭州做 AI infra，大三。以后回答请简短一点，别用 emoji。" },
    { role: "assistant" as const, text: "好的，我会简短回答。" },
    { role: "user" as const, text: "我女朋友叫小林，下周三是她生日，记住这个。" },
  ],
  [
    { role: "user" as const, text: "更正一下，我不是大三，是大四了。" },
    { role: "assistant" as const, text: "已更正。" },
  ],
];

if (process.argv[2] === "writer") {
  const send = (step: string, stats: unknown) => process.send?.({ step, stats });
  send("remember-1", await remember(USER, "s1", SESSIONS[0] ?? []));
  send("remember-2", await remember(USER, "s2", SESSIONS[1] ?? []));
  send("consolidate", await consolidate(USER, "c1"));
  await closeAll();
  process.exit(0);
} else {
  const time = async <T>(task: () => Promise<T>): Promise<[T, number]> => {
    const start = performance.now();
    const value = await task();
    return [value, Math.round(performance.now() - start)];
  };
  const question = async (label: string, text: string) => {
    const [result, ms] = await time(() => ask(USER, `${label}-${Date.now()}`, text));
    console.log(`[读取侧 ${label}] 版本 ${result.version}，耗时 ${ms} 毫秒\n  问：${text}\n  答：${result.answer.trim()}`);
  };
  console.log(`用户 ${USER}`);
  await question("无记忆", "我叫什么名字？");
  const child = spawn(process.execPath, ["--import", "tsx", process.argv[1] ?? "", "writer"], { stdio: ["ignore", "inherit", "inherit", "ipc"], env: { ...process.env, E2E_USER: USER } });
  const steps = new Map<string, () => void>();
  const arrived = new Map<string, unknown>();
  child.on("message", (message: { step: string; stats: unknown }) => {
    arrived.set(message.step, message.stats);
    steps.get(message.step)?.();
  });
  const wait = (step: string) => new Promise<void>((resolve) => (arrived.has(step) ? resolve() : steps.set(step, resolve)));
  await wait("remember-1");
  console.log("[写入侧 remember-1]", JSON.stringify(arrived.get("remember-1")));
  invalidate(USER);
  const [text, contextMs] = await time(() => context(USER));
  console.log(`[读取侧] 重新读入快照加生成 section，${contextMs} 毫秒，${text.length} 字符`);
  await question("会话1后", "我叫什么？在哪工作？读大几？女朋友生日是什么时候？");
  await wait("remember-2");
  console.log("[写入侧 remember-2]", JSON.stringify(arrived.get("remember-2")));
  invalidate(USER);
  await question("会话2后", "我现在读大几？");
  await wait("consolidate");
  console.log("[写入侧 consolidate]", JSON.stringify(arrived.get("consolidate")));
  invalidate(USER);
  await question("整理后", "我现在读大几？女朋友叫什么？");
  console.log("\n最终注入内容：\n" + (await context(USER)));
  await new Promise((resolve) => child.on("close", resolve));
  await closeAll();
}
