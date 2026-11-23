import { createModels } from '@earendil-works/pi-ai/models';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory';
import { NOOP_TELEMETRY_CONTEXT as telemetry } from '@earendil-works/pi-telemetry';
import { retrieveMemory, createRetrievalTools } from '../dist/memory/retrieval.js';
import { selectMemories } from '../dist/memory/injection.js';
import { createMemoryExtension } from '../dist/memory/extension.js';
import { injectionContext } from '../dist/memory/injection.js';

const resource = { id: 'memory:spaces/trip.md', type: 'space', summary: 'Travel preferences', sourceRefs: ['space:trip@source-v1'], version: 'a'.repeat(40), contentRef: 'spaces/trip.md' };
const input = (requestId) => ({ requestId, catalog: [resource], turns: [{ role: 'user', text: 'Plan my trip' }], model: { provider: 'test', modelId: 'test' } });
class PersistentMemory extends MemoryStorage { async close() {} }
const call = (name, args, index) => ({ type: 'toolCall', name, arguments: args, id: `call-${index}` });
function models(steps, inspect = () => {}) {
  let index = 0;
  return Object.assign(createModels(), {
    getModel: () => ({ id: 'test', provider: 'test', api: 'openai-completions', name: 'test', contextWindow: 100000, maxTokens: 4000, input: ['text'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    streamSimple: (_, context, options) => {
      inspect(context, options);
      const content = steps[index++] ?? [{ type: 'text', text: 'done' }];
      const message = { role: 'assistant', content, api: 'openai-completions', provider: 'test', model: 'test', stopReason: content.some(p => p.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message };
    },
  });
}
const reads = () => ({ readVersion: async (path, version) => {
  assert.equal(path, resource.contentRef);
  assert.equal(version, resource.version);
  return '---\ndescription: Travel preferences\n---\nThe user prefers trains.';
} });
const read = (index = 1) => [call('memory_read', { id: resource.id, version: resource.version }, index)];
const inject = (context = 'The user prefers trains.', index = 2) => [call('inject_memory', { context, resources: [{ id: resource.id, version: resource.version }] }, index)];

test('main is passive; retrieval exposes only exact reads and delivery', () => {
  assert.deepEqual(createMemoryExtension({}).tools ?? [], []);
  assert.deepEqual(createRetrievalTools(reads()).map(tool => tool.name), ['memory_read', 'inject_memory']);
});

test('decision gate accepts only valid probabilities and never reads content', async () => {
  for (const [probability, expected] of [[0.9, 'selected'], [0.2, 'empty'], [2, 'error'], [null, 'error']]) {
    let calls = 0;
    const model = { name: 'clef', run: async (_, questions) => {
      calls++;
      assert.deepEqual(Object.keys(questions), ['inject']);
      return { answers: { inject: { noul: probability } } };
    } };
    assert.equal((await selectMemories(model, telemetry, input('x').turns, [resource])).outcome, expected);
    assert.equal(calls, 1);
  }
  assert.equal((await selectMemories(undefined, telemetry, [], [resource])).outcome, 'unconfigured');
  assert.equal((await selectMemories({ name: 'clef', run: async () => { throw new DOMException('Timeout', 'TimeoutError'); } }, telemetry, [], [resource])).outcome, 'timeout');
});

test('read then inject delivers organized context with exact provenance and replays after reopen', async () => {
  const storage = new PersistentMemory();
  const result = await retrieveMemory(storage, models([read(), inject()]), reads(), input('request-a'));
  assert.equal(result.outcome, 'selected');
  assert.equal(result.context, 'The user prefers trains.');
  assert.deepEqual(result.selected.map(x => x.resource), [resource]);
  const replay = await retrieveMemory(storage, models([], () => assert.fail('replay must not call a model')), { readVersion: async () => assert.fail('replay must not read new content') }, { ...input('request-a'), catalog: [] });
  assert.deepEqual(replay, result);
  assert.match(injectionContext(result), /The user prefers trains/);
  const { contextCoverage } = await import('../dist/memory/context.js');
  assert.equal(contextCoverage(injectionContext(result)), 'content');
});

test('unread references, wrong versions and free-form model replies are never injected', async () => {
  for (const steps of [[inject()], [[call('memory_read', { id: resource.id, version: 'b'.repeat(40) }, 1)], inject()], [[{ type: 'text', text: 'Invented memory' }]]]) {
    const result = await retrieveMemory(new PersistentMemory(), models(steps), reads(), input('request-b'));
    assert.equal(result.outcome, 'error');
    assert.deepEqual(result.selected, []);
    assert.equal(injectionContext(result), undefined);
  }
});

test('first delivery wins; another request cannot reuse prior read receipts', async () => {
  const storage = new PersistentMemory();
  const first = await retrieveMemory(storage, models([read(), inject('First'), inject('Conflicting', 3)]), reads(), input('first'));
  assert.equal(first.context, 'First');
  const second = await retrieveMemory(storage, models([inject()]), reads(), input('second'));
  assert.equal(second.outcome, 'error');
  assert.equal(injectionContext(second), undefined);
});

test('missing or sensitive versions cannot be cited; explicit empty delivery is valid', async () => {
  for (const text of [undefined, 'OPENAI_API_KEY=sk-' + 'a'.repeat(50)]) {
    const result = await retrieveMemory(new PersistentMemory(), models([read(), inject()]), { readVersion: async () => text }, input('blocked'));
    assert.equal(result.outcome, 'error');
  }
  const empty = await retrieveMemory(new PersistentMemory(), models([[call('inject_memory', { context: '', resources: [] }, 1)]]), reads(), input('empty'));
  assert.equal(empty.outcome, 'empty');
  assert.equal(injectionContext(empty), undefined);
});

test('admission binds memory atomically; an empty next request clears the section and retries stay idempotent', async () => {
  const { Harness, createRegistry } = await import('@earendil-works/pi-durable');
  const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context');
  const { admitPrompt, chatMessages } = await import('../dist/conversation/requests.js');
  const { InjectionBindings, InjectionFamily } = await import('../dist/memory/doc.js');
  const sections = [];
  const registry = createRegistry();
  registry.install(createMemoryExtension({}));
  const harness = await Harness.open(new PersistentMemory(), { registry, models: models([], (ctx) => {
    sections.push(ctx.messages.filter(m => m.role === 'system').at(-1)?.sections?.memory);
  }) }, context);
  const root = await harness.root(context, { agent: { model: input('x').model } });
  const view = { entries: [] };
  const first = { requestId: 'a', context: 'Only request A', selected: [{ resource, text: 'Only request A' }], outcome: 'selected' };
  try {
    const admit = async (requestId, injection) => {
      await admitPrompt(harness, root, view, { type: 'prompt.submit', requestId, content: requestId, whenBusy: 'followUp' }, injection);
      const record = await harness.commit(tx => tx.submissionByRequest(root.id, requestId), context);
      await (await harness.submission(record.id, context)).wait(context);
      return record.id;
    };
    const id = await admit('a', first);
    assert.match(sections.at(-1), /Only request A/);
    await admit('a', { requestId: 'a', selected: [], outcome: 'empty' });
    assert.deepEqual(await harness.snapshot(InjectionFamily, 'a', context), first);
    assert.equal((await chatMessages(harness, context)).length, 1);
    assert.equal((await harness.snapshot(InjectionBindings, context)).requests[id], 'a');
    await admit('b', { requestId: 'b', selected: [], outcome: 'empty' });
    assert.equal(sections.at(-1) ?? undefined, undefined);
    assert.equal((await chatMessages(harness, context)).length, 2);
  } finally { await harness.close(context); }
});

test('persisted expired retrieval cannot start a model or deliver stale memory', async () => {
  const { Harness, createRegistry } = await import('@earendil-works/pi-durable');
  const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context');
  const { RetrievalJobs } = await import('../dist/memory/retrieval.js');
  const storage = new PersistentMemory();
  const harness = await Harness.open(storage, { models: models([]), registry: createRegistry() }, context);
  await harness.commit(async tx => { (await tx.doc(RetrievalJobs, 'expired', input('expired'))).deadline = Date.now() - 1; }, context);
  await harness.close(context);
  const result = await retrieveMemory(storage, models([], () => assert.fail('expired request must not invoke a model')), reads(), input('expired'));
  assert.equal(result.outcome, 'timeout');
  assert.equal(injectionContext(result), undefined);
});

test('published catalog excludes empty templates, sensitive content and invalid paths', async () => {
  const { memoryResources } = await import('../dist/memory/files.js');
  const files = {
    'spaces/trip.md': '---\ndescription: Travel preferences\nsourceRefs: ["space:trip@v1"]\n---\nPrefers trains.',
    'system/empty.md': '---\ndescription: Empty template\n---\n',
    'assets/key.md': '---\ndescription: Secret\n---\nOPENAI_API_KEY=sk-' + 'a'.repeat(50),
    '../escape.md': 'not a memory',
  };
  const catalog = memoryResources({ version: resource.version, files });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].type, 'space');
  assert.deepEqual(catalog[0].sourceRefs, ['space:trip@v1']);
  assert.equal(catalog[0].version, resource.version);
});

test('Space sources pin the kept page and current saved state; version changes only when the manifest changes', async () => {
  const { collectMemorySources } = await import('../dist/memory/sources.js');
  const { PanelDoc } = await import('../dist/panel.js');
  let stateVersion = 3;
  const queries = [];
  const host = { name: 'test', objects: { ARTIFACTS: { getByName: () => ({ fetch: async url => {
    const query = new URL(url).searchParams;
    queries.push(Object.fromEntries(query));
    return Response.json({ version: query.get('version') ? Number(query.get('version')) : stateVersion, contentType: query.get('name').endsWith('.json') ? 'application/json' : 'text/html', size: 100 });
  } }) } } };
  const reader = { snapshot: async doc => doc === PanelDoc ? { order: ['trip'], widgets: { trip: { title: 'Trip', body: { kind: 'space', src: 'artifact://spaces/trip/index.html@2' } }, unkept: { title: 'Unkept', body: { kind: 'space', src: 'artifact://spaces/unkept/index.html@9' } } } } : { items: [] } };
  const first = await collectMemorySources(reader, host);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].refs.map(ref => [ref.part, ref.version]), [['page', 2], ['state', 3]]);
  assert.deepEqual(queries[0], { name: 'spaces/trip/index.html', version: '2' });
  assert.deepEqual(await collectMemorySources(reader, host), first);
  stateVersion = 4;
  assert.notEqual((await collectMemorySources(reader, host))[0].version, first[0].version);
});

test('a negative decision skips retrieval; classifier failure yields an explicit empty result', async () => {
  const { prepareInjection } = await import('../dist/memory/injection.js');
  for (const broken of [false, true]) {
    const calls = [];
    const host = { name: 'test', env: {}, telemetry, decisionModel: { name: 'clef', run: async () => {
      if (broken) throw new Error('synthetic classifier failure');
      return { answers: { inject: { noul: 0.1 } } };
    } }, objects: { MEMORY: { getByName: () => ({ fetch: async url => { calls.push(url); return Response.json([resource]); } }) } } };
    const { createSession } = await import('@earendil-works/pi-durable');
    const session = createSession(new PersistentMemory());
    const result = await prepareInjection(host, session, 'no-retrieval', 'Hello', { entries: [], conversation: { id: 1 } });
    assert.equal(result.outcome, broken ? 'error' : 'empty');
    assert.deepEqual(result.selected, []);
    assert.deepEqual(calls, ['https://memory/catalog']);
  }
});

test('prepared delivery is stable before prompt admission even if the live catalog changes', async () => {
  const { createSession } = await import('@earendil-works/pi-durable');
  const { prepareInjection } = await import('../dist/memory/injection.js');
  const session = createSession(new PersistentMemory());
  let modelCalls = 0;
  const requests = [];
  const delivery = { requestId: 'prepared', context: 'Pinned memory', selected: [{ resource, text: 'Pinned memory' }], outcome: 'selected' };
  const host = { name: 'test', env: {}, telemetry, decisionModel: { name: 'clef', run: async () => { modelCalls++; return { answers: { inject: { noul: 0.9 } } }; } }, objects: { MEMORY: { getByName: () => ({ fetch: async url => { requests.push(url); return Response.json(url.endsWith('/catalog') ? [resource] : delivery); } }) } } };
  const first = await prepareInjection(host, session, 'prepared', 'Plan', { entries: [], conversation: { id: 1 } });
  host.objects.MEMORY.getByName = () => ({ fetch: async () => assert.fail('replay must not query current resources') });
  assert.deepEqual(await prepareInjection(host, session, 'prepared', 'Changed', { entries: [], conversation: { id: 1 } }), first);
  assert.equal(modelCalls, 1);
  assert.deepEqual(requests, ['https://memory/catalog', 'https://memory/retrieve']);
});
