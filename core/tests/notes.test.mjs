import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { parseFrame } from "../dist/conversation/frame.js";
import { entryRange } from "../dist/conversation/transcript.js";
import { noteApi } from "../dist/notes/api.js";
import { askNote } from "../dist/notes/ask.js";
import { acceptNote, generateNote, createNotesExtension } from "../dist/notes/chat.js";
import { handleApi } from "../dist/server/api.js";

const context = BACKGROUND_CONTEXT;

test("note commands validate attached revisions without changing ordinary prompts", () => {
  const prompt = { type: "prompt.submit", requestId: "req", content: "summarize", whenBusy: "followUp" };
  assert.deepEqual(parseFrame(JSON.stringify(prompt)), prompt);
  const attached = { ...prompt, noteRef: { id: randomUUID(), revision: 2 } };
  assert.deepEqual(parseFrame(JSON.stringify(attached)), attached);
  assert.throws(() => parseFrame(JSON.stringify({ ...attached, noteRef: { ...attached.noteRef, revision: 0 } })), /Invalid note reference/);
});

test("note writes reject malformed or duplicate blocks before calling storage", async () => {
  const block = { id: randomUUID(), kind: "text", text: "Some text" };
  const mutation = { id: randomUUID(), requestId: randomUUID(), baseRevision: 0, content: { title: "Note", blocks: [block, block] } };
  const store = { write() { assert.fail("Invalid notes must never reach storage"); } };
  const response = await noteApi(new Request("https://test.invalid/notes", { method: "PUT", body: JSON.stringify(mutation) }), "/notes", store);
  assert.equal(response.status, 400);
});

test("questions inside a note keep their context and edits outside the chat protocol", async () => {
  const paragraph = { id: randomUUID(), kind: "text", text: "Original paragraph" };
  const file = { id: randomUUID(), kind: "file", ref: "artifact://map.pdf@3" };
  const note = { title: "Trip", blocks: [paragraph, file], source: "original-chat-card" };
  const model = { id: "fixture" };
  const telemetry = { startSpan: async (_, run) => run({ setAttributes() {}, setStatus() {} }) };
  const models = {
    getAvailable: async () => [model],
    async completeSimple(_model, context) {
      assert.equal(context.messages.length, 1);
      const input = JSON.parse(context.messages[0].content);
      assert.deepEqual(input.note, note);
      assert.match(context.systemPrompt, /latest question explicitly asks/);
      const reply = input.question === "What is this about?" ? { reply: "A trip." } :
        { reply: "I updated the paragraph.", edit: { edits: [{ id: paragraph.id, text: "Revised paragraph" }] } };
      if (reply.edit) assert.deepEqual(input.previous, { question: "What is this about?", reply: "A trip." });
      return {
        stopReason: "stop", provider: "fixture", model: "fixture",
        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "text", text: JSON.stringify(reply) }],
      };
    },
  };
  let forwarded = 0;
  const host = {
    env: { LULU_CHAT_TOKEN: "fixture" }, telemetry,
    objects: { BOTS: { getByName: () => ({
      fetch(url, init) {
        assert.equal(url, "https://bot/notes/ask");
        forwarded++;
        return askNote(new Request(url, { ...init, duplex: "half" }), models, { provider: "fixture", modelId: "fixture" }, telemetry);
      },
    }) } },
  };
  const call = (body, authorized = true) => handleApi(new Request("https://test.invalid/api/bots/main/notes/ask", {
    method: "POST",
    headers: authorized ? { Authorization: "Bearer fixture" } : {},
    body: JSON.stringify(body),
  }), host);
  const first = { note, question: "What is this about?" };
  assert.equal((await call(first, false)).status, 401);
  assert.deepEqual(await (await call(first)).json(), { reply: "A trip." });
  const edit = await (await call({
    note, question: "Update the first paragraph",
    previous: { question: first.question, reply: "A trip." },
  })).json();
  assert.equal(forwarded, 2);
  assert.deepEqual(edit.content, { ...note, blocks: [{ ...paragraph, text: "Revised paragraph" }, file] });
  assert.equal(note.blocks[0].text, "Original paragraph");
});

test("a durable child drafts one card and acceptance can be replayed", { timeout: 5000 }, async t => {
  const source = deepseekProvider();
  const model = source.getModels()[0];
  const usage = { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const response = {
    role: "assistant", content: [{ type: "text", text: '{"title":"Trip","body":"Walk by the river."}' }],
    api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now(),
  };
  let childCalls = 0;
  const stream = () => {
    childCalls++;
    const events = createAssistantMessageEventStream();
    events.push({ type: "done", reason: "stop", message: response });
    return events;
  };
  const models = createModels({ authContext: { env: async () => "fixture", fileExists: async () => false } });
  models.setProvider({ ...source, stream, streamSimple: stream });
  const registry = createRegistry();
  registry.install(createNotesExtension());
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  t.after(() => harness.close(context));
  const modelRef = { provider: model.provider, modelId: model.id };
  const root = await harness.root(context, { agent: { model: modelRef } });
  await harness.commit(async tx => {
    await tx.appendEntry(root.id, { kind: "pi.assistant", model: [{ ...response,
      content: [{ type: "toolCall", id: "source", name: "send_to_user", arguments: { type: "text", content: "Walk by the river." } }],
    }] });
    await tx.appendEntry(root.id, { kind: "pi.tool-result", model: [{
      role: "toolResult", toolCallId: "source", toolName: "send_to_user", isError: false, content: [], timestamp: Date.now(),
    }] });
  }, context);
  await Promise.all([generateNote(harness, root, "source", modelRef, "request"), generateNote(harness, root, "source", modelRef, "request")]);
  const entries = () => entryRange(root, 0, undefined, context);
  let card;
  for (let attempt = 0; attempt < 80 && !card; attempt++) {
    card = (await entries()).find(entry => entry.kind === "lulu.note.proposal");
    if (!card) await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.ok(card, "child should publish a proposal, calls=" + childCalls + " kinds=" + (await entries()).map(e => e.kind));
  assert.equal(childCalls, 1);
  assert.equal(card.data.content.title, "Trip");
  assert.equal(card.data.content.source, "source");
  const durableWrites = new Map();
  const store = {
    async write(mutation) {
      if (!durableWrites.has(mutation.requestId)) durableWrites.set(mutation.requestId, mutation);
      return { ...mutation.content, id: mutation.id, revision: mutation.baseRevision + 1, updatedAt: Date.now() };
    },
  };
  await acceptNote(harness, root, store, card.data.id);
  await acceptNote(harness, root, store, card.data.id);
  assert.equal(durableWrites.size, 1);
  assert.equal((await entries()).filter(entry => entry.kind === "lulu.note.accepted").length, 1);
});

test("model edit leaves files and unchecked fields intact, and a stale offer is refused", async t => {
  const { LiveDoc } = await import("@earendil-works/pi-durable");
  const { bindNote, inheritNote } = await import("../dist/notes/context.js");
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  t.after(() => harness.close(context));
  const root = await harness.root(context);
  const paragraph = { id: randomUUID(), kind: "text", text: "Original" };
  const file = { id: randomUUID(), kind: "file", ref: "artifact://map.pdf@3" };
  const note = { id: randomUUID(), revision: 3, updatedAt: Date.now(), title: "Trip", blocks: [paragraph, file] };
  await harness.commit(async tx => {
    await bindNote(tx, 12, { id: note.id, revision: 3 });
    await inheritNote(tx, 12, 13);
  }, context);
  const api = {
    conversationId: root.id,
    callId: "edit-call",
    snapshot: (token, ...args) => token === LiveDoc ? { run: { inputs: [13] } } : harness.snapshot(token, ...args),
    commit: harness.commit.bind(harness),
  };
  const tool = createNotesExtension({ read: async (ref) => {
    assert.deepEqual(ref, { id: note.id, revision: 3 });
    return note;
  } }).tools[0];
  const input = { edits: [{ id: paragraph.id, text: "Revised" }] };
  const ordinary = { ...api, snapshot: (token, ...args) =>
    token === LiveDoc ? { run: { inputs: [13, 14] } } : harness.snapshot(token, ...args) };
  assert.equal((await tool.execute(input, ordinary, context)).isError, true);
  assert.notEqual((await tool.execute(input, api, context)).isError, true);
  await tool.execute(input, api, context);
  const entries = () => entryRange(root, 0, undefined, context);
  const offers = (await entries()).filter(entry => entry.kind === "lulu.note.proposal");
  assert.equal(offers.length, 1);
  const [{ data }] = offers;
  assert.equal(data.base.revision, 3);
  assert.deepEqual(data.content.blocks, [{ ...paragraph, text: "Revised" }, file]);
  await assert.rejects(acceptNote(harness, root, { write: async () => undefined }, data.id), /原笔记已更新/);
  assert.ok(!(await entries()).some(entry => entry.kind === "lulu.note.accepted"));
});
