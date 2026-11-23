import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NOOP_TELEMETRY_CONTEXT as telemetry } from "@earendil-works/pi-telemetry";
import { BotSession } from "../dist/conversation/bot.js";
import { parseFrame } from "../dist/conversation/frame.js";
import {
  admitPrompt, chaseDeliveries, chatDeliveryQuery, chatMessages, deliveryRetryIds, expireRequests,
  initializeDeliveryRetries, markDeliveryCancellation, nextDeliveryAlarm, reconcileDelivery, requestDeadlineAt,
} from "../dist/conversation/requests.js";
import { entryRange } from "../dist/conversation/transcript.js";
import { createMemoryExtension } from "../dist/memory/extension.js";
import { PanelDoc } from "../dist/panel.js";
import { createSendExtension } from "../dist/send/tool.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/chat-wire.json", import.meta.url), "utf8"));
const requestId = fixture.receipt.receipts[0].requestId;
const callId = fixture.receipt.receipts[0].callId;
const model = {
  id: "mock", name: "Mock", provider: "mock", api: "openai-completions",
  contextWindow: 100_000, maxTokens: 4_000, input: ["text"], reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function openChat(t, steps) {
  const models = Object.assign(createModels(), {
    getModel: () => model,
    streamSimple: (_model, request) => {
      const content = (steps.shift() ?? assert.fail("unexpected model call"))(request);
      const stopReason = content.some(part => part.type === "toolCall") ? "toolUse" : "stop";
      const message = {
        role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...model.cost, total: 0 } },
      };
      return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: stopReason, message }; }, result: async () => message };
    },
  });
  const registry = createRegistry();
  registry.install(createSendExtension(undefined));
  registry.install(createMemoryExtension({}));
  const harness = await Harness.open(new MemoryStorage(), { registry, models }, context);
  t.after(() => harness.close(context));
  const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id }, tools: null } });
  return { harness, root };
}

const admit = (harness, root, injection) => telemetry.startSpan({ name: "test.admission" }, span => admitPrompt(
  harness, root, { entries: [] }, { type: "prompt.submit", requestId, content: "Plan my trip", whenBusy: "followUp" },
  injection, { release: "test-release", span },
));

test("a silent turn retries with the original memory and settles once on the matching receipt", async t => {
  const memory = {
    requestId, context: "The user prefers trains.", outcome: "selected",
    selected: [{ resource: {
      id: "memory:trip", type: "topic", summary: "Travel preferences",
      sourceRefs: [], version: "v1", contentRef: "topics/travel.md",
    }, text: "The user prefers trains." }],
  };
  const { harness, root } = await openChat(t, [
    () => [{ type: "text", text: "Internal response without a send." }],
    request => {
      const system = request.messages.filter(message => message.role === "system").at(-1);
      assert.match(system.sections.memory, /prefers trains/);
      return [{ type: "toolCall", id: callId, name: "send_to_user", arguments: { type: "text", content: "Take the train.", end_turn: true } }];
    },
  ]);
  await initializeDeliveryRetries(harness);
  const { request, firstBinding } = await admit(harness, root, memory);
  assert.equal(firstBinding, true);
  const [message] = await chatMessages(harness, context);
  assert.equal((await (await harness.submission(message.id, context)).wait(context)).status, "done");
  assert.deepEqual(await admit(harness, root, { requestId, selected: [], outcome: "empty" }), { firstBinding: false });
  assert.equal((await chatMessages(harness, context)).length, 1);
  const chase = async () => chaseDeliveries(harness, root, await entryRange(root, 0, undefined, context), work => work());
  await chase();
  const [retry] = await deliveryRetryIds(harness, context);
  assert.equal((await (await harness.submission(retry, context)).wait(context)).status, "done");
  await chase();
  assert.deepEqual(await deliveryRetryIds(harness, context), [retry]);

  const receipt = parseFrame(JSON.stringify(fixture.receipt));
  const wrong = { ...receipt, receipts: [{ requestId, callId: "unrelated" }] };
  const stages = async (frame) => (await reconcileDelivery(harness, root, Date.now(), frame)).map(event => event.stage);
  assert.deepEqual(await stages(wrong), ["first_reply", "final_committed"]);
  assert.equal(await nextDeliveryAlarm(harness), message.deadline);
  assert.deepEqual(await stages(receipt), ["delivered"]);
  assert.deepEqual(await stages(receipt), []);
  assert.equal(await nextDeliveryAlarm(harness), undefined);

  const url = new URL("https://bot.example.test/chat-delivery-window");
  url.searchParams.set("query", `lulu_chat_delivery_window{measure="final_delivery_fraction",from="${request.acceptedAt - 1}",to="${Date.now() + 1}"}`);
  const result = await (await chatDeliveryQuery(new Request(url), harness)).json();
  assert.equal(result.data.result[0].value[1], "1");
  assert.equal(result.data.result[0].metric.release, "test-release");
});

test("a timed-out queued request leaves a failure and clears both alarm deadlines", async t => {
  const { harness, root } = await openChat(t, []);
  t.mock.method(harness, "resume", () => {});
  await admit(harness, root, { requestId, selected: [], outcome: "empty" });
  const [message] = await chatMessages(harness, context);
  assert.equal(await requestDeadlineAt(harness), message.deadline);
  await expireRequests(harness, root, message.deadline - 1);
  assert.equal((await chatMessages(harness, context))[0].error, undefined);
  await markDeliveryCancellation(harness);
  await expireRequests(harness, root, message.deadline);
  assert.match((await chatMessages(harness, context))[0].error, /exceeded/);
  assert.equal(await requestDeadlineAt(harness), undefined);
  assert.deepEqual(
    (await reconcileDelivery(harness, root, message.deadline)).map(event => event.stage),
    ["failed", "no_result"],
  );
  assert.equal(await nextDeliveryAlarm(harness), undefined);
});

test("Bot emits the state contract decoded by LuluKit", async t => {
  const sent = [];
  const socket = { readyState: 1, send: text => sent.push(JSON.parse(text)), close: (_code, reason) => assert.fail(reason) };
  let attachment = { role: "client", ready: false };
  const open = Harness.open.bind(Harness);
  let harness;
  t.mock.method(Harness, "open", async (...args) => {
    harness = await open(...args);
    await harness.commit(async tx => Object.assign(await tx.doc(PanelDoc), structuredClone(fixture.state.panel)), context);
    return harness;
  });
  const bot = new BotSession({
    name: "main",
    env: {},
    telemetry,
    storage: { get: async () => undefined },
    alarm: { get: async () => null, set: async () => {}, delete: async () => {} },
    sockets: { all: () => [], attachment: () => attachment, attach: (_, value) => { attachment = value; } },
    abort: reason => assert.fail(reason),
  });
  await bot.start(() => new MemoryStorage());
  t.after(async () => {
    await setImmediate();
    await harness.close(context);
  });
  await bot.webSocketMessage(socket, JSON.stringify({ type: "hello", incremental: true, schedules: true }));
  const { view, mcp: _mcp, ...state } = sent.find(frame => frame.type === "state");
  assert.deepEqual(state, {
    type: fixture.state.type, progress: fixture.state.progress, panel: fixture.state.panel, assets: fixture.state.assets,
  });
  const { conversation: _conversation, docs: _docs, before: _before, ...shape } = view;
  const { docs: _fixtureDocs, ...expected } = fixture.state.view;
  assert.deepEqual(shape, expected);
});
