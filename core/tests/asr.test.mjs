import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { asrPacket, asrResult, AsrSessions } from '../dist/voice/asr.js';
import { parseFrame } from '../dist/conversation/frame.js';

function response(text, final = false, gzip = false) {
  const body = Buffer.from(JSON.stringify({ result: { text } }));
  const payload = gzip ? gzipSync(body) : body;
  const packet = Buffer.alloc(12 + payload.length);
  packet.set([0x11, final ? 0x93 : 0x91, gzip ? 0x11 : 0x10, 0]);
  packet.writeInt32BE(final ? -2 : 1, 4);
  packet.writeUInt32BE(payload.length, 8);
  packet.set(payload, 12);
  return packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.length);
}
function fixture(connect, env = {}) {
  const events = [], sent = [];
  let handlers, closed = 0;
  const upstream = { send: data => sent.push(new Uint8Array(data)), close: () => { closed++; handlers?.close(); } };
  const host = { env: { VOLC_SPEECH_ASR_API_KEY: 'test', ...env }, connect: async (_url, headers, h) => {
    assert.equal(headers['X-Api-Resource-Id'], 'volc.seedasr.sauc.duration');
    handlers = h;
    return connect ? connect(upstream) : { status: 101, socket: upstream };
  } };
  const sessions = new AsrSessions(host, (_socket, event) => events.push(event));
  const socket = {};
  return { sessions, socket, events, sent, receive: data => handlers.message(data), closed: () => closed };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test('ASR packets use big-endian size and explicit final marker', () => {
  const packet = new Uint8Array(asrPacket(0x22, new Uint8Array([1, 2])));
  assert.deepEqual([...packet], [0x11, 0x22, 0, 0, 0, 0, 0, 2, 1, 2]);
});
test('ASR reads partial and final transcripts including gzip', async () => {
  assert.deepEqual(await asrResult(response('你好')), { text: '你好', final: false });
  assert.deepEqual(await asrResult(response('你好。', true, true)), { text: '你好。', final: true });
  assert.deepEqual(await asrResult(new Blob([response('Blob 结果', true)])), { text: 'Blob 结果', final: true });
  await assert.rejects(asrResult(response('test').slice(0, 15)), /不完整/);
});
test('ASR commands parse without entering prompt submission', () => {
  for (const type of ['asr.start', 'asr.finish', 'asr.cancel']) assert.deepEqual(parseFrame(JSON.stringify({ type, requestId: 'one' })), { type, requestId: 'one' });
  assert.throws(() => parseFrame(JSON.stringify({ type: 'asr.audio', requestId: 'one', audio: null })), /Unknown command/);
});
test('ASR refines by default and accepts an independent provider dictionary', async () => {
  const base = { model_name: 'bigmodel', enable_itn: true, enable_punc: true, result_type: 'full' };
  const refinement = { enable_nonstream: true, enable_ddc: true };
  const dictionary = { corpus: { correct_table_id: 'terms' } };
  for (const [env, expected] of [
    [{}, { ...base, ...refinement }],
    [{ VOLC_SPEECH_ASR_REFINE: 'false' }, base],
    [{ VOLC_SPEECH_ASR_REFINE: 'true', VOLC_SPEECH_ASR_CORRECTION_TABLE_ID: ' ' }, { ...base, ...refinement }],
    [{ VOLC_SPEECH_ASR_REFINE: 'false', VOLC_SPEECH_ASR_CORRECTION_TABLE_ID: ' terms ' }, { ...base, ...dictionary }],
    [{ VOLC_SPEECH_ASR_REFINE: 'true', VOLC_SPEECH_ASR_CORRECTION_TABLE_ID: 'terms' }, { ...base, ...refinement, ...dictionary }],
  ]) {
    const f = fixture(undefined, env);
    await f.sessions.start(f.socket, 'one');
    f.sessions.cancel(f.socket, 'one');
    assert.deepEqual(JSON.parse(new TextDecoder().decode(f.sent[0].subarray(8))).request, expected);
  }
});
test('built-in replacement applies only to the final transcript and yields to a provider dictionary', async () => {
  for (const [table, expected] of [['', '检查Kubernetes集群。'], ['terms', '检查库伯内特斯集群。']]) {
    const f = fixture(undefined, { VOLC_SPEECH_ASR_CORRECTION_TABLE_ID: table });
    await f.sessions.start(f.socket, 'one');
    f.sessions.finish(f.socket, 'one');
    f.receive(response('检查库伯内特斯'));
    f.receive(response('检查库伯内特斯集群。', true));
    await settle();
    assert.deepEqual(f.events.slice(1).map(e => e.text), ['检查库伯内特斯', expected]);
    assert.equal(f.closed(), 1);
  }
});
test('finishing waits for final result and closes upstream once', async () => {
  const f = fixture();
  await f.sessions.start(f.socket, 'one');
  f.sessions.audio(f.socket, 'one', btoa('\x00\x00'));
  f.sessions.finish(f.socket, 'one');
  assert.equal(f.sent[1][1], 0x20);
  assert.equal(f.sent[2][1], 0x22);
  f.receive(response('你好'));
  f.receive(response('你好。', true));
  await settle();
  assert.equal(f.events.at(-1).final, true);
  assert.equal(f.events.at(-1).text, '你好。');
  assert.equal(f.closed(), 1);
  assert.ok(!f.events.some(e => e.type === 'asr.error'));
});
test('cancel discards late results and ignores audio from a previous recording', async () => {
  const f = fixture();
  await f.sessions.start(f.socket, 'new');
  f.sessions.audio(f.socket, 'old', btoa('\x00\x00'));
  assert.equal(f.sent.length, 1);
  f.sessions.cancel(f.socket, 'old');
  assert.equal(f.closed(), 0);
  f.sessions.cancel(f.socket, 'new');
  f.receive(response('不能发送', true));
  await settle();
  assert.equal(f.events.length, 1);
  assert.equal(f.closed(), 1);
});
test('cancel during connection setup closes the late upstream without ready', async () => {
  let resolve;
  const f = fixture(upstream => new Promise(r => { resolve = () => r({ status: 101, socket: upstream }); }));
  const starting = f.sessions.start(f.socket, 'one');
  f.sessions.cancel(f.socket);
  resolve(); await starting;
  assert.equal(f.events.length, 0);
  assert.equal(f.closed(), 1);
});
test('invalid audio stops recognition without a transcript', async () => {
  const f = fixture();
  await f.sessions.start(f.socket, 'one');
  f.sessions.audio(f.socket, 'one', btoa('x'));
  assert.equal(f.events.at(-1).type, 'asr.error');
  assert.equal(f.closed(), 1);
});
