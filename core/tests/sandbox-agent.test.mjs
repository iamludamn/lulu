import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, MemoryStorage } from '@earendil-works/pi-durable';
import { createBashTool } from '@earendil-works/pi-durable/tools';
import { NOOP_TELEMETRY_CONTEXT } from '@earendil-works/pi-telemetry';
import { SandboxDoc } from '../dist/sandbox/doc.js';
import { createEnvironmentExtension } from '../dist/sandbox/extension.js';
import { createE2bProvider } from '../dist/sandbox/e2b/provider.js';

const context = {};

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
