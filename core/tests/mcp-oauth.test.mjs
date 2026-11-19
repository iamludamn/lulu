import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { NOOP_TELEMETRY_CONTEXT as telemetry } from '@earendil-works/pi-telemetry';
import { deferredMcp } from '../dist/agent/mcp.js';
import { handleMcpRegistry } from '../dist/agent/mcp-registry.js';
import { mcpStore } from '../dist/agent/mcp-store.js';

const registry = 'https://lulu.test/mcp';
const issuer = 'https://provider.test';
const serverUrl = issuer + '/mcp';
const metadata = {
  issuer,
  authorization_endpoint: issuer + '/authorize',
  token_endpoint: issuer + '/token',
  registration_endpoint: issuer + '/register',
  response_types_supported: ['code'],
};

function memoryHost() {
  const durable = new Map();
  const legacy = new Map();
  return {
    host: {
      name: 'main',
      env: { MCP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') },
      telemetry,
      storage: {
        get: async (key) => durable.get(key),
        put: async (entries) => { for (const [key, value] of Object.entries(entries)) durable.set(key, value); },
      },
      kv: {
        get: async (key) => legacy.get(key) ?? null,
        put: async (key, value) => { legacy.set(key, value); },
        list: async (prefix) => [...legacy.keys()].filter((key) => key.startsWith(prefix)),
      },
    },
    durable,
    legacy,
  };
}

async function handleToolRequest(request, accessToken) {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (request.headers.get('authorization') !== `Bearer ${accessToken}`) {
    return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
  }
  const { method, id, params } = await request.json();
  if (id === undefined) return new Response(null, { status: 202 });
  const result = method === 'initialize'
    ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
    : { tools: [{ name: 'look-up', inputSchema: { type: 'object' } }] };
  return Response.json({ jsonrpc: '2.0', id, result });
}

test('registry sign-in consumes the saved callback once and reconnects with encrypted credentials', async (t) => {
  const { host, durable } = memoryHost();
  let exchanges = 0;
  let challenge;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, issuer);
    switch (url.pathname) {
      case '/.well-known/oauth-protected-resource/mcp':
        return Response.json({ resource: serverUrl, authorization_servers: [issuer] });
      case '/.well-known/oauth-authorization-server':
        return Response.json(metadata);
      case '/register': {
        const { redirect_uris } = await request.json();
        assert.deepEqual(redirect_uris, ['https://lulu.test/api/bots/main/mcp/callback']);
        return Response.json({ client_id: 'mock-client', redirect_uris });
      }
      case '/token': {
        exchanges++;
        const params = new URLSearchParams(await request.text());
        assert.equal(params.get('grant_type'), 'authorization_code');
        assert.equal(params.get('code'), 'mock-code');
        assert.equal(params.get('redirect_uri'), 'https://lulu.test/api/bots/main/mcp/callback');
        const verifierHash = createHash('sha256').update(params.get('code_verifier')).digest('base64url');
        assert.equal(verifierHash, challenge);
        return Response.json({ access_token: 'mock-access', refresh_token: 'mock-refresh', token_type: 'Bearer', expires_in: 3600 });
      }
      case '/mcp':
        return handleToolRequest(request, 'mock-access');
      default:
        assert.fail(`Unexpected OAuth request ${url.pathname}`);
    }
  });
  let mcp = await deferredMcp({}, host);
  t.after(() => mcp.close());
  const hooks = {
    statuses: () => mcp.statuses,
    async reload(name) {
      const previous = mcp;
      mcp = await previous.reconnect(await mcpStore(host).servers(), [name]);
      await previous.close();
      return mcp.statuses;
    },
  };
  const request = (path, init) => handleMcpRegistry(new Request(registry + path, init), host, hooks);
  const added = await request('/servers/protected', { method: 'PUT', body: JSON.stringify({ url: serverUrl }) });
  assert.equal((await added.json()).statuses[0].state, 'needs-auth');
  const login = await request('/servers/protected/login', { method: 'POST' });
  assert.equal(login.status, 200);
  const authorization = new URL((await login.json()).authorizationUrl);
  challenge = authorization.searchParams.get('code_challenge');
  const state = authorization.searchParams.get('state');
  assert.ok(state && challenge);
  const callback = '/callback?' + new URLSearchParams({ state, code: 'mock-code', iss: issuer });
  const response = await request(callback);
  assert.equal(new URL(response.headers.get('location')).searchParams.get('login'), 'protected');
  assert.equal(mcp.statuses[0].state, 'connected');
  assert.equal(mcp.extension.tools[0].name, 'mcp__protected__look-up');
  assert.deepEqual(mcp.extension.tools[0].parameters, { type: 'object', properties: {} });
  assert.match((await request(callback)).headers.get('location'), /expired\+sign-in/);
  assert.equal(exchanges, 1);
  assert.ok(durable.has('mcp:auth:main'));
  assert.ok(!durable.get('mcp:auth:main').includes('mock-access'));
  assert.equal(JSON.parse(await mcpStore(host).readAuth())[`mcp__protected|${serverUrl}`].tokens.access_token, 'mock-access');
  const restarted = await request('/servers/protected/login', { method: 'POST' });
  assert.equal(restarted.status, 200);
  assert.notEqual(new URL((await restarted.json()).authorizationUrl).searchParams.get('state'), state);
  assert.equal(exchanges, 1);
});

test('concurrent connections refresh a legacy rotating grant once and keep it scoped to its URL', async (t) => {
  const { host, durable, legacy } = memoryHost();
  const previous = {
    serverUrl,
    clientInformation: { client_id: 'mock-client' },
    tokens: { access_token: 'old-access', refresh_token: 'old-refresh', token_type: 'Bearer' },
    tokensExpireAt: 0,
    discovery: { authorizationServerUrl: issuer, authorizationServerMetadata: metadata },
  };
  await mcpStore(host).writeAuth(JSON.stringify({ mcp__protected: previous }));
  const authKey = 'mcp:auth:main';
  legacy.set(authKey, durable.get(authKey));
  durable.delete(authKey);
  let refreshes = 0;
  const replacement = 'https://replacement.test/mcp';
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    if (request.url === issuer + '/token') {
      refreshes++;
      const params = new URLSearchParams(await request.text());
      assert.equal(params.get('grant_type'), 'refresh_token');
      assert.equal(params.get('refresh_token'), 'old-refresh');
      return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    if (request.url === replacement) {
      assert.equal(request.headers.get('authorization'), null);
      return new Response(null, { status: 401 });
    }
    assert.equal(request.url, serverUrl);
    return handleToolRequest(request, 'new-access');
  });
  const connect = async (url) => {
    const servers = { protected: { url } };
    const mcp = await deferredMcp(servers, host);
    return mcp.reconnect(servers);
  };
  assert.equal((await connect(replacement)).statuses[0].state, 'needs-auth');
  assert.equal(refreshes, 0);
  const connections = await Promise.all([connect(serverUrl), connect(serverUrl)]);
  t.after(() => Promise.all(connections.map((connection) => connection.close())));
  assert.deepEqual(connections.map((connection) => connection.statuses[0].state), ['connected', 'connected']);
  assert.equal(refreshes, 1);
  const credentials = JSON.parse(await mcpStore(host).readAuth());
  assert.equal(credentials[`mcp__protected|${serverUrl}`].tokens.refresh_token, 'new-refresh');
  assert.equal(credentials.mcp__protected, undefined);
});
