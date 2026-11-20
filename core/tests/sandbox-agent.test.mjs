import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import assert from 'node:assert/strict';
import { createSession, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { createBashTool } from '@earendil-works/pi-durable/tools';
import { NOOP_TELEMETRY_CONTEXT } from '@earendil-works/pi-telemetry';
import { BotSession } from '../dist/conversation/bot.js';
import { DelegateAgents } from '../dist/delegate/agents.js';
import { createRun } from '../dist/delegate/spawn.js';
import { SandboxDoc } from '../dist/sandbox/doc.js';
import { createEnvironmentExtension } from '../dist/sandbox/extension.js';
import { createE2bProvider } from '../dist/sandbox/e2b/provider.js';

const context = BACKGROUND_CONTEXT;

test('the main loop omits sandbox tools while delegates keep them', async t => {
  const codingTools = ['read', 'write', 'edit', 'bash'];
  const open = t.mock.method(Harness, 'open');
  const bot = new BotSession({
    name: 'test',
    env: {},
    telemetry: NOOP_TELEMETRY_CONTEXT,
    storage: { get: async () => undefined },
    alarm: { get: async () => null, set: async () => {}, delete: async () => {} },
    sockets: { all: () => [] },
    sandbox: async () => { throw new Error('unexpected sandbox use'); },
    abort: reason => assert.fail(reason),
  });
  await bot.start(() => new MemoryStorage());
  const harness = await open.mock.calls[0].result;
  t.after(async () => {
    await setImmediate(); // Let the bot finish alarm refreshes triggered by the test commits.
    await harness.close(context);
  });
  const root = await harness.root(context);
  const main = await root.agent(context);
  assert.ok(main.extensions.every(extension => extension.name !== 'coding-tools'));
  assert.ok(main.tools.some(tool => tool.name === 'delegate'));
  assert.ok(main.tools.some(tool => tool.name === 'send_to_user'));
  assert.deepEqual([...main.tools, ...main.callable].filter(tool => codingTools.includes(tool.name)).map(tool => tool.name), []);

  const entry = await harness.commit(tx => tx.appendEntry(root.id, { kind: 'test.fork' }), context);
  for (const forkAt of [null, entry.id]) {
    const { childId } = await harness.commit(tx => createRun(tx, {
      runId: `test-${forkAt}`, task: 'Read a file', description: 'Read a file',
      agent: 'worker', presets: DelegateAgents, token: null, origin: [],
      parentId: root.id, cwd: null, forkAt, model: null, thinkingLevel: null,
    }), context);
    const child = await harness.conversation(childId, context);
    const agent = await child.agent(context);
    assert.deepEqual(agent.tools.filter(tool => codingTools.includes(tool.name)).map(tool => tool.name), codingTools);
  }
});

async function exerciseBash(provider) {
  const session = createSession(new MemoryStorage());
  const conversation = await session.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), context);
  await session.commit(async tx => {
    const binding = await tx.doc(SandboxDoc, conversation.id);
    binding.key = 'ci-sandbox';
  }, context);
  const tool = createEnvironmentExtension(provider).wraps.find(item => item.tool === 'bash').wrap(createBashTool());
  let output = '';
  const api = {
    taskId: 100,
    conversationId: conversation.id,
    snapshot: session.snapshot.bind(session),
    commit: session.commit.bind(session),
    watchDoc: session.watchDoc.bind(session),
    output: text => { output += text; },
    retainedOutput: () => ({ text: output, truncated: false }),
    diagnostic() {},
  };
  let firstRef;
  try {
    for (let i = 0; i < 2; i++) {
      output = '';
      const result = await tool.execute({ command: 'printf sandbox_ci_ok' }, api, context);
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.equal(result.structuredOutput.output, 'sandbox_ci_ok');
      assert.equal(result.structuredOutput.exitCode, 0);
      const binding = await session.snapshot(SandboxDoc, conversation.id, context);
      if (i === 0) firstRef = binding.ref;
      else assert.deepEqual(binding.ref, firstRef);
    }
  } finally {
    const binding = await session.snapshot(SandboxDoc, conversation.id, context);
    try {
      if (binding?.ref) await provider.destroy(binding.ref, 'ci-cleanup', context);
    } finally {
      await session.close(context);
    }
  }
}

test('agent bash calls reopen the same sandbox after a committed transaction', async () => {
  const opened = [];
  const provider = {
    backend: 'e2b',
    profile: 'default',
    async open(request) {
      const id = request.ref ? request.ref.resource.id : 'sandbox-ci';
      opened.push(id);
      return {
        ref: { backend: 'e2b', resource: { id } },
        cwd: '/workspace',
        env: {
          cwd: '/workspace',
          async exec(command, options) {
            assert.match(String(command), /sandbox_ci_ok/);
            options.onOutput('sandbox_ci_ok', context, { skipped: 0 });
            return { ok: true, value: { exitCode: 0 } };
          },
        },
      };
    },
    async renew() {},
    async idle(ref) { return ref; },
    async destroy() {},
  };
  await exerciseBash(provider);
  assert.deepEqual(opened, ['sandbox-ci', 'sandbox-ci']);
});

test('agent bash calls run in a real E2B sandbox', { skip: process.env.LULU_SANDBOX_LIVE !== '1', timeout: 120_000 }, async () => {
  assert.ok(process.env.E2B_API_KEY, 'E2B_API_KEY is required for the live sandbox check');
  const provider = createE2bProvider(process.env, `ci-${crypto.randomUUID()}`, NOOP_TELEMETRY_CONTEXT);
  assert.ok(provider);
  await exerciseBash(provider);
});
