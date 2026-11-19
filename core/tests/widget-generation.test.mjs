import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation';
import { createSession, MemoryStorage } from '@earendil-works/pi-durable';
import { checkItem } from '../dist/panel/check.js';
import { PanelDoc } from '../dist/panel/doc.js';
import { createPanelTool } from '../dist/panel/tool.js';
import { SendInput } from '../dist/protocol/send.js';
import { keepWidget } from '../dist/send/keep.js';
import { deliveredSentIn } from '../dist/send/sent.js';
import { createSendTool } from '../dist/send/tool.js';

const ctx = BACKGROUND_CONTEXT;
const send = body => ({
  type: 'widget',
  widget: { kind: 'panel', panel: { id: body.kind, size: 'm', title: body.kind, body } },
});
const ordinaryBodies = [
  { kind: 'stat', value: 'Countdown', at: 1900000000000 },
  { kind: 'gauge', items: [{ label: 'Quota', value: 1, max: 2 }] },
  { kind: 'chart', mark: 'line', x: ['Mon'], series: [{ name: 'Steps', values: [5] }] },
  { kind: 'list', items: [{ title: 'Plain row' }, { title: 'Task', done: false }] },
  { kind: 'timeline', events: [{ at: 1900000000000, title: 'Flight' }] },
  { kind: 'note', markdown: 'Hello' },
  { kind: 'media', src: 'https://example.com/photo.png' },
  { kind: 'weather', city: 'Singapore' },
  { kind: 'actions', buttons: [{ label: 'Summarize', prompt: 'Summarize this' }] },
];
const checklist = send({ kind: 'list', items: [{ title: 'Pack', done: false }] });
const space = send({ kind: 'space', src: 'artifact://spaces/space/index.html@1', preview: 'artifact://spaces/space/cover.html@1' });
const sendTool = createSendTool(undefined);
const panelTool = createPanelTool();
const validate = (tool, args) => validateToolArguments(tool, { name: tool.name, arguments: args });

test('only Checklists and Spaces can be offered by the model, with a separate Schedule Overview request', () => {
  for (const body of ordinaryBodies) {
    const input = send(body);
    assert.deepEqual(validate({ name: 'stored send', parameters: SendInput }, input), input);
    assert.throws(() => validate(sendTool, input), /Validation failed/);
    assert.throws(() => validate(panelTool, { action: 'update', widget: input.widget.panel }), /Validation failed/);
  }
  assert.deepEqual(validate(sendTool, checklist), checklist);
  assert.throws(() => validate(sendTool, send({ kind: 'list', items: [] })), /Validation failed/);
  assert.throws(() => validate(sendTool, send({ kind: 'list', items: Array(9).fill({ title: 'Task', done: false }) })), /Validation failed/);
  assert.deepEqual(validate(sendTool, space), space);
  assert.throws(() => validate(panelTool, { action: 'update', widget: space.widget.panel }), /Validation failed/);
  assert.doesNotThrow(() => validate(panelTool, { action: 'update', widget: checklist.widget.panel }));
  assert.doesNotThrow(() => validate(sendTool, { type: 'widget', widget: { kind: 'asset', title: 'File', ref: 'artifact://file.html@1' } }));
  assert.doesNotThrow(() => validate(sendTool, { type: 'widget', widget: { kind: 'panel', panel: { body: { kind: 'schedules' } } } }));
  assert.throws(() => validate(sendTool, send({ kind: 'schedules', revision: 1, rows: [] })), /Validation failed/);
});

test('historical sends still load, keep and list all their original widget bodies', async t => {
  const session = createSession(new MemoryStorage());
  t.after(() => session.close(ctx));
  const entries = ordinaryBodies.flatMap((body, index) => [
    { id: index * 2 + 1, kind: 'pi.assistant', model: [{
      content: [{ type: 'toolCall', name: sendTool.name, id: body.kind, arguments: send(body) }],
    }] },
    { id: index * 2 + 2, kind: 'pi.tool-result', model: [{ role: 'toolResult', toolName: sendTool.name, toolCallId: body.kind }] },
  ]);
  const sent = deliveredSentIn(entries);
  assert.deepEqual(sent.map(offer => offer.input.widget.panel.body), ordinaryBodies);
  for (const offer of sent) await keepWidget(session, entries, offer.id, true);
  await checkItem(session, 'list', 1, true);
  await assert.rejects(checkItem(session, 'list', 0, true), /不能勾选/);
  const kept = await session.snapshot(PanelDoc, ctx);
  const api = { snapshot: session.snapshot.bind(session), commit: session.commit.bind(session) };
  const listed = await panelTool.execute({ action: 'list' }, api, ctx);
  assert.deepEqual(JSON.parse(listed.output[0].text), kept.order.map(id => kept.widgets[id]));
  assert.deepEqual(kept.widgets.list.body.items, [{ title: 'Plain row' }, { title: 'Task', done: true }]);
  const incompatibleUpdate = await panelTool.execute({ action: 'update', widget: checklist.widget.panel }, api, ctx);
  assert.equal(incompatibleUpdate.isError, true);
  assert.deepEqual(await session.snapshot(PanelDoc, ctx), kept);
});
