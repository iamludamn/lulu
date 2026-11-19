import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createSession, MemoryStorage } from '@earendil-works/pi-durable';
import { withoutSchedules } from '../dist/conversation/compat.js';
import { parseFrame } from '../dist/conversation/frame.js';
import { CronJobsDoc } from '../dist/cron/doc.js';
import { fireDue } from '../dist/cron/engine.js';
import { ScheduleOfferEntry } from '../dist/cron/overview.js';
import { ScheduleTool } from '../dist/cron/tool.js';
import { PanelDoc } from '../dist/panel/doc.js';
import { SCHEDULE_WIDGET_ID } from '../dist/protocol/panel.js';
import { keepWidget } from '../dist/send/keep.js';

const ctx = BACKGROUND_CONTEXT;
const widgetId = SCHEDULE_WIDGET_ID;
const once = at => ({ kind: 'once', at });
const daily = { kind: 'daily', time: '09:45', tz: 'Asia/Singapore' };
const create = (name, schedule = daily) => ({ action: 'create', name, prompt: 'private task prompt', ...schedule });
const origin = entry => 'schedules:' + entry.id;

async function fixture(t) {
  const session = createSession(new MemoryStorage());
  t.after(() => session.close(ctx));
  const { id } = await session.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), ctx);
  const entries = async () => (await session.commit(tx => tx.scanEntries({ conversationId: id, order: 'ascending' }, 100), ctx)).items;
  const state = () => session.snapshot(PanelDoc, ctx);
  const execute = (taskId, args, commit = session.commit.bind(session)) => ScheduleTool.execute(args, {
    taskId,
    conversationId: id,
    commit,
    snapshot: session.snapshot.bind(session),
  }, ctx);
  const keep = async (entry, requestId) => keepWidget(session, await entries(), origin(entry), true, requestId);
  const drop = entry => keepWidget(session, [], origin(entry), false);
  return { session, entries, state, execute, keep, drop };
}

test('create and aggregate card commit together, roll back together and replay exactly once', async t => {
  const f = await fixture(t);
  const input = { ...create('A'), kind: 'once', at: '2030-05-03T07:00:00+08:00' };
  let now = Date.parse('2030-05-02T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const blockedCommit = callback => f.session.commit(async tx => {
    await callback(tx);
    throw new Error('storage unavailable');
  }, ctx);
  await assert.rejects(f.execute(1, input, blockedCommit), /storage unavailable/);
  assert.equal((await f.entries()).length, 0);
  assert.equal(await f.session.snapshot(CronJobsDoc, ctx), undefined);
  assert.equal((await f.execute(1, input)).isError, undefined);
  assert.equal((await f.execute(2, create('B'))).isError, undefined);
  now = Date.parse('2030-05-04T00:00:00Z');
  assert.equal((await f.execute(1, input)).isError, undefined);
  assert.equal((await f.execute(3, input)).isError, true);
  const [a, b, ...extra] = await f.entries();
  assert.deepEqual(extra, []);
  assert.ok(ScheduleOfferEntry.is(a) && ScheduleOfferEntry.is(b));
  assert.equal(a.model, undefined);
  assert.equal(a.data.widget.panel.body.revision, 1);
  assert.equal(b.data.widget.panel.body.revision, 2);
  assert.deepEqual(a.data.widget.panel.body.rows.map(row => row.name), ['A']);
  assert.deepEqual(b.data.widget.panel.body.rows.map(row => row.name), ['B', 'A']);
  assert.equal(a.data.widget.panel.body.rows[0].schedule.at, Date.parse(input.at));
  assert.doesNotMatch(JSON.stringify(b), /private task prompt/);
  assert.deepEqual((await f.state()).order, []);
});

test('projection reads legacy jobs, preserves all lifecycle states and blocks deleted-create replays', async t => {
  const f = await fixture(t);
  const now = Date.parse('2030-05-02T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  await f.session.commit(async tx => {
    const jobs = await tx.doc(CronJobsDoc);
    const base = { prompt: 'legacy private prompt', state: 'active', lastRun: null };
    jobs.jobs.push(
      { ...base, id: 'legacy-paused', name: 'Paused', schedule: daily, nextRunAt: now },
      { ...base, id: 'legacy-done', name: 'Done', schedule: once(now), nextRunAt: now },
      { ...base, id: 'legacy-missed', name: 'Missed', schedule: once(now - 600_000), nextRunAt: now - 600_000 },
    );
  }, ctx);
  await f.execute(100, { action: 'pause', id: 'legacy-paused' });
  await f.session.commit(tx => fireDue(tx, now, async () => {}), ctx);
  const deleted = await f.execute(1, create('Deleted'));
  await f.execute(101, { action: 'delete', id: deleted.details.id });
  await f.execute(1, create('Deleted'));
  for (let i = 2; i <= 13; i++) await f.execute(i, create('Task ' + i));
  const offers = await f.entries();
  const { rows } = offers.at(-1).data.widget.panel.body;
  assert.equal(offers.length, 13);
  assert.equal(rows.length, 16);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  const byName = Object.fromEntries(rows.map(row => [row.name, row]));
  assert.equal(byName.Paused.state, 'paused');
  assert.equal(byName.Paused.nextRunAt, null);
  assert.equal(byName.Done.state, 'done');
  assert.equal(byName.Done.lastRunAt, now);
  assert.equal(byName.Missed.state, 'missed');
  assert.equal(byName.Missed.lastRunAt, undefined);
  assert.equal(byName.Deleted.state, 'deleted');
  assert.equal(byName.Deleted.nextRunAt, null);
  assert.deepEqual(byName['Task 13'].schedule, daily);
  assert.ok(byName['Task 13'].nextRunAt > now);
  assert.doesNotMatch(JSON.stringify(offers), /private prompt|private task prompt/);
  assert.doesNotMatch(JSON.stringify((await f.session.snapshot(CronJobsDoc, ctx)).deleted), /prompt/);
});

test('keep is atomic and replay-safe with a full panel, newer cards and removal', async t => {
  const f = await fixture(t);
  const order = Array.from({ length: 24 }, (_, i) => 'other-' + i);
  await f.session.commit(async tx => { (await tx.doc(PanelDoc)).order = order; }, ctx);
  await f.execute(1, create('A'));
  const [a] = await f.entries();
  await assert.rejects(f.keep(a, 'keep-a'), /视图已满/);
  assert.equal((await f.state()).scheduleReceipts, undefined);
  await f.session.commit(async tx => { (await tx.doc(PanelDoc)).order.pop(); }, ctx);
  await f.keep(a, 'keep-a');
  const added = await f.state();
  assert.deepEqual(added.order, [...order.slice(0, -1), widgetId]);
  assert.equal(added.scheduleReceipts[origin(a)].action, 'add');
  await f.execute(2, create('B'));
  await f.execute(3, create('C'));
  const [, b, c] = await f.entries();
  assert.deepEqual((await f.state()).widgets, added.widgets);
  await assert.rejects(f.keep(b, 'keep-b'), /已有新版/);
  await f.keep(c, 'keep-c');
  const updated = await f.state();
  assert.deepEqual(updated.order, added.order);
  assert.equal(updated.widgets[widgetId].body.rows.length, 3);
  assert.equal(updated.scheduleReceipts[origin(c)].action, 'update');
  await f.keep(a, 'keep-a');
  await f.keep(c, 'keep-c');
  assert.deepEqual(await f.state(), updated);
  await f.drop(a);
  assert.deepEqual(await f.state(), updated);
  await f.drop(c);
  await f.keep(c, 'keep-c');
  assert.equal((await f.state()).widgets[widgetId], undefined);
  await assert.rejects(f.keep(a, 'old-swipe'), /已有新版/);
  await f.keep(c, 're-add-c');
  assert.equal((await f.state()).scheduleReceipts[origin(c)].action, 'add');
  assert.equal((await f.session.snapshot(CronJobsDoc, ctx)).jobs.length, 3);
});

test('old clients receive stable entry IDs and other widgets in both live state and history', async t => {
  const f = await fixture(t);
  await f.execute(1, create('A'));
  const [a] = await f.entries();
  await f.keep(a, 'keep-a');
  const state = await f.state();
  const view = { entries: [a], order: [String(a.id)], before: null, docs: {} };
  const note = { id: 'note', size: 's', title: 'Note', body: { kind: 'note', markdown: 'hello' } };
  const panel = { ...state, order: [...state.order, note.id], widgets: { ...state.widgets, note } };
  const legacy = withoutSchedules({ type: 'state', view, panel, progress: {}, mcp: [], assets: [] });
  assert.deepEqual(legacy.view.order, view.order);
  assert.deepEqual(legacy.panel, { order: ['note'], widgets: { note } });
  assert.equal(legacy.view.entries[0].id, a.id);
  assert.equal(legacy.view.entries[0].data, undefined);
  assert.ok(a.data.widget);
  assert.deepEqual(withoutSchedules({ type: 'history', entries: [a], before: 2 }).entries, legacy.view.entries);
  assert.equal(parseFrame('{"type":"hello","incremental":true}').schedules, false);
  assert.equal(parseFrame('{"type":"hello","schedules":true}').schedules, true);
});
