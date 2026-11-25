'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');
const { connect } = require('../../packages/core/src/client');
const { PROTOCOL_VERSION } = require('../../packages/shared/protocol');
const { startCore, tempHome, rmrf, readJson, CORE, claudeCmd } = require('./helpers');

test('core starts, writes core.json and answers /health with the token only', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const info = readJson(path.join(core.home, 'core.json'));
  assert.equal(info.pid, core.proc.pid);
  assert.ok(Number.isInteger(info.port) && info.port > 0);
  assert.match(info.token, /^[0-9a-f]{32,}$/);
  assert.equal(typeof info.version, 'string');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(core.home, 'core.json')).mode & 0o777, 0o600);
  }
  const ok = await fetch(`http://127.0.0.1:${info.port}/health?token=${info.token}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, version: info.version });
  const header = await fetch(`http://127.0.0.1:${info.port}/health`, { headers: { 'x-cc-token': info.token } });
  assert.equal(header.status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${info.port}/health`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${info.port}/health?token=nope`)).status, 401);

  const hello = await core.client.call('hello', { clientName: 'x' });
  assert.deepEqual(hello, { version: info.version, protocol: PROTOCOL_VERSION });
});

test('bad tokens are rejected on the WebSocket and on /hook', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const { port, token } = core.info;
  await assert.rejects(connect({ port, token: 'wrong' }), (e) => e.code === 'unauthorized');
  await assert.rejects(connect({ port, token: token.slice(0, -1) }), (e) => e.code === 'unauthorized');
  // No token at all
  const status = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
    ws.on('unexpected-response', (_q, res) => { resolve(res.statusCode); ws.terminate(); });
    ws.on('error', () => {});
    ws.on('open', () => { resolve(200); ws.close(); });
  });
  assert.equal(status, 401);
  const hook = await fetch(`http://127.0.0.1:${port}/hook?agent=x`, { method: 'POST', headers: { 'x-cc-event': 'Stop' }, body: '{}' });
  assert.equal(hook.status, 401);
  const unknown = await fetch(`http://127.0.0.1:${port}/hook?agent=nobody&token=${token}`, { method: 'POST', headers: { 'x-cc-event': 'Stop' }, body: '{}' });
  assert.equal(unknown.status, 404);
});

test('a second core on the same home exits cleanly and leaves core.json alone', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const before = fs.readFileSync(path.join(core.home, 'core.json'), 'utf8');
  const r = spawnSync(process.execPath, [CORE], { env: { ...process.env, CC_HOME: core.home, CC_CLAUDE: claudeCmd() }, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already running/);
  assert.equal(fs.readFileSync(path.join(core.home, 'core.json'), 'utf8'), before);
  assert.deepEqual(await core.client.call('spaces.list'), []); // first core still serves
});

test('a stale core.json (dead pid) is taken over', async (t) => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, 'core.json'), JSON.stringify({ port: 1, token: 'old', pid: 999999, version: '0' }));
  fs.writeFileSync(path.join(home, 'core.lock'), '999999');
  const core = await startCore({ home });
  t.after(async () => { await core.stop(); rmrf(home); });
  assert.equal(readJson(path.join(home, 'core.json')).pid, core.proc.pid);
});

test('core.json is removed on a clean shutdown', { skip: process.platform === 'win32' && 'no SIGTERM on Windows' }, async (t) => {
  const core = await startCore();
  t.after(() => rmrf(core.home));
  const { code } = await core.stop('SIGTERM');
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(core.home, 'core.json')), false);
});

test('RPC errors: unknown method, bad params, unknown ids', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const c = core.client;
  await assert.rejects(c.call('nope.method'), { code: 'bad_request' });
  await assert.rejects(c.call('spaces.add', {}), { code: 'bad_request' });
  await assert.rejects(c.call('spaces.add', { path: path.join(core.home, 'does-not-exist') }), { code: 'bad_request' });
  await assert.rejects(c.call('spaces.remove', { id: 'nope' }), { code: 'not_found' });
  await assert.rejects(c.call('agents.create', { spaceId: 'nope', name: 'a' }), { code: 'not_found' });
  for (const m of ['agents.stop', 'agents.resume', 'agents.remove', 'agents.attach', 'agents.detach', 'agents.approve', 'agents.deny']) {
    await assert.rejects(c.call(m, { id: 'ghost' }), { code: 'not_found' }, m);
  }
  await assert.rejects(c.call('agents.input', { id: 'ghost', data: 'x' }), { code: 'not_found' });
  await assert.rejects(c.call('agents.send', { id: 'ghost', text: 'x' }), { code: 'not_found' });
  await assert.rejects(c.call('agents.resize', { id: 'ghost', cols: 80, rows: 24 }), { code: 'not_found' });
});

test('spaces: add, list, dedupe by path, unique ids, remove, space.changed events', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const c = core.client;
  const changes = core.collect('space.changed');
  const a = await core.space('My Project');
  assert.equal(a.id, 'my-project');
  assert.equal(a.name, 'My Project');
  assert.equal(a.path, path.join(core.home, 'My Project'));
  assert.ok(a.createdAt > 0);
  const again = await c.call('spaces.add', { path: a.path });
  assert.deepEqual(again, a);
  fs.mkdirSync(path.join(core.home, 'other'));
  const b = await c.call('spaces.add', { path: path.join(core.home, 'other'), name: 'My Project' });
  assert.equal(b.id, 'my-project-2');
  assert.deepEqual((await c.call('spaces.list')).map((s) => s.id), ['my-project', 'my-project-2']);
  assert.equal(await c.call('spaces.remove', { id: a.id }), true);
  assert.deepEqual((await c.call('spaces.list')).map((s) => s.id), ['my-project-2']);
  assert.equal(changes.length, 3);
  assert.deepEqual(changes[2].spaces.map((s) => s.id), ['my-project-2']);
});

test('client.startCore starts a detached core once, and findCore finds it', async (t) => {
  const { startCore: launch, findCore } = require('../../packages/core/src/client');
  const home = tempHome();
  const env = { ...process.env, CC_CLAUDE: claudeCmd() };
  assert.equal(await findCore(home), null);
  const info = await launch({ home, env });
  t.after(async () => {
    try { process.kill(info.pid); } catch { /* gone */ }
    const { pidAlive } = require('../../packages/core/src/index');
    const { waitFor } = require('./helpers');
    await waitFor(() => !pidAlive(info.pid), { what: 'core exit' });
    rmrf(home);
  });
  assert.equal((await findCore(home)).pid, info.pid);
  const again = await launch({ home, env });
  assert.equal(again.pid, info.pid);
  const c = await connect({ home, clientName: 'app' });
  assert.deepEqual(await c.call('spaces.list'), []);
  c.close();
});
