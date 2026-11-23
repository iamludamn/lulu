import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { AssistantEntry, createRegistry, createSession, defineExtension, Harness, MemoryStorage, ToolResultEntry } from '@earendil-works/pi-durable';
import { withoutSchedules } from '../dist/conversation/frame.js';
import { parseFrame } from '../dist/conversation/frame.js';
import { fireSchedules, nextScheduleAlarm, scheduleEntries } from '../dist/cron/alarm.js';
import { CronJobsDoc } from '../dist/cron/schedule.js';
import { fireDue } from '../dist/cron/alarm.js';
import { withScheduleOverview } from '../dist/cron/schedule.js';
import { ScheduleTool } from '../dist/cron/tool.js';
import { DelegateIndex } from '../dist/delegate/runs.js';
import { PanelDoc } from '../dist/panel.js';
import { checkItem } from '../dist/panel.js';
import { SCHEDULE_WIDGET_ID } from '../dist/protocol/panel.js';
import { SEND_TOOL } from '../dist/protocol/send.js';
import { keepWidget } from '../dist/panel.js';
import { makeOutcome, startMake } from '../dist/send/make.js';
import { deliveredSentIn, LegacyScheduleOfferEntry } from '../dist/conversation/transcript.js';
import { createSendTool } from '../dist/send/tool.js';

const ctx = BACKGROUND_CONTEXT;
const widgetId = SCHEDULE_WIDGET_ID;
const once = at => ({ kind: 'once', at });
const daily = { kind: 'daily', time: '09:45', tz: 'Asia/Singapore' };
const create = (name, schedule = daily) => ({ action: 'create', name, prompt: 'private task prompt', ...schedule });
const overview = { type: 'widget', widget: { kind: 'panel', panel: { body: { kind: 'schedules' } } }, end_turn: true };
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
  const send = async (callId, recorded = overview) => {
    const result = await sendTool.execute(overview, { conversationId: id, snapshot: session.snapshot.bind(session) }, ctx);
    await session.commit(async tx => {
      await tx.appendEntry(AssistantEntry, id, { model: [{ role: 'assistant', content: [toolCall(SEND_TOOL, callId, recorded)] }] });
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
  await f.send('legacy-schedules-card', { ...overview, widget: { kind: 'schedule_overview' } });
  assert.deepEqual(deliveredSentIn(await f.entries()).at(-1).input.widget, sent.input.widget);
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
  await fireDue(f.session, now, async () => {});
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
  await fireDue(f.session, scheduledFor, async () => {});
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

async function chatFixture(t, steps) {
  const model = { id: 'mock', provider: 'mock', api: 'openai-completions', name: 'mock', contextWindow: 100_000, maxTokens: 4_000, input: ['text'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const models = Object.assign(createModels(), {
    getModel: () => model,
    streamSimple: (_model, context) => {
      const step = steps.shift() ?? assert.fail('unexpected model call');
      const content = typeof step === 'function' ? step(context) : step;
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
  const selected = { provider: model.provider, modelId: model.id };
  const root = await harness.root(ctx, { agent: { model: selected } });
  await root.configure({ tools: null }, ctx);
  return { harness, root, selected };
}

test('Pi delivers the Schedule Overview as a regular send_to_user result', async t => {
  const { harness, root } = await chatFixture(t, [
    [toolCall('schedule', 'create', create('Daily'))],
    [toolCall(SEND_TOOL, 'text', { type: 'text', content: 'Scheduled.' })],
    [toolCall(SEND_TOOL, 'overview', overview)],
  ]);
  await (await root.submit({ type: 'input', content: 'Schedule a daily update.' }, ctx)).wait(ctx);
  const { items } = await root.entries({ order: 'ascending' }, 100, undefined, ctx);
  assert.ok(items.every(entry => !LegacyScheduleOfferEntry.is(entry)));
  const sends = deliveredSentIn(items);
  assert.deepEqual(sends.map(sent => sent.id), ['text', 'overview']);
  assert.equal(sends[1].input.widget.panel.body.rows[0].name, 'Daily');
  await keepWidget(harness, items, 'overview', true, 'keep');
  assert.equal((await harness.snapshot(PanelDoc, ctx)).widgets[widgetId].origin, 'overview');
});

test('simultaneous Alarms wake the main conversation once per occurrence and deliver through send_to_user', async t => {
  const scheduledFor = Math.floor(Date.now() / 60_000) * 60_000 + 120_000;
  const at = new Date(scheduledFor).toISOString();
  const reminder = (callId, content) => context => {
    const user = context.messages.filter(message => message.role === 'user').at(-1);
    assert.match(JSON.stringify(user.content), /Scheduled Alarm.*send_to_user/);
    assert.ok(JSON.stringify(user.content).includes(content));
    return [toolCall(SEND_TOOL, callId, { type: 'text', content, end_turn: true })];
  };
  const { harness, root, selected } = await chatFixture(t, [
    [toolCall('schedule', 'once', { ...create('Pick up parcel', once(at)), mode: 'reminder', prompt: 'Pick up your parcel' })],
    [toolCall('schedule', 'daily', { ...create('Take a break'), time: at.slice(11, 16), tz: 'UTC', mode: 'reminder', prompt: 'Take a break' })],
    [toolCall(SEND_TOOL, 'confirmation', { type: 'text', content: 'Alarms set.' })],
    [toolCall(SEND_TOOL, 'overview', overview)],
    reminder('once-reminder', 'Pick up your parcel'),
    reminder('daily-reminder', 'Take a break'),
  ]);
  const initial = await root.submit({ type: 'input', content: 'Set a one-time and a daily reminder.' }, ctx);
  assert.equal((await initial.wait(ctx)).status, 'done');
  const entries = async () => (await root.entries({ order: 'ascending' }, 100, undefined, ctx)).items;
  await keepWidget(harness, await entries(), 'overview', true, 'keep');
  assert.equal(await nextScheduleAlarm(harness, 0), scheduledFor);
  assert.deepEqual(await fireSchedules(harness, root, selected, scheduledFor - 1), { fired: [], expired: [] });
  assert.equal((await fireSchedules(harness, root, selected, scheduledFor)).fired.length, 2);
  assert.deepEqual(await fireSchedules(harness, root, selected, scheduledFor), { fired: [], expired: [] });
  const { jobs } = await harness.snapshot(CronJobsDoc, ctx);
  for (const job of jobs) {
    assert.equal((await (await harness.submission(job.lastRun.submissionId, ctx)).wait(ctx)).status, 'done');
  }
  assert.deepEqual((await scheduleEntries(harness)).map(row => row.lastRun), [
    { scheduledFor, status: 'done' }, { scheduledFor, status: 'done' },
  ]);
  const panel = await withScheduleOverview(harness, await harness.snapshot(PanelDoc, ctx), ctx);
  const [dailyRow, onceRow] = panel.widgets[widgetId].body.rows;
  assert.equal(dailyRow.mode, 'reminder');
  assert.equal(onceRow.mode, 'reminder');
  assert.equal(onceRow.state, 'done');
  assert.equal(dailyRow.nextRunAt, scheduledFor + 86_400_000);
  assert.equal(await nextScheduleAlarm(harness, scheduledFor), dailyRow.nextRunAt);
  assert.deepEqual((await harness.snapshot(DelegateIndex, ctx))?.ids ?? [], []);
  const transcript = await entries();
  assert.deepEqual(transcript.filter(entry => entry.kind === 'lulu.input').map(entry => entry.data),
    jobs.map(job => ({ kind: 'schedule_message', scheduleId: job.id, scheduledFor })));
  assert.deepEqual(deliveredSentIn(transcript).slice(2).map(send => send.input.content), ['Pick up your parcel', 'Take a break']);
});

test('message-to-widget creates a Checklist that can be kept and checked, or explains when no items apply', async t => {
  const text = content => ({ type: 'text', content, end_turn: true });
  const checklist = { type: 'widget', widget: { kind: 'panel', panel: {
    id: 'trip-checklist', title: 'Trip', size: 'm', body: { kind: 'list', items: [{ title: 'Pack your passport', done: false }] },
  } }, end_turn: true };
  const { harness, root } = await chatFixture(t, [
    [toolCall(SEND_TOOL, 'packing-reply', text('Pack your passport.'))],
    context => {
      const input = JSON.stringify(context.messages.at(-1).content);
      assert.match(input, /make a Checklist/);
      assert.match(input, /Pack your passport/);
      return [toolCall(SEND_TOOL, 'checklist', checklist)];
    },
    [toolCall(SEND_TOOL, 'no-tasks-reply', text('The sky is blue.'))],
    [toolCall(SEND_TOOL, 'no-checklist', text('This reply has no tasks to check off.'))],
  ]);
  const submit = async content => (await root.submit({ type: 'input', content }, ctx)).wait(ctx);
  const entries = async () => (await root.entries({ order: 'ascending' }, 100, undefined, ctx)).items;
  const make = async origin => {
    const request = await startMake(harness, root, await entries(), { origin, requestId: origin + '-make' });
    assert.equal((await (await harness.submission(request.id, ctx)).wait(ctx)).status, 'done');
    assert.deepEqual(await makeOutcome(harness, request, await entries(), ctx), { state: 'done' });
  };

  await submit('What should I pack?');
  await make('packing-reply');
  await keepWidget(harness, await entries(), 'checklist', true, 'keep');
  await checkItem(harness, 'trip-checklist', 0, true);
  assert.equal((await harness.snapshot(PanelDoc, ctx)).widgets['trip-checklist'].body.items[0].done, true);
  await submit('What color is the sky?');
  await make('no-tasks-reply');
  assert.equal(deliveredSentIn(await entries()).at(-1).input.type, 'text');
});
