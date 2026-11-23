import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, MemoryStorage } from "@earendil-works/pi-durable";
import { ArtifactService } from "../dist/artifact/service.js";
import { CronJobsDoc, utcDailyCron } from "../dist/cron/schedule.js";
import { CronTriggerRegistration } from "../dist/cron/registration.js";
import { STORED_DOC_KINDS as kinds } from "../dist/durable-names.js";
import { AssetsDoc, keepWidget, PanelDoc } from "../dist/panel.js";
import { BotDataPersistence, startupData } from "../dist/conversation/bot-data.js";
import { handleApi } from "../dist/server/api.js";
import { D1ArtifactMetadata } from "../../apps/cf/src/artifact-metadata.ts";
import { D1BotMetadata } from "../../apps/cf/src/bot-metadata.ts";
import { SpaceRefreshDoc, SpaceRefreshIndex } from "../dist/space/doc.js";
import { refreshDueSpaces, spaceCronDue } from "../dist/space/refresh.js";

const telemetry = { startSpan: (_options, run) => run({ setAttributes() {}, setStatus() {} }) };
const space = { id: "demo-space", size: "l", title: "My Space", body: { kind: "space", src: "artifact://spaces/demo-space/index.html@3", preview: "artifact://spaces/demo-space/cover.html@2" } };
const tick = Date.parse("2026-07-10T01:00:00Z");
const refresh = {
  generation: "space", mode: { kind: "scheduled", time: "09:00", tz: "Asia/Singapore" }, enabled: true,
  archived: false, notify: false, nextAt: tick, retryAt: null, monitor: null, providerState: null,
  startedAt: 1, checkedAt: null, updatedAt: 2, error: null, version: 4, seen: 0, delivered: 0,
  findings: [], value: '{"fresh":true}', runs: [], changes: [], cost: 0,
};

test("structured monitor preserves valid data and dispatches one repair per incompatible period", async (t) => {
  const session = createSession(new MemoryStorage());
  t.after(() => session.close(context));
  const env = {
    CONTEXT_DEV_API_KEY: "test", LULU_SPACE_WEBHOOK_SECRET: "0123456789abcdef0123456789abcdef",
    LULU_SPACE_WEBHOOK_ORIGIN: "https://hooks.example.com", LULU_SPACE_PRIVATE_ORIGIN: "https://private.example.com",
  };
  const schema = { type: "object", properties: { videos: {
    type: "array", items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } }, required: ["title", "url"] },
  } }, required: ["videos"] };
  const good = { videos: [{ title: "First video", url: "https://example.com/video" }] };
  let sample = good;
  let capturedAt = tick;
  const repairs = [];
  const repair = async (_tx, id, failure) => repairs.push({ id, ...failure });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.target, { type: "extract", url: "https://example.com/videos", schema, instructions: "Find new videos", max_pages: 1, max_depth: 0 });
      return Response.json({ id: "mon_probe", status: "active", webhook: { secret: "signing-secret" } });
    }
    if (url.includes("?tags=")) return Response.json({ data: [] });
    assert.equal(url, "https://api.context.dev/v1/monitors/mon_probe");
    return Response.json({ id: "mon_probe", status: "active", baseline: { captured_at: new Date(capturedAt).toISOString(), data: sample } });
  });
  const offered = { ...space, body: { ...space.body, monitor: { url: "https://example.com/videos", goal: "Find new videos", schema } } };
  const entries = [
    { id: 1, kind: "pi.assistant", model: [{ content: [{
      type: "toolCall", name: "send_to_user", id: "offer", arguments: { type: "widget", widget: { kind: "panel", panel: offered } },
    }] }] },
    { id: 2, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "offer" }] },
  ];
  await keepWidget(session, entries, "offer", true, "keep", env);
  const kept = await session.snapshot(SpaceRefreshDoc, space.id, context);
  await keepWidget(session, entries, "offer", true, "keep", env);
  assert.deepEqual(await session.snapshot(SpaceRefreshDoc, space.id, context), kept);
  const update = () => refreshDueSpaces(session, env, Date.now() + 1000, undefined, undefined, repair);
  const read = async () => (await session.snapshot(SpaceRefreshDoc, space.id, context)).entry;
  const check = async (value) => {
    sample = value;
    capturedAt += 1000;
    await session.commit(async (tx) => { (await tx.doc(SpaceRefreshDoc, space.id, null)).entry.retryAt = Date.now(); }, context);
    await update();
  };
  await update();
  await update();
  assert.deepEqual(JSON.parse((await read()).value), good);
  await check({ videos: [{ watch_url: "https://example.com/another" }] });
  assert.deepEqual(JSON.parse((await read()).value), good);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].id, space.id);
  await check({ videos: [{ watch_url: "https://example.com/third" }] });
  assert.equal(repairs.length, 1);
  await check({ videos: [...good.videos, { title: "Second video", url: "https://example.com/second" }] });
  assert.equal((await read()).error, null);
  assert.equal((await read()).version, 1);
  await check({ videos: [{ watch_url: "https://example.com/another" }] });
  assert.equal(repairs.length, 2);
});

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

test("a pending legacy publication is carried forward to D1 without restoring stale bucket data", async (t) => {
  const storage = new MemoryStorage();
  const native = nativeStore();
  await native.put({ "bot-data:legacy": "pending" });
  const external = externalStore();
  external.legacyKey = "legacy";
  await external.save({ documents: { [kinds.panel]: { order: [], widgets: {} } } });
  const legacy = createSession(storage);
  t.after(() => legacy.close(context));
  await legacy.commit(async (tx) => {
    const panel = await tx.doc(PanelDoc);
    panel.order.push(space.id);
    panel.widgets[space.id] = space;
  }, context);
  const persistence = new BotDataPersistence(storage, native, external);
  await persistence.start(legacy);
  assert.deepEqual((await external.readStartup()).panel.order, [space.id]);
  assert.equal(native.state.get("bot-data:test"), "ready");
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

function d1Database(t, migration) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL("../../apps/cf/migrations/" + migration, import.meta.url), "utf8"));
  return {
    prepare(query) {
      const statement = sqlite.prepare(query);
      return {
        bind(...values) {
          const bindings = query.includes("?1")
            ? [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))]
            : values;
          const read = () => ({ results: statement.all(...bindings).map((row) => ({ ...row })) });
          return {
            all: read, run: read,
            first(column) {
              const row = read().results[0];
              return (column === undefined ? row : row?.[column]) ?? null;
            },
          };
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const result = statements.map((statement) => statement.all());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

test("D1 imports Bot documents once, indexes due work, and preserves untouched data on update", async (t) => {
  const db = d1Database(t, "0002_bot_metadata.sql");
  const store = () => new D1BotMetadata(db, "main", kinds);
  const current = { id: "current", name: "Wake", prompt: "Reminder", schedule: { kind: "once", at: tick }, state: "active", nextRunAt: tick, lastRun: null };
  const future = { ...current, id: "future", nextRunAt: tick + 60_000 };
  const paused = { ...current, id: "paused", state: "paused" };
  const refreshKey = kinds.spaceRefresh + ":" + space.id;
  const quietKey = kinds.spaceRefresh + ":quiet";
  const documents = {
    [kinds.panel]: { order: [space.id], widgets: { [space.id]: space } },
    [kinds.assets]: { items: [{ ref: "artifact://report.md@4", title: "Report", origin: "saved", savedAt: 1 }] },
    [kinds.spaceRefreshIndex]: { ids: [space.id, "quiet"] },
    [refreshKey]: { entry: refresh },
    [quietKey]: { entry: { ...refresh, immediatePull: true } },
    [kinds.cronJobs]: { jobs: [paused, current, future], deleted: [{ id: "deleted" }] },
  };
  assert.equal(await store().read(), undefined);
  await store().write({ documents }, undefined, true);
  await store().write({ documents: {} }, undefined, true);
  assert.deepEqual(await store().read(), { documents });
  const single = await store().read({ space: space.id });
  assert.deepEqual(single.documents, { [kinds.panel]: documents[kinds.panel], [refreshKey]: documents[refreshKey] });
  const due = await store().read({ cronAt: tick });
  assert.deepEqual(due.documents[kinds.cronJobs].jobs, [current]);
  assert.deepEqual(due.documents[refreshKey], documents[refreshKey]);
  assert.equal(due.documents[quietKey], undefined);
  assert.equal(due.documents[kinds.assets], undefined);

  const partial = { [kinds.cronJobs]: { jobs: [future], deleted: [] } };
  await store().write({ documents: partial }, [kinds.cronJobs, refreshKey]);
  const updated = (await store().read()).documents;
  assert.deepEqual(updated[kinds.cronJobs], partial[kinds.cronJobs]);
  assert.deepEqual(updated[kinds.panel], documents[kinds.panel]);
  assert.equal(updated[refreshKey], undefined);
  assert.deepEqual((await store().read({ cronAt: tick })).documents[kinds.cronJobs], undefined);
  assert.equal(await new D1BotMetadata(db, "fresh", kinds).read(), undefined);
});

test("Artifact metadata migrates to SQL and concurrent Workers preserve versions and request IDs", async (t) => {
  const db = d1Database(t, "0001_artifact_metadata.sql");
  const objects = new Map();
  const set = (key, value) => objects.set(key, structuredClone(value));
  const bucket = {
    async size(key) { return objects.get(key)?.byteLength; },
    async writeOnce(key, bytes) { if (!objects.has(key)) set(key, bytes); },
    async copyOnce(from, to) { if (!objects.has(to) && objects.has(from)) set(to, objects.get(from)); },
    async remove(keys) { for (const key of keys) objects.delete(key); },
    async presign(method, key) { return { url: "https://object.test/" + key, method, expiresInSeconds: 900 }; },
  };
  const legacyVersion = { version: 7, key: "bots/main/plan/v7", size: 3, contentType: "text/plain", createdAt: 1 };
  const legacy = async () => ({
    "head:plan": { next: 8, latest: 7, deletedAt: null, updatedAt: 1 }, "ver:plan:0000000007": legacyVersion,
    "upload:original": { ...legacyVersion, name: "plan", uploadId: "original", committed: true },
    "req:original-request": "original",
  });
  const old = () => new ArtifactService(telemetry, bucket, new D1ArtifactMetadata(db, "main", legacy));
  const firstReads = await Promise.all([old().downloadUrl("plan", 7), old().downloadUrl("plan", 7)]);
  assert.ok(firstReads.every((result) => result.url === "https://object.test/bots/main/plan/v7"));
  const worker = () => new ArtifactService(telemetry, bucket, new D1ArtifactMetadata(db, "main", () => { assert.fail("unexpected legacy call"); }));
  assert.equal((await worker().write("plan", "ignored", "text/plain", "original-request")).version, 7);
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
  assert.equal(new TextDecoder().decode(objects.get("bots/main/plan:appendix/v1")), "old");
  assert.equal(objects.has(staged), false);
  await worker().write("plan[x]a", "literal", "text/plain");
  assert.deepEqual((await worker().list("plan[x]", 10)).map(({ name }) => name), ["plan[x]a"]);

  const late = await worker().uploadUrl("plan", 4, "text/plain", "late");
  set(new URL(late.url).pathname.slice(1), new TextEncoder().encode("late"));
  const copyStarted = Promise.withResolvers();
  const finishCopy = Promise.withResolvers();
  bucket.copyOnce = async (from, to) => {
    const bytes = objects.get(from);
    copyStarted.resolve();
    await finishCopy.promise;
    set(to, bytes);
  };
  const committing = assert.rejects(worker().commit(late.uploadId), /artifact changed/);
  await copyStarted.promise;
  await worker().delete("plan");
  finishCopy.resolve();
  await committing;
  assert.equal(objects.has("bots/main/plan/v10"), false);
  assert.deepEqual((await worker().stat("plan:appendix")).versions, [1]);
  assert.equal((await worker().write("plan", "again", "text/plain")).version, 11);
  for (let count = 0; count < 10; count++) await worker().write("plan", "again", "text/plain");
  assert.deepEqual((await worker().stat("plan")).versions, [12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  assert.equal(objects.has("bots/main/plan/v11"), false);
});

test("Artifact SQL keeps quota and edit conflict checks in transactions", async (t) => {
  const db = d1Database(t, "0001_artifact_metadata.sql");
  const store = () => new D1ArtifactMetadata(db, "main", async () => ({}));
  const reserve = (size, fields = {}) => store().reserve({ name: "file", size, quota: 6, contentType: "text/plain", staged: false, ...fields });
  const first = await reserve(2);
  await assert.rejects(() => reserve(5), /quota exceeded/);
  await store().commit(first, 3, 6);
  const [edit1, edit2] = await Promise.all([reserve(1, { baseVersion: 1 }), reserve(1, { baseVersion: 1 })]);
  await assert.rejects(() => store().commit(edit1, 3, 6), /quota exceeded/);
  assert.equal((await store().commit(edit1, 2, 6)).version, 2);
  assert.equal(await store().commit(edit2, 1, 6), undefined);
  await assert.rejects(() => reserve(1, { baseVersion: 1 }), /changed during edit/);
  assert.equal((await reserve(1)).version, 4);
});

test("Artifact SQL retries a failed import without publishing an incomplete index", async (t) => {
  const db = d1Database(t, "0001_artifact_metadata.sql");
  const version = { version: 5, key: "other/legacy-path", size: 3, contentType: "text/plain", createdAt: 1 };
  const oldVersion = { "ver:test:0000000005": version };
  await assert.rejects(() => new D1ArtifactMetadata(db, "main", async () => oldVersion).version("test", 5), /FOREIGN KEY/);
  const reopened = new D1ArtifactMetadata(db, "main", async () => ({
    ...oldVersion, "head:test": { next: 6, latest: 5, deletedAt: null },
  }));
  assert.equal((await reopened.version("test", 5)).key, version.key);
  const other = new D1ArtifactMetadata(db, "other", async () => ({}));
  assert.equal(await other.version("test", 5), undefined);
});
