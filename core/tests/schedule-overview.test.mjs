import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { AssistantEntry, createRegistry, createSession, defineExtension, Harness, MemoryStorage, ToolResultEntry } from '@earendil-works/pi-durable';
import { withoutSchedules } from '../dist/conversation/compat.js';
import { parseFrame } from '../dist/conversation/frame.js';
import { CronJobsDoc } from '../dist/cron/doc.js';
import { fireDue } from '../dist/cron/engine.js';
import { withScheduleOverview } from '../dist/cron/overview.js';
import { ScheduleTool } from '../dist/cron/tool.js';
import { PanelDoc } from '../dist/panel/doc.js';
import { SCHEDULE_WIDGET_ID } from '../dist/protocol/panel.js';
import { SEND_TOOL } from '../dist/protocol/send.js';
import { keepWidget } from '../dist/send/keep.js';
import { deliveredSentIn, LegacyScheduleOfferEntry } from '../dist/send/sent.js';
import { createSendTool } from '../dist/send/tool.js';

const ctx = BACKGROUND_CONTEXT;
const widgetId = SCHEDULE_WIDGET_ID;
const once = at => ({ kind: 'once', at });
const daily = { kind: 'daily', time: '09:45', tz: 'Asia/Singapore' };
const create = (name, schedule = daily) => ({ action: 'create', name, prompt: 'private task prompt', ...schedule });
const overview = { type: 'widget', widget: { kind: 'schedule_overview' }, end_turn: true };
const toolCall = (name, id, args) => ({ type: 'toolCall', name, id, arguments: args });

async function fixture(t) {
  const session = createSession(new MemoryStorage());
  t.after(() => session.close(ctx));
  const { id } = await session.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), ctx);
  const entries = async () => (await session.commit(tx => tx.scanEntries({ conversationId: id, order: 'ascending' }, 100), ctx)).items;
  const state = () => session.snapshot(PanelDoc, ctx);
  const projected = async () => withScheduleOverview(session, await state(), ctx);
  const sendTool = createSendTool(undefined);
  const execute = (taskId, args, commit = session.commit.bind(session)) => ScheduleTool.execute(args, {
    taskId,
    conversationId: id,
    commit,
    snapshot: session.snapshot.bind(session),
  }, ctx);
  const send = async (callId) => {
    const result = await sendTool.execute(overview, { conversationId: id, snapshot: session.snapshot.bind(session) }, ctx);
    await session.commit(async tx => {
      await tx.appendEntry(AssistantEntry, id, { model: [{ role: 'assistant', content: [toolCall(SEND_TOOL, callId, overview)] }] });
      await tx.appendEntry(ToolResultEntry, id, { model: [{ role: 'toolResult', toolName: SEND_TOOL, toolCallId: callId, details: result.details, isError: result.isError ?? false }] });
    }, ctx);
    return result;
  };
  const legacyOffer = revision => session.commit(async tx => {
    const panel = await tx.doc(PanelDoc);
    panel.scheduleRevision = revision;
    return tx.appendEntry(LegacyScheduleOfferEntry, id, { data: { at: Date.now(), widget: {
      kind: 'panel', panel: { id: widgetId, size: 'm', title: 'Schedules', body: { kind: 'schedules', revision, rows: [] } },
    } } });
  }, ctx);
  const keep = async (origin, requestId) => keepWidget(session, await entries(), origin, true, requestId);
  const drop = origin => keepWidget(session, [], origin, false);
  return { session, entries, state, projected, execute, send, legacyOffer, keep, drop };
}

test('job creation rolls back and replays independently of message delivery', async t => {
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
  assert.deepEqual(await f.entries(), []);
  assert.equal((await f.state()), undefined);
  assert.deepEqual((await f.session.snapshot(CronJobsDoc, ctx)).jobs.map(job => job.name), ['A', 'B']);
  const result = await f.send('schedules-card');
  assert.equal(result.isError, undefined);
  const [sent] = deliveredSentIn(await f.entries());
  assert.equal(sent.id, 'schedules-card');
  assert.deepEqual(sent.input.widget.panel.body.rows.map(row => row.name), ['B', 'A']);
  assert.equal(sent.input.widget.panel.body.rows[1].schedule.at, Date.parse(input.at));
  assert.doesNotMatch(JSON.stringify(sent), /private task prompt/);
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
  await f.send('schedules-card');
  const sends = deliveredSentIn(await f.entries());
  const { rows } = sends[0].input.widget.panel.body;
  assert.equal(sends.length, 1);
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
  assert.doesNotMatch(JSON.stringify(sends), /private prompt|private task prompt/);
  assert.doesNotMatch(JSON.stringify((await f.session.snapshot(CronJobsDoc, ctx)).deleted), /prompt/);
});

test('keep uses a successful send and holds the overview once across replay and removal', async t => {
  const f = await fixture(t);
  const order = Array.from({ length: 24 }, (_, i) => 'other-' + i);
  await f.session.commit(async tx => { (await tx.doc(PanelDoc)).order = order; }, ctx);
  await f.execute(1, create('A'));
  await f.send('a');
  await assert.rejects(f.keep('a', 'keep-a'), /视图已满/);
  assert.equal((await f.state()).scheduleReceipts, undefined);
  await f.session.commit(async tx => { (await tx.doc(PanelDoc)).order.pop(); }, ctx);
  await f.send('b');
  await f.keep('b', 'keep-b');
  const added = await f.state();
  assert.deepEqual(added.order, [...order.slice(0, -1), widgetId]);
  assert.equal(added.scheduleReceipts.b.action, 'add');
  await f.keep('b', 'keep-b');
  assert.deepEqual(await f.state(), added);
  await assert.rejects(f.keep('a', 'keep-a'), /已在视图中/);
  assert.equal((await f.send('failed')).isError, true);
  await assert.rejects(f.keep('failed', 'keep-failed'), /不在对话里/);
  await f.drop('a');
  assert.deepEqual(await f.state(), added);
  await f.drop('b');
  await f.keep('b', 'keep-b');
  assert.equal((await f.state()).widgets[widgetId], undefined);
  await f.keep('b', 're-add-b');
  assert.equal((await f.state()).scheduleReceipts.b.action, 'add');
  assert.equal((await f.session.snapshot(CronJobsDoc, ctx)).jobs.length, 1);
});

test('an accepted overview projects current jobs while the chat card stays a snapshot', async t => {
  const f = await fixture(t);
  const now = Date.parse('2030-05-02T00:00:00Z');
  const scheduledFor = now + 60_000;
  t.mock.method(Date, 'now', () => now);
  const first = await f.execute(1, create('A', once(new Date(scheduledFor).toISOString())));
  const offer = await f.send('a');
  await f.keep('a', 'keep-a');
  assert.deepEqual((await f.state()).widgets[widgetId].body.rows, []);
  await f.session.commit(async tx => {
    (await tx.doc(PanelDoc)).widgets[widgetId].body.rows = offer.details.widget.panel.body.rows;
  }, ctx);
  const accepted = await f.state();
  const second = await f.execute(2, create('B'));
  const rows = async () => (await f.projected()).widgets[widgetId].body.rows;
  assert.deepEqual((await rows()).map(row => row.name), ['B', 'A']);
  await f.execute(3, { action: 'pause', id: first.details.id });
  assert.equal((await rows()).find(row => row.id === first.details.id).state, 'paused');
  await f.execute(4, { action: 'resume', id: first.details.id });
  assert.equal((await rows()).find(row => row.id === first.details.id).state, 'active');
  await f.session.commit(tx => fireDue(tx, scheduledFor, async () => {}), ctx);
  const fired = (await rows()).find(row => row.id === first.details.id);
  assert.equal(fired.state, 'done');
  assert.equal(fired.lastRunAt, scheduledFor);
  await f.execute(5, { action: 'delete', id: second.details.id });
  assert.deepEqual((await rows()).map(row => row.name), ['A']);
  assert.deepEqual(await f.state(), accepted);
  const sends = deliveredSentIn(await f.entries());
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].input.widget, offer.details.widget);
});

test('old clients receive stable entry IDs and other widgets in both live state and history', async t => {
  const f = await fixture(t);
  await f.execute(1, create('A'));
  const older = await f.legacyOffer(1);
  const a = await f.legacyOffer(2);
  await assert.rejects(f.keep('schedules:' + older.id, 'keep-old'), /已有新版/);
  await f.send('new');
  await f.keep('schedules:' + a.id, 'keep-a');
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
  const entries = await f.entries();
  const result = entries.at(-1);
  const redacted = withoutSchedules({ type: 'history', entries, before: null }).entries.at(-1);
  assert.equal(redacted.id, result.id);
  assert.equal(redacted.model[0].details.widget, undefined);
  assert.equal(redacted.model[0].details.end, true);
  assert.ok(result.model[0].details.widget);
  assert.equal(parseFrame('{"type":"hello","incremental":true}').schedules, false);
  assert.equal(parseFrame('{"type":"hello","schedules":true}').schedules, true);
});

test('Pi delivers the Schedule Overview as a regular send_to_user result', async t => {
  const steps = [
    [toolCall('schedule', 'create', create('Daily'))],
    [toolCall(SEND_TOOL, 'text', { type: 'text', content: 'Scheduled.' })],
    [toolCall(SEND_TOOL, 'overview', overview)],
  ];
  const model = { id: 'mock', provider: 'mock', api: 'openai-completions', name: 'mock', contextWindow: 100_000, maxTokens: 4_000, input: ['text'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const models = Object.assign(createModels(), {
    getModel: () => model,
    streamSimple: () => {
      const content = steps.shift() ?? assert.fail('the final card should end the turn');
      const message = {
        role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...model.cost, total: 0 } },
      };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'toolUse', message }; }, result: async () => message };
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'test-chat', tools: [ScheduleTool, createSendTool(undefined)] }));
  const harness = await Harness.open(new MemoryStorage(), { registry, models }, ctx);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
  await root.configure({ tools: null }, ctx);
  await (await root.submit({ type: 'input', content: 'Schedule a daily update.' }, ctx)).wait(ctx);
  const { items } = await root.entries({ order: 'ascending' }, 100, undefined, ctx);
  assert.ok(items.every(entry => !LegacyScheduleOfferEntry.is(entry)));
  const sends = deliveredSentIn(items);
  assert.deepEqual(sends.map(sent => sent.id), ['text', 'overview']);
  assert.equal(sends[1].input.widget.panel.body.rows[0].name, 'Daily');
  await keepWidget(harness, items, 'overview', true, 'keep');
  assert.equal((await harness.snapshot(PanelDoc, ctx)).widgets[widgetId].origin, 'overview');
});
