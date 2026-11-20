import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, MemoryStorage } from "@earendil-works/pi-durable";
import { ArtifactService } from "../dist/artifact/service.js";
import { CronJobsDoc } from "../dist/cron/doc.js";
import { CronTriggerRegistration } from "../dist/cron/registration.js";
import { STORED_DOC_KINDS as kinds } from "../dist/durable-names.js";
import { PanelDoc } from "../dist/panel/doc.js";
import { BotDataPersistence, startupData } from "../dist/conversation/bot-data.js";
import { handleApi } from "../dist/server/api.js";
import { AssetsDoc } from "../dist/send/doc.js";
import { SpaceRefreshDoc, SpaceRefreshIndex } from "../dist/space/doc.js";
import { spaceCronDue } from "../dist/space/refresh.js";
import { utcDailyCron } from "../dist/cron/schedule.js";

const telemetry = { startSpan: (_options, run) => run({ setAttributes() {}, setStatus() {} }) };
const space = { id: "demo-space", size: "l", title: "My Space", body: { kind: "space", src: "artifact://spaces/demo-space/index.html@3", preview: "artifact://spaces/demo-space/cover.html@2" } };
const tick = Date.parse("2026-07-10T01:00:00Z");
const refresh = {
  generation: "space", mode: { kind: "scheduled", time: "09:00", tz: "Asia/Singapore" }, enabled: true,
  archived: false, notify: false, nextAt: tick, retryAt: null, monitor: null, providerState: null,
  startedAt: 1, checkedAt: null, updatedAt: 2, error: null, version: 4, seen: 0, delivered: 0,
  findings: [], value: '{"fresh":true}', runs: [], changes: [], cost: 0,
};

function nativeStore() {
  const state = new Map();
  return {
    get: async (key) => state.get(key),
    put: async (changes) => { for (const [key, value] of Object.entries(changes)) state.set(key, value); },
    state,
  };
}

function externalStore() {
  let value;
  return {
    key: "test",
    read: async () => structuredClone(value),
    readStartup: async () => value === undefined ? undefined : startupData(value),
    save: async (data) => { value = structuredClone(data); },
  };
}

test("migrates selected Bot docs, gates commit acknowledgement, and restores from the external copy", async (t) => {
  class PersistentMemory extends MemoryStorage { async close() {} }
  const storage = new PersistentMemory();
  const legacy = createSession(storage);
  await legacy.commit(async (tx) => {
    const panel = await tx.doc(PanelDoc);
    panel.order.push(space.id);
    panel.widgets[space.id] = space;
    (await tx.doc(AssetsDoc)).items.push({ ref: "artifact://report.md@4", title: "Report", origin: "saved", savedAt: 1 });
    (await tx.doc(SpaceRefreshIndex)).ids.push(space.id);
    (await tx.doc(SpaceRefreshDoc, space.id, null)).entry = refresh;
    (await tx.doc(CronJobsDoc)).jobs.push({ id: "job", name: "Wake", prompt: "Reminder", schedule: { kind: "once", at: tick }, state: "active", nextRunAt: tick, lastRun: null });
  }, context);
  await legacy.close(context);

  const external = externalStore();
  const native = nativeStore();
  const data = new BotDataPersistence(storage, native, external);
  const session = createSession(data.storage);
  t.after(() => session.close(context));
  await data.start(session);
  assert.deepEqual((await external.readStartup()).panel.order, [space.id]);
  const save = external.save;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  let finish;
  const unblock = new Promise((resolve) => { finish = resolve; });
  external.save = async (value) => { ready(); await unblock; await save(value); };
  let acknowledged = false;
  const mutation = session.commit(async (tx) => {
    (await tx.doc(PanelDoc)).widgets[space.id].title = "Updated Space";
  }, context).then(() => { acknowledged = true; });
  await started;
  assert.equal(acknowledged, false);
  assert.equal(native.state.get("bot-data:test"), "pending");
  finish();
  await mutation;
  assert.equal(native.state.get("bot-data:test"), "ready");
  const restored = new BotDataPersistence(new MemoryStorage(), nativeStore(), external);
  const newSession = createSession(restored.storage);
  t.after(() => newSession.close(context));
  await restored.start(newSession);
  assert.equal((await newSession.snapshot(PanelDoc, context)).widgets[space.id].title, "Updated Space");
  assert.equal((await newSession.snapshot(AssetsDoc, context)).items[0].ref, "artifact://report.md@4");
  assert.equal((await newSession.snapshot(CronJobsDoc, context)).jobs[0].nextRunAt, tick);
  assert.equal((await newSession.snapshot(SpaceRefreshDoc, space.id, context)).entry.value, '{"fresh":true}');
});

test("Worker serves startup and saved Space reads without a Bot stub", async () => {
  const data = externalStore();
  await data.save({ documents: {
    [kinds.panel]: { order: [space.id], widgets: { [space.id]: space } },
    [kinds.spaceRefresh + ":" + space.id]: { entry: refresh },
  } });
  const never = { getByName() { assert.fail("unexpected Durable Object call"); } };
  const host = { env: { LULU_CHAT_TOKEN: "private" }, objects: { BOTS: never, ARTIFACTS: never, MEMORY: never }, telemetry, data };
  const endpoint = "https://test/api/bots/main";
  assert.equal((await handleApi(new Request(endpoint + "/startup"), host)).status, 401);
  const startup = await handleApi(new Request(endpoint + "/startup", { headers: { Authorization: "Bearer private" } }), host);
  assert.equal(startup.status, 200);
  const layout = await startup.json();
  assert.equal(layout.panel.widgets[space.id].body.preview, space.body.preview);
  assert.equal(layout.panel.spaceUpdates[space.id].version, 4);
  assert.doesNotMatch(JSON.stringify(layout), /generation|findings|fresh/);
  const updates = await handleApi(new Request(endpoint + "/spaces/refresh?id=" + space.id), host);
  assert.equal(updates.status, 200);
  assert.deepEqual((await updates.json()).data.value, { fresh: true });
  assert.equal(spaceCronDue(refresh, utcDailyCron(tick), tick, tick), true);
  assert.equal(spaceCronDue({ ...refresh, immediatePull: true }, utcDailyCron(tick), tick, tick), false);
  assert.equal(spaceCronDue(refresh, utcDailyCron(tick), tick, tick + 6 * 60_000), false);
});

test("a failed external publication resumes from the Bot's pending commit", async (t) => {
  class PersistentMemory extends MemoryStorage { async close() {} }
  const db = new PersistentMemory();
  const native = nativeStore();
  const external = externalStore();
  const original = new BotDataPersistence(db, native, external);
  const session = createSession(original.storage);
  await original.start(session);
  const save = external.save;
  external.save = async () => { throw new Error("object store offline"); };
  await assert.rejects(session.commit(async (tx) => {
    const panel = await tx.doc(PanelDoc);
    panel.order.push(space.id);
    panel.widgets[space.id] = space;
  }, context));
  assert.equal((await session.closed).kind, "failed");
  assert.equal(native.state.get("bot-data:test"), "pending");
  assert.deepEqual((await external.readStartup()).panel.order, []);

  external.save = save;
  const replacement = new BotDataPersistence(db, native, external);
  const reopened = createSession(replacement.storage);
  t.after(() => reopened.close(context));
  await replacement.start(reopened);
  assert.equal(native.state.get("bot-data:test"), "ready");
  assert.deepEqual((await external.readStartup()).panel.order, [space.id]);
});

test("configured Spaces participate in direct Cron registration and release rules on pause", async (t) => {
  const session = createSession(new MemoryStorage());
  t.after(() => session.close(context));
  await session.commit(async (tx) => {
    (await tx.doc(SpaceRefreshIndex)).ids.push(space.id);
    (await tx.doc(SpaceRefreshDoc, space.id, null)).entry = refresh;
  }, context);
  const writes = [];
  const native = nativeStore();
  const registry = new CronTriggerRegistration({ key: "test", replace: async (crons) => { writes.push(crons); } }, {
    ...native, delete: async (key) => native.state.delete(key),
  });
  await registry.load();
  await registry.reconcile(session);
  await session.commit(async (tx) => {
    (await tx.doc(SpaceRefreshDoc, space.id, null)).entry.enabled = false;
  }, context);
  await registry.reconcile(session);
  assert.deepEqual(writes, [[utcDailyCron(tick)], []]);
});

test("Artifact metadata migrates once and concurrent Worker isolates preserve versions and request IDs", async () => {
  const objects = new Map();
  let etag = 0;
  const set = (key, value) => objects.set(key, { etag: String(++etag), value: structuredClone(value) });
  const bucket = {
    async readJson(key) { return structuredClone(objects.get(key)); },
    async writeJson(key, value, match) {
      if (objects.get(key)?.etag !== match) return false;
      set(key, value);
      return true;
    },
    async size(key) { return objects.get(key)?.value.byteLength; },
    async writeOnce(key, bytes) { if (!objects.has(key)) set(key, bytes); },
    async copyOnce(from, to) { if (!objects.has(to) && objects.has(from)) set(to, objects.get(from).value); },
    async remove(keys) { for (const key of keys) objects.delete(key); },
    async presign(method, key) { return { url: "https://object.test/" + key, method, expiresInSeconds: 900 }; },
  };
  const legacyVersion = { version: 7, key: "bots/main/plan/v7", size: 3, contentType: "text/plain", createdAt: 1 };
  const old = new ArtifactService("main", telemetry, bucket, async () => ({
    "head:plan": { next: 8, latest: 7, deletedAt: null, updatedAt: 1 }, "ver:plan:0000000007": legacyVersion,
  }));
  assert.equal((await old.downloadUrl("plan", 7)).url, "https://object.test/bots/main/plan/v7");
  const worker = () => new ArtifactService("main", telemetry, bucket, () => { assert.fail("unexpected legacy call"); });
  const writes = await Promise.all([worker().write("plan", "one", "text/plain", "same"), worker().write("plan", "one", "text/plain", "same"), worker().write("plan", "two", "text/plain")]);
  assert.equal(writes[0].ref, writes[1].ref);
  assert.notEqual(writes[0].ref, writes[2].ref);
  assert.deepEqual((await worker().stat("plan")).versions, [7, 8, 9]);
  const reserved = await worker().uploadUrl("plan:appendix", 3, "text/plain", "appendix");
  const staged = new URL(reserved.url).pathname.slice(1);
  set(staged, new TextEncoder().encode("old"));
  const committed = await worker().commit(reserved.uploadId);
  set(staged, new TextEncoder().encode("new"));
  assert.deepEqual(await worker().commit(reserved.uploadId), committed);
  assert.equal(new TextDecoder().decode(objects.get("bots/main/plan:appendix/v1").value), "old");
  await worker().delete("plan");
  assert.deepEqual((await worker().stat("plan:appendix")).versions, [1]);
  assert.equal((await worker().write("plan", "again", "text/plain")).version, 10);
});
