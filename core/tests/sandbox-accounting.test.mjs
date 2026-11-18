import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { createBashTool } from '@earendil-works/pi-durable/tools';
import { NOOP_TELEMETRY_CONTEXT as telemetry } from '@earendil-works/pi-telemetry';
import { SandboxAccountingDoc, accounting, confirmedReady, finishResource, opening, stoppingResource, uncertainResource } from '../dist/sandbox/accounting.js';
import { observeSandboxActivity } from '../dist/sandbox/activity.js';
import { SandboxDoc, SANDBOX_LEASE_MS } from '../dist/sandbox/doc.js';
import { createEnvironmentExtension } from '../dist/sandbox/extension.js';
import { sandboxWindowQuery } from '../dist/sandbox/report-api.js';
import { sandboxReport } from '../dist/sandbox/report.js';
import { handleApi } from '../dist/server/api.js';

const second = (x) => x * 1000;
const resource = (id) => ({ backend: 'e2b', resource: { id } });
const range = (start, end) => ({ start: second(start), end: second(end) });
const ready = (resource, start, end) => ({ kind: 'ready', resource, backend: 'e2b', ...range(start, end) });
const agent = (task, start, end, delegate = true) => ({ kind: 'agent', task, delegate, ...range(start, end) });
const link = (task, resource, start, end) => ({ kind: 'association', task, resource, ...range(start, end) });
const empty = (since = 1) => ({ since, history: [], resources: {}, agents: {}, links: {} });
const projection = ({ online_seconds, occupied_seconds, associated_agent_seconds, delegate_active_seconds, occupancy, parallelism, other_work_seconds, unassociated_seconds }) => ({
  online_seconds, occupied_seconds, associated_agent_seconds, delegate_active_seconds, occupancy, parallelism, other_work_seconds, unassociated_seconds,
});

test('window totals distinguish active time, shared union, parallelism, and other work', () => {
  const ledger = empty();
  ledger.history = [
    ready('a', 0, 10), ready('a', 0, 10), ready('a', 12, 14), ready('b', 2, 4),
    agent('1', 0, 9), link('1', 'a', 1, 9),
    agent('2', 0, 8), link('2', 'a', 0, 8), link('2', 'a', 0, 8),
    agent('3', 6, 7), link('3', 'a', 6, 7), link('3', 'b', 7, 8),
    agent('4', 5, 6),
    agent('root', 8, 12, false), link('root', 'a', 8, 12),
  ];
  assert.deepEqual(projection(sandboxReport(ledger, second(3), second(12), second(15))), {
    online_seconds: 8, occupied_seconds: 6, associated_agent_seconds: 12,
    delegate_active_seconds: 13, occupancy: .75, parallelism: 1.5,
    other_work_seconds: 1, unassociated_seconds: 1,
  });
});

test('sequential runs and a resource switch count only while their resource is ready', () => {
  const ledger = empty();
  ledger.history = [
    ready('first', 1, 5), ready('replacement', 8, 12), ready('independent', 2, 10),
    agent('1', 0, 9), link('1', 'first', 2, 7), link('1', 'replacement', 8, 9),
    agent('2', 9, 11), link('2', 'replacement', 9, 11),
    agent('3', 1, 10), link('3', 'independent', 6, 10),
  ];
  const report = sandboxReport(ledger, second(1), second(13), second(13));
  assert.equal(report.online_seconds, 16);
  assert.equal(report.occupied_seconds, 10);
  assert.equal(report.associated_agent_seconds, 10);
  assert.equal(report.unassociated_seconds, 6);
});

test('provider retries, pause and retention, open lease timeout, and loss have explicit coverage', () => {
  const ledger = empty();
  opening(ledger, 'holder:0', 'e2b', second(2), true);
  uncertainResource(ledger, 'holder:0', 'e2b', second(3));
  opening(ledger, 'holder:0', 'e2b', second(4), true);
  confirmedReady(ledger, 'holder:0', resource('a'), second(4), second(5));
  confirmedReady(ledger, 'holder:0', resource('a'), second(10), second(11));
  finishResource(ledger, 'holder:0', second(12));
  const paused = sandboxReport(ledger, second(12), second(49), second(49));
  assert.equal(paused.online_seconds, 0);
  assert.equal(paused.occupancy, null);
  assert.equal(paused.unknown_sandbox_seconds, 0);

  opening(ledger, 'holder:0', 'e2b', second(50), true);
  confirmedReady(ledger, 'holder:0', resource('a'), second(50), second(51));
  const open = sandboxReport(ledger, second(49), second(54), second(54));
  assert.equal(open.startup_seconds, 1);
  assert.equal(open.online_seconds, 3);
  assert.equal(open.open_sandboxes, 1);
  const deadline = second(50) + SANDBOX_LEASE_MS;
  const expired = sandboxReport(ledger, deadline - second(2), deadline + second(3), deadline + second(3));
  assert.equal(expired.online_seconds, 2);
  assert.equal(expired.unknown_sandbox_seconds, 3);
  assert.equal(sandboxReport(ledger, second(1), second(12), second(100)).unknown_sandbox_seconds, 2);

  uncertainResource(ledger, 'holder:0', 'e2b', deadline + second(5));
  finishResource(ledger, 'holder:0', deadline + second(5));
  const lost = sandboxReport(ledger, deadline, deadline + second(8), deadline + second(8));
  assert.equal(lost.online_seconds, 0);
  assert.equal(lost.unknown_sandbox_seconds, 5);
  assert.equal(lost.open_sandboxes, 0);
});

class PersistentMemory extends MemoryStorage {
  async close() {}
}

test('Durable reopen recovers completed intervals and marks interrupted phases and stops unknown', async () => {
  const storage = new PersistentMemory();
  const options = { models: createModels(), registry: createRegistry() };
  const first = await Harness.open(storage, options, context);
  const root = await first.root(context);
  const start = Date.now() - second(30);
  await first.commit(async tx => {
    const ledger = await accounting(tx, start);
    const key = `${root.id}:0`;
    opening(ledger, key, 'e2b', start, true);
    confirmedReady(ledger, key, resource('one'), start, start + second(1));
    confirmedReady(ledger, key, resource('one'), start + second(6), start + second(7));
    stoppingResource(ledger, key);
    ledger.agents['300'] = { delegate: true, start: start + second(2), observed: start + second(5) };
  }, context);
  await first.close(context);
  const secondHarness = await Harness.open(storage, options, context);
  try {
    await observeSandboxActivity(secondHarness, root.id, telemetry, context);
    const snapshot = await secondHarness.snapshot(SandboxAccountingDoc, context);
    const result = sandboxReport(snapshot, start, start + second(25), Date.now());
    assert.equal(result.startup_seconds, 1);
    assert.equal(result.online_seconds, 6);
    assert.equal(result.unknown_sandbox_seconds, 18);
    assert.equal(result.delegate_active_seconds, 3);
    assert.equal(result.unknown_delegate_seconds, 20);
    assert.equal(result.open_agents, 0);
  } finally {
    await secondHarness.close(context);
  }
});

test('real Durable generation and sandbox tool persist a resource association', { timeout: 10000 }, async () => {
  const registry = createRegistry();
  const provider = {
    backend: 'e2b',
    profile: 'default',
    open: async () => ({ ref: resource('test'), cwd: '/test', env: {
      cwd: '/test',
      async exec() {
        await new Promise(resolve => setTimeout(resolve, 15));
        return { ok: true, value: { exitCode: 0 } };
      },
    } }),
    renew: async () => {},
    idle: async (ref) => ref,
    destroy: async () => {},
  };
  const environment = createEnvironmentExtension(provider);
  registry.install({ ...environment, tools: [createBashTool()] });
  const model = { id: 'test', provider: 'test', api: 'openai-completions', name: 'test', contextWindow: 100000, maxTokens: 4000, input: ['text'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let attempt = 0;
  const cancelling = Promise.withResolvers();
  const models = Object.assign(createModels(), {
    getModel: () => model,
    streamSimple: (_model, _context, { signal }) => {
      const current = attempt++;
      const tool = current === 0;
      const content = tool ? [{ type: 'toolCall', name: 'bash', arguments: { command: 'true' }, id: 'call-1' }] : [{ type: 'text', text: 'done' }];
      const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason: tool ? 'toolUse' : 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (current === 2) return {
        async *[Symbol.asyncIterator]() {
          const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          cancelling.resolve();
          await aborted;
        },
        result: async () => ({ ...message, stopReason: 'aborted' }),
      };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message };
    },
  });
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  try {
    const root = await harness.root(context);
    const read = await observeSandboxActivity(harness, root.id, telemetry, context);
    const child = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'test', modelId: 'test' } } }, context);
    await harness.commit(async tx => {
      const own = await tx.doc(SandboxDoc, child.id);
      own.key = 'delegate-run';
      own.owner = root.id;
    }, context);
    const submission = await child.submit({ type: 'input', content: 'Run a test', requestId: 'test-work' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    await child.waitForIdle(context);
    await read();
    const snapshot = await harness.snapshot(SandboxAccountingDoc, context);
    assert.ok(snapshot.history.some(period => period.kind === 'association'));
    assert.equal(Object.keys(snapshot.links).length, 0);
    const end = Date.now();
    const report = sandboxReport(snapshot, snapshot.since, end, end);
    assert.ok(report.occupied_seconds > 0);
    assert.ok(report.delegate_active_seconds >= report.associated_agent_seconds);
    assert.ok(report.occupancy <= 1);

    const cancelled = await child.submit({ type: 'input', content: 'Cancel this test', requestId: 'test-cancel' }, context);
    await cancelling.promise;
    await read();
    const running = await harness.snapshot(SandboxAccountingDoc, context);
    assert.equal(Object.keys(running.agents).length, 1);
    await child.abort(context);
    assert.equal((await cancelled.wait(context)).status, 'unanswered');
    await read();
    const stopped = await harness.snapshot(SandboxAccountingDoc, context);
    assert.equal(Object.keys(stopped.agents).length, 0);
  } finally {
    await harness.close(context);
  }
});

test('Grafana queries return bounded aggregates and the Worker route fails closed', async () => {
  const now = Date.now();
  const dashboard = JSON.parse(readFileSync(new URL('../../ops/observability/lulu-sandbox-occupancy.json', import.meta.url), 'utf8'));
  const read = { snapshot: async () => empty(now - second(5)) };
  for (const { targets, title } of dashboard.panels.filter(panel => panel.type === 'stat')) {
    const query = targets[0].expr.replace('${__from}', String(now - second(10))).replace('${__to}', String(now));
    const result = await sandboxWindowQuery(new Request('https://bot/sandbox-window?' + new URLSearchParams({ query })), read, context);
    const payload = await result.json();
    assert.equal(result.status, 200, title);
    assert.equal(payload.data.resultType, 'vector');
    assert.equal(payload.data.result.length, 1);
    const absent = ['Subagent-associated occupancy', 'Associated agents per online sandbox', 'Age of last activity or ready confirmation'];
    assert.equal(payload.data.result[0].value[1] === 'NaN', absent.includes(title), title);
  }
  const url = 'https://lulu.test/api/bots/main/observability/api/v1/query?query=1%2B1';
  const host = { telemetry, env: {}, objects: { BOTS: { getByName: () => ({ fetch: (url) => sandboxWindowQuery(new Request(url), read, context) }) } } };
  assert.equal((await handleApi(new Request(url), host)).status, 401);
  host.env.LULU_OBSERVABILITY_TOKEN = 'fixture';
  assert.equal((await handleApi(new Request(url, { headers: { Authorization: 'Bearer incorrect' } }), host)).status, 401);
  const valid = await handleApi(new Request(url, { headers: { Authorization: 'Bearer fixture' } }), host);
  assert.equal(valid.headers.get('cache-control'), 'no-store');
  assert.equal((await valid.json()).data.result[0].value[1], '2');
  const invalid = await sandboxWindowQuery(new Request('https://bot/sandbox-window?' + new URLSearchParams({
    query: `lulu_sandbox_window{from="1",to="${now}"}`,
  })), read, context);
  assert.equal(invalid.status, 400);
});
