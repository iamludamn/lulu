const arg = process.argv[2] ?? "24h";
const since = /^\d+h$/.test(arg) ? Date.now() - Number(arg.slice(0, -1)) * 3600e3 : Date.parse(arg);
if (Number.isNaN(since)) throw new Error("usage: lulu-state.mjs <24h | ISO time>");
const url = process.env.LULU_WS ?? "wss://lulu.jiahaowu0322.workers.dev/api/bots/main/ws";

const state = await new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  let last;
  const timer = setTimeout(() => (last ? resolve(last) : reject(new Error("no state with entries within 90s"))), 90_000);
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello" }));
  ws.onerror = () => reject(new Error("websocket error"));
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "state") return;
    last = message;
    if (message.view.entries.length > 0) {
      clearTimeout(timer);
      ws.close();
      resolve(message);
    }
  };
});

const text = (content) => (typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(" "));
const clip = (value, n) => value.replace(/\s+/g, " ").trim().slice(0, n);
const stamp = (ms) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const at = (entry) => entry.model?.[0]?.timestamp ?? 0;

console.log("## mcp");
for (const server of state.mcp) console.log(`${server.state === "connected" ? "ok " : "BAD"} ${server.name} ${server.state} tools=${server.tools}${server.error ? ` error=${clip(server.error, 160)}` : ""}`);

const entries = state.view.entries.filter((entry) => at(entry) >= since);
console.log(`\n## window\nsince ${new Date(since).toISOString()} entries=${entries.length}/${state.view.entries.length}`);

console.log("\n## errors");
for (const entry of entries) {
  const record = entry.model[0];
  if (record.role === "assistant" && record.stopReason === "error") console.log(`${stamp(record.timestamp)} model_error ${record.provider}/${record.model} task=${entry.byTaskId ?? "-"} ${clip(record.errorMessage ?? "", 160)}`);
  if (record.role === "toolResult" && record.isError) console.log(`${stamp(record.timestamp)} tool_error ${record.toolName} ${clip(text(record.content), 160)}`);
  if (record.role === "user" && /^### \w+ \(failed\)/.test(text(record.content))) console.log(`${stamp(record.timestamp)} delegate_failed ${clip(text(record.content), 200)}`);
}
for (const message of state.progress.messages) if (message.error !== null) console.log(`progress_error message=${message.id} ${clip(message.error, 160)}`);

console.log("\n## transcript");
let waiting;
for (const entry of entries) {
  const record = entry.model[0];
  if (record.role === "user") {
    const body = text(record.content);
    if (body.startsWith("### ")) {
      console.log(`${stamp(record.timestamp)} DELEGATE-RESULT ${clip(body, 140)}`);
      continue;
    }
    if (body.startsWith("[System request]")) {
      console.log(`${stamp(record.timestamp)} SYSTEM-REQUEST ${clip(body, 100)}`);
      continue;
    }
    if (waiting) console.log(`          ^ no reply to previous user message`);
    waiting = record.timestamp;
    console.log(`${stamp(record.timestamp)} USER ${clip(body, 200)}`);
  }
  if (record.role === "assistant" && Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part.type === "toolCall" && part.name === "send_to_user") {
        const latency = waiting ? ` (+${Math.round((record.timestamp - waiting) / 1000)}s)` : "";
        waiting = undefined;
        console.log(`${stamp(record.timestamp)} LULU${latency} [${part.arguments.type}] ${clip(String(part.arguments.content ?? part.arguments.title ?? ""), 240)}`);
      }
      if (part.type === "toolCall" && part.name === "delegate") console.log(`${stamp(record.timestamp)} DELEGATE ${clip(JSON.stringify(part.arguments), 140)}`);
    }
  }
}
if (waiting) console.log(`          ^ no reply to last user message`);
