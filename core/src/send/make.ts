import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Harness, SubmissionId } from "@earendil-works/pi-durable";
import { type Make, MakeDoc } from "./doc.js";
import { assistantText, sentIn } from "./sent.js";

export const MAKE_TIMEOUT_MS = 120_000;

export const MAKE_PROMPT =
  "[System request] The user picked one of your earlier messages, quoted below, and wants it turned into a panel widget. " +
  "Call send_to_user exactly once with type widget and widget.kind panel, built from that message. " +
  "Choose the body that fits the content best: stat, gauge, chart, list, timeline, note, media, weather or actions. " +
  "Give it a stable kebab-case id, a suitable size and a title. " +
  "Match the size to the amount of content: s holds one short value, m holds one short note or about two list rows with subtitles, l holds up to eight list rows, a long note or a chart. " +
  "Keep titles and subtitles short, and use l instead of m whenever a list has more than three rows. " +
  "Set end_turn to true. Do not send any text message and do not ask the user anything.\n\nQuoted message:\n";

export const makePrompt = (text: string): string => MAKE_PROMPT + JSON.stringify(text);

export type MakeOutcome = { state: "running" } | { state: "done" } | { state: "failed"; error: string };

type Entries = readonly { id?: unknown; kind?: unknown; model?: unknown }[];

export async function makeOutcome(harness: Harness, make: Make, entries: Entries, context: Context): Promise<MakeOutcome> {
  const submission = make.id === null ? undefined : await harness.submission(make.id as SubmissionId, context);
  const record = submission ? await submission.status(context) : undefined;
  if (record?.entry !== undefined) {
    const from = Number(record.entry);
    const to = record.answer === undefined ? Number.POSITIVE_INFINITY : Number(record.answer);
    const made = sentIn(entries.filter((entry) => Number(entry.id) > from && Number(entry.id) <= to)).some(
      (sent) => sent.input.type === "widget" && sent.input.widget?.kind === "panel",
    );
    if (made) return { state: "done" };
  }
  if (record?.status === "unanswered") return { state: "failed", error: record.reason === "aborted" ? "生成已中止" : "生成组件失败" };
  if (record?.status === "done") return { state: "failed", error: "助手没有生成组件卡" };
  if (Date.now() - make.at > MAKE_TIMEOUT_MS) return { state: "failed", error: "生成组件超时" };
  return { state: "running" };
}

export async function startMake(harness: Harness, root: Conversation, entries: Entries, command: { requestId: string; origin: string }): Promise<Make> {
  const { requestId, origin } = command;
  const last = ((await harness.snapshot(MakeDoc, BACKGROUND_CONTEXT))?.makes ?? []).filter((item) => item.origin === origin).at(-1);
  let make = last;
  if (make === undefined || (make.requestId !== requestId && (await makeOutcome(harness, make, entries, BACKGROUND_CONTEXT)).state === "failed")) {
    make = { origin, requestId, id: null, at: Date.now() };
    if (assistantText(entries, origin) === undefined) throw new Error("找不到这条助手文字消息");
    const created = make;
    await harness.commit(async (tx) => {
      const doc = await tx.doc(MakeDoc);
      if (!doc.makes.some((item) => item.requestId === created.requestId)) doc.makes.push(created);
    }, BACKGROUND_CONTEXT);
  }
  if (make.id !== null) return make;
  const text = assistantText(entries, origin);
  if (text === undefined) throw new Error("找不到这条助手文字消息");
  const submission = await root.submit({ type: "input", content: makePrompt(text), requestId: `make:${make.requestId}`, whenBusy: "followUp" }, BACKGROUND_CONTEXT);
  const key = make.requestId;
  await harness.commit(async (tx) => {
    const item = (await tx.doc(MakeDoc)).makes.find((entry) => entry.requestId === key);
    if (item !== undefined) item.id = submission.id as number;
  }, BACKGROUND_CONTEXT);
  return { ...make, id: submission.id as number };
}
