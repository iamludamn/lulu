import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptSpace, rememberSpace } from '../dist/panel.js';
import { deliveredSentIn } from '../dist/conversation/transcript.js';

const widget = (version, extra = {}) => ({ id: 'trip', size: 'm', title: '旅行计划', body: { kind: 'space', src: `artifact://spaces/trip/index.html@${version}`, preview: `artifact://spaces/trip/cover.html@${version}`, ...extra } });
const offer = (id, version, extra) => ({ id, entry: version, input: { type: 'widget', widget: { kind: 'panel', panel: widget(version, extra) } } });
const empty = () => ({ order: ['trip'], widgets: {} });

test('legacy flat-path web Space migrates to a covered Space without changing identity or order', () => {
  const panel = empty(), next = offer('covered', 1);
  panel.widgets.trip = { id: 'trip', title: '旅行计划', size: 'l', origin: 'legacy', body: { kind: 'web', src: 'artifact://spaces/trip.html@2', refresh: 'daily' } };
  acceptSpace(panel, next.input.widget.panel, 'covered', [next], 10);
  assert.deepEqual(panel.order, ['trip']);
  assert.equal(panel.widgets.trip.id, 'trip');
  assert.equal(panel.widgets.trip.body.src, widget(1).body.src);
  assert.equal(panel.widgets.trip.body.preview, widget(1).body.preview);
  assert.equal(panel.widgets.trip.body.refresh, 'daily');
  assert.equal(panel.spaceReceipts.covered.action, 'update');
  acceptSpace(panel, next.input.widget.panel, 'covered', [next], 11);
  assert.equal(panel.widgets.trip.updatedAt, 10);
});

test('legacy migration does not admit another Space namespace', () => {
  const panel = empty(), next = offer('covered', 1);
  panel.widgets.trip = { ...widget(1), body: { kind: 'web', src: 'artifact://spaces/other.html@2' } };
  assert.throws(() => acceptSpace(panel, next.input.widget.panel, 'covered', [next], 10), /其他组件/);
});

test('newer acceptance preserves state namespace, position and omitted refresh; stale offer never rolls back', () => {
  const panel = empty();
  const a = offer('a', 1, { refresh: 'daily' });
  const b = offer('b', 2);
  acceptSpace(panel, a.input.widget.panel, 'a', [a], 1);
  const order = [...panel.order];
  acceptSpace(panel, b.input.widget.panel, 'b', [a, b], 2);
  assert.equal(panel.widgets.trip.id, 'trip');
  assert.equal(panel.widgets.trip.body.refresh, 'daily');
  assert.deepEqual(panel.order, order);
  assert.equal(panel.spaceReceipts.b.action, 'update');
  acceptSpace(panel, a.input.widget.panel, 'a', [a, b], 3);
  assert.equal(panel.widgets.trip.body.src, widget(2).body.src);
  assert.equal(panel.widgets.trip.updatedAt, 2);
});

test('superseded pending offers, including same-version resends, are refused', () => {
  const panel = empty(), a = offer('a', 1), b = offer('b', 2), c = offer('c', 2);
  assert.throws(() => acceptSpace(panel, a.input.widget.panel, 'a', [a, b], 1), /已有新版/);
  assert.throws(() => acceptSpace(panel, b.input.widget.panel, 'b', [a, b, c], 1), /已有新版/);
  assert.deepEqual(panel.widgets, {});
});

test('receipts survive reload/removal; only latest version can be intentionally re-added', () => {
  let panel = empty(), a = offer('a', 1), b = offer('b', 2);
  acceptSpace(panel, b.input.widget.panel, 'b', [a, b], 1);
  rememberSpace(panel, panel.widgets.trip);
  delete panel.widgets.trip;
  panel = JSON.parse(JSON.stringify(panel));
  assert.throws(() => acceptSpace(panel, a.input.widget.panel, 'a', [a, b], 2), /已有新版/);
  acceptSpace(panel, b.input.widget.panel, 'b', [a, b], 3);
  assert.equal(panel.widgets.trip.body.src, widget(2).body.src);
});

test('an unaccepted revision never changes the current widget; explicit refresh change applies on acceptance', () => {
  const panel = empty(), a = offer('a', 1, { refresh: 'daily' }), b = offer('b', 2, { refresh: 'open' });
  acceptSpace(panel, a.input.widget.panel, 'a', [a], 1);
  assert.equal(panel.widgets.trip.body.src, widget(1).body.src);
  assert.equal(panel.widgets.trip.body.refresh, 'daily');
  acceptSpace(panel, b.input.widget.panel, 'b', [a, b], 2);
  assert.equal(panel.widgets.trip.body.refresh, 'open');
});

test('Space identity cannot overwrite another widget kind and malformed refs are refused', () => {
  const panel = empty(), a = offer('a', 1);
  panel.widgets.trip = { ...widget(1), body: { kind: 'note', markdown: 'Keep me' } };
  assert.throws(() => acceptSpace(panel, a.input.widget.panel, 'a', [a], 1), /其他组件/);
  const bad = { ...widget(1), body: { kind: 'space', src: 'artifact://spaces/other/index.html@1' } };
  assert.throws(() => acceptSpace(empty(), bad, 'a', [a], 1), /版本无效/);
});

test('only successful, delivered tool calls become actionable offers', () => {
  const entries = [{ id: 1, kind: 'pi.assistant', model: [{ content: ['pending', 'failed', 'done'].map(id => ({ type: 'toolCall', name: 'send_to_user', id, arguments: offer(id, 1).input })) }] },
    { id: 2, kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'failed', isError: true }] },
    { id: 3, kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'done' }] }];
  assert.deepEqual(deliveredSentIn(entries).map(x => x.id), ['done']);
});

test('real keep transaction: capacity failure leaves no success receipt; retry and drop are safe', async () => {
  const { keepWidget } = await import('../dist/panel.js');
  const { PanelDoc } = await import('../dist/panel.js');
  let state = { order: Array.from({ length: 24 }, (_, i) => `n${i}`), widgets: {} };
  let assets = { items: [] };
  const harness = { commit: async fn => {
    const draft = structuredClone(state), draftAssets = structuredClone(assets);
    await fn({ doc: async doc => doc === PanelDoc ? draft : draftAssets });
    state = draft; assets = draftAssets;
  } };
  const a = offer('a', 1, { refresh: 'daily' }), b = offer('b', 2);
  const entries = [];
  const deliver = item => {
    entries.push({ id: entries.length + 1, kind: 'pi.assistant', model: [{ content: [{ type: 'toolCall', name: 'send_to_user', id: item.id, arguments: item.input }] }] });
    entries.push({ id: entries.length + 1, kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: item.id }] });
  };
  deliver(a);
  await assert.rejects(keepWidget(harness, entries, 'a', true), /视图已满/);
  assert.equal(state.widgets.trip, undefined);
  assert.equal(state.spaceReceipts, undefined);
  state.order.pop();
  await keepWidget(harness, entries, 'a', true);
  assert.equal(state.order.length, 24);
  deliver(b);
  await keepWidget(harness, entries, 'b', true);
  assert.equal(state.order.length, 24);
  assert.equal(state.widgets.trip.body.refresh, 'daily');
  await keepWidget(harness, entries, 'a', true);
  assert.equal(state.widgets.trip.origin, 'b');
  await keepWidget(harness, entries, 'b', false);
  await assert.rejects(keepWidget(harness, entries, 'a', true), /已有新版/);
  await keepWidget(harness, entries, 'b', true);
  assert.equal(state.widgets.trip.body.refresh, 'daily');
  assert.equal(state.widgets.trip.body.src, widget(2).body.src);
});

test('panel.update refuses to bypass Space swipe approval', async () => {
  const { createPanelTool } = await import('../dist/panel.js');
  const tool = createPanelTool();
  const api = { snapshot: async () => ({ order: ['trip'], widgets: { trip: widget(1) } }), commit: async () => { assert.fail('must not commit a Space update'); } };
  const result = await tool.execute({ action: 'update', widget: widget(2) }, api, {});
  assert.equal(result.isError, true);
  assert.match(result.output[0].text, /Space revisions are currently unavailable/);
});
