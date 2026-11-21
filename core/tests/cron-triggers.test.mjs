import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, MemoryStorage } from "@earendil-works/pi-durable";
import { CronJobsDoc } from "../dist/cron/doc.js";
import { cronDueAt, fireDue, nextAlarm } from "../dist/cron/engine.js";
import { CronTriggerRegistration } from "../dist/cron/registration.js";
import { dailyUtcCrons, GRACE_MS, onceCronTime, utcDailyCron, utcOnceCron } from "../dist/cron/schedule.js";

const context = BACKGROUND_CONTEXT;
const minute = 60_000;
const day = 24 * 60 * minute;
const once = (at) => ({ kind: "once", at });
const daily = { kind: "daily", time: "09:30", tz: "America/New_York" };
const job = (id, schedule, nextRunAt, state = "active") => ({ id, name: id, schedule, nextRunAt, state, prompt: id, lastRun: null });

async function fixture(t, jobs) {
  const session = createSession(new MemoryStorage());
  t.after(() => session.close(context));
  await session.commit(async (tx) => { (await tx.doc(CronJobsDoc)).jobs = jobs; }, context);
  return session;
}

test("normalizes daily schedules across DST, including fractional-hour offsets", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.deepEqual(dailyUtcCrons(daily.time, daily.tz, now).sort(), ["30 13 * * *", "30 14 * * *"]);
  assert.deepEqual(dailyUtcCrons("08:00", "Australia/Lord_Howe", now).sort(), ["0 21 * * *", "30 21 * * *"]);
});

test("Cron dispatch selects the current occurrence and admits it once across concurrent invocations", async (t) => {
  const tick = Date.parse("2026-07-10T13:30:00Z");
  const session = await fixture(t, [
    job("daily", daily, tick - day),
    job("paused", daily, tick - day, "paused"),
    job("once", once(tick), tick),
  ]);
  const started = [];
  const start = async (_tx, candidate, _id, at) => { started.push([candidate.id, at]); };
  const wrongSeason = tick - 60 * minute;
  assert.deepEqual(await fireDue(session, wrongSeason, start, cronDueAt(utcDailyCron(wrongSeason), wrongSeason)), []);
  assert.deepEqual(await fireDue(session, tick + GRACE_MS + 1, start, cronDueAt(utcDailyCron(tick), tick)), []);
  await Promise.all([
    fireDue(session, tick, start, cronDueAt(utcDailyCron(tick), tick)),
    fireDue(session, tick, start, cronDueAt(utcDailyCron(tick), tick)),
  ]);
  assert.deepEqual(started, [["daily", tick]]);
  assert.equal((await session.snapshot(CronJobsDoc, context)).jobs[0].nextRunAt, tick + day);
});

test("one-shot Cron rounds up, drops expired calls, and guards against next year's recurrence", async (t) => {
  const at = Date.parse("2026-07-10T13:30:30Z");
  const tick = onceCronTime(at);
  const lateAt = at - day;
  const lateTick = onceCronTime(lateAt);
  const session = await fixture(t, [job("once", once(at), at), job("late", once(lateAt), lateAt)]);
  const started = [];
  const start = async (_tx, candidate, _id, scheduledFor) => { started.push([candidate.id, scheduledFor]); };
  assert.equal(tick, at + 30_000);
  assert.equal(nextAlarm((await session.snapshot(CronJobsDoc, context)).jobs.slice(0, 1), () => false), at + GRACE_MS + 1);
  const nextYear = Date.parse("2027-07-10T13:31:00Z");
  assert.deepEqual(await fireDue(session, nextYear, start, cronDueAt(utcOnceCron(nextYear), nextYear)), []);
  assert.deepEqual(await fireDue(session, tick - 1, start, cronDueAt(utcOnceCron(tick), tick)), []);
  await fireDue(session, lateAt + GRACE_MS + 1, start, cronDueAt(utcOnceCron(lateTick), lateTick));
  await fireDue(session, tick, start, cronDueAt(utcOnceCron(tick), tick));
  await fireDue(session, tick, start, cronDueAt(utcOnceCron(tick), tick));
  assert.deepEqual(started, [["once", at]]);
  assert.deepEqual((await session.snapshot(CronJobsDoc, context)).jobs.map(({ state }) => state), ["done", "missed"]);
});

test("registration shares rules, falls back during propagation, and removes used one-shot rules", async (t) => {
  let now = Date.parse("2026-07-10T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  const at = now + 50 * minute;
  const shortAt = now + 2 * minute;
  const recurring = job("daily", daily, now + 90 * minute);
  const long = job("once", once(at), at);
  const shared = job("shared", once(at - 5_000), at - 5_000);
  const short = job("short", once(shortAt), shortAt);
  const session = await fixture(t, [recurring, long, shared, short]);
  const writes = [];
  const data = new Map();
  const storage = {
    get: async (key) => data.get(key),
    put: async (entries) => { for (const [key, value] of Object.entries(entries)) data.set(key, value); },
    delete: async (key) => data.delete(key),
  };
  const target = { key: "test", replace: async (rules) => { writes.push(rules); } };
  let registry = new CronTriggerRegistration(target, storage);
  await registry.load();
  await registry.reconcile(session);
  assert.deepEqual(writes, [["30 13 * * *", "30 14 * * *", "50 12 10 7 *"]]);
  assert.equal(registry.isLocal(long, now), true);
  assert.equal(registry.nextWake(now), now + 15 * minute);
  now += 15 * minute;
  registry = new CronTriggerRegistration(target, storage);
  await registry.load();
  await registry.reconcile(session);
  assert.equal(writes.length, 1);
  assert.equal(registry.isLocal(long, now), false);
  assert.equal(registry.isLocal(recurring, now), false);
  assert.equal(registry.isLocal(short, now), true);
  assert.equal(registry.nextWake(now), Infinity);
  now = at;
  await fireDue(session, now, async () => {}, cronDueAt(utcOnceCron(at), at));
  await registry.reconcile(session);
  assert.deepEqual(writes.at(-1), ["30 13 * * *", "30 14 * * *"]);
});

test("registration failure leaves the local alarm active and retries the current rule set", async (t) => {
  let now = Date.parse("2026-07-10T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  const recurring = job("daily", daily, now + 90 * minute);
  const session = await fixture(t, [recurring]);
  let attempts = 0;
  const registry = new CronTriggerRegistration({
    key: "test", replace: async () => { if (++attempts === 1) throw new Error("unavailable"); },
  }, { get: async () => undefined, put: async () => {}, delete: async () => 0 });
  await registry.load();
  await assert.rejects(registry.reconcile(session), /unavailable/);
  assert.equal(registry.isLocal(recurring, now), true);
  assert.equal(registry.nextWake(now), now + 5 * minute);
  await registry.reconcile(session);
  assert.equal(attempts, 1);
  now += 5 * minute;
  await registry.reconcile(session);
  assert.equal(attempts, 2);
  assert.equal(registry.isLocal(recurring, now + 15 * minute), false);
});
