import { ask, closeAll, consolidate, context, invalidate, remember } from "./service.js";

const USER = process.argv[2] ?? "demo";
let n = 0;
const heading = (text: string) => console.log(`\n=== ${text} ===`);

heading("会话 1 写入");
console.log(
  await remember(USER, `s${++n}`, [
    { role: "user", text: "我叫吴佳豪，在杭州做 AI infra，大三。以后回答请简短一点，别用 emoji。" },
    { role: "assistant", text: "好的，我会简短回答。" },
    { role: "user", text: "我女朋友叫小林，下周三是她生日，记住这个。" },
  ]),
);

heading("会话 2 写入（含对旧事实的修正）");
console.log(
  await remember(USER, `s${++n}`, [
    { role: "user", text: "更正一下，我不是大三，是大四了。" },
    { role: "assistant", text: "已更正。" },
  ]),
);
invalidate(USER);

heading("注入内容 context");
console.log(await context(USER));

heading("整理");
console.log(await consolidate(USER, "c1"));
invalidate(USER);

heading("读取侧回答");
console.log(await ask(USER, "q1", "我现在读大几？女朋友生日是什么时候？"));

await closeAll();
