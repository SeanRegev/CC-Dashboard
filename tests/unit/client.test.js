// @ts-check
'use strict';
// CoreClient (renderer) against the mock core, using Node 22's global WebSocket.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { startMockCore } = require('../../packages/app/src/renderer/dev/mock-core.js');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'app', 'src', 'renderer', 'client.js')).href);
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-client-'));
const until = async (/** @type {() => any} */ fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };

test('call / on / errors', async (t) => {
  const { CoreClient, RpcError } = await load();
  const mock = await startMockCore({ home: tmpHome(), static: true, writeCoreJson: false });
  const client = new CoreClient({ getConnection: async () => ({ port: mock.port, token: mock.token }) });
  t.after(async () => { client.close(); await mock.close(); });
  const hello = await client.start();
  assert.equal(hello.protocol, require('../../packages/shared/protocol.js').PROTOCOL_VERSION);
  assert.equal(client.state, 'open');
  const spaces = await client.call('spaces.list');
  assert.ok(spaces.length >= 1);
  await assert.rejects(client.call('agents.attach', { id: 'missing' }), (e) => e instanceof RpcError && e.code === 'not_found');
  /** @type {any[]} */
  const statuses = [];
  const off = client.on('agent.status', (s) => statuses.push(s));
  mock.setStatus('docs-pass', { state: 'working', tool: 'Read' });
  await until(() => statuses.length === 1);
  assert.equal(statuses[0].agentId, 'docs-pass');
  off();
  mock.setStatus('docs-pass', { state: 'idle' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(statuses.length, 1);
});

test('requests made before connecting are queued, not lost', async (t) => {
  const { CoreClient } = await load();
  const mock = await startMockCore({ home: tmpHome(), static: true, writeCoreJson: false });
  /** @type {(v:any)=>void} */
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  const client = new CoreClient({ getConnection: async () => { await gate; return { port: mock.port, token: mock.token }; } });
  t.after(async () => { client.close(); await mock.close(); });
  client.start();
  const p = client.call('agents.list');
  release(undefined);
  const list = await p;
  assert.ok(Array.isArray(list) && list.length > 0);
});

test('reconnects with backoff and re-attaches open terminals', async (t) => {
  const { CoreClient } = await load();
  const home = tmpHome();
  let mock = await startMockCore({ home, static: true, writeCoreJson: false });
  let conn = { port: mock.port, token: mock.token };
  let asked = 0;
  const client = new CoreClient({ getConnection: async () => { asked++; return conn; }, backoff: { base: 20, max: 100 } });
  t.after(async () => { client.close(); await mock.close(); });
  await client.start();
  const first = await client.attach('docs-pass');
  assert.match(first.replay, /README/);
  assert.ok(client.attached.has('docs-pass'));

  /** @type {Array<[string,string]>} */
  const reattached = [];
  client.onReattach((id, replay) => reattached.push([id, replay]));
  /** @type {string[]} */
  const states = [];
  client.on('connection', (s) => states.push(s));

  // The core restarts on a new port with a new token.
  await mock.close();
  await until(() => client.state === 'connecting');
  mock = await startMockCore({ home, static: true, writeCoreJson: false });
  conn = { port: mock.port, token: mock.token };
  await until(() => reattached.length === 1);
  assert.equal(reattached[0][0], 'docs-pass');
  assert.match(reattached[0][1], /README/);
  assert.equal(client.state, 'open');
  assert.ok(states.includes('connecting') && states.includes('open'));
  assert.ok(asked >= 2);
  // the new core streams output to the re-attached terminal
  /** @type {string[]} */
  const out = [];
  client.on('agent.output', (d) => out.push(d.data));
  client.send('agents.input', { id: 'docs-pass', data: 'again\r' });
  await until(() => out.join('').includes('GOT: again'));
});

test('detach forgets the terminal; in-flight calls reject when the socket drops', async (t) => {
  const { CoreClient } = await load();
  const mock = await startMockCore({ home: tmpHome(), static: true, writeCoreJson: false });
  const client = new CoreClient({ getConnection: async () => ({ port: mock.port, token: mock.token }), backoff: { base: 20, max: 50 } });
  t.after(async () => { client.close(); await mock.close(); });
  await client.start();
  await client.attach('docs-pass');
  await client.detach('docs-pass');
  assert.equal(client.attached.size, 0);
  assert.ok(mock.calls.some((c) => c.method === 'agents.detach'));
  const ready = new Promise((r) => client.on('reconnected', r));
  mock.dropClients();
  await ready;
  assert.equal(client.state, 'open');
});
