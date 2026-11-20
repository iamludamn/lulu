import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, MemoryStorage } from "@earendil-works/pi-durable";
import { BotSession } from "../dist/conversation/bot.js";
import { PanelDoc } from "../dist/panel/doc.js";
import { createTelemetry } from "../dist/telemetry/otlp.js";

test("a cold bot waits for the saved layout before publishing client state", { timeout: 5000 }, async () => {
  const readingPanel = Promise.withResolvers();
  const releasePanel = Promise.withResolvers();
  let delayPanel = false;
  class Storage extends MemoryStorage {
    async findDocument(address, ...args) {
      if (delayPanel && address.kind === PanelDoc.definition.kind) {
        readingPanel.resolve();
        await releasePanel.promise;
      }
      return super.findDocument(address, ...args);
    }

    // The seed session and the restarted bot share the same in-memory store.
    close() {}
  }
  const storage = new Storage();
  const seed = createSession(storage);
  await seed.commit(async (tx) => {
    const panel = await tx.doc(PanelDoc);
    panel.order.push("note");
    panel.widgets.note = { id: "note", title: "Saved note", size: "m", body: { kind: "note", markdown: "hello" } };
  }, BACKGROUND_CONTEXT);
  await seed.close(BACKGROUND_CONTEXT);
  delayPanel = true;

  const frames = [];
  const socket = { readyState: 1, send: (frame) => frames.push(JSON.parse(frame)), close: assert.fail };
  let attachment = { role: "client", ready: true };
  const bot = new BotSession({
    name: "main",
    env: {},
    storage: { get: async () => undefined },
    alarm: { get: async () => null, set: async () => {}, delete: async () => {} },
    sockets: { all: () => [socket], attachment: () => attachment, attach: (_, value) => { attachment = value; } },
    telemetry: createTelemetry({}, assert.fail),
  });

  let started = false;
  const startup = bot.start(async () => storage).then(() => { started = true; });
  try {
    await readingPanel.promise;
    assert.equal(started, false);
    assert.deepEqual(frames, []);
  } finally {
    releasePanel.resolve();
    await startup;
  }

  attachment = { role: "client", ready: false };
  await bot.webSocketMessage(socket, JSON.stringify({ type: "hello", incremental: true, schedules: true }));
  const states = frames.filter((frame) => frame.type === "state");
  assert.ok(states.length > 0);
  assert.ok(states.every((state) => state.panel.order.join() === "note"));
  assert.equal(states.at(-1).view.reset, true);
});
