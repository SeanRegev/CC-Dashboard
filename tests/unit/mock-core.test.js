// @ts-check
'use strict';
// The dev mock core speaks the protocol the app is built against.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { METHODS, PROTOCOL_VERSION } = require('../../packages/shared/protocol.js');
const { startMockCore } = require('../../packages/app/src/renderer/dev/mock-core.js');
const { checkHealth, readCoreJson } = require('../../packages/app/src/main/core-launcher.js');

/** @param {number} port @param {string} token */
function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${token}`);
  let id = 0;
  /** @type {Map<number, any>} */
  const pending = new Map();
  /** @type {any[]} */
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Object.assign(new Error(m.error.message), m.error)) : p.resolve(m.result); }
    else if (m.event) events.push(m);
  };
  const open = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return {
    open, events, ws,
    /** @param {string} method @param {any} [params] @returns {Promise<any>} */
    call: (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); }),
  };
}

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mock-'));
const until = async (/** @type {() => any} */ fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };

test('mock core writes core.json, answers /health with the token, rejects without it', async (t) => {
  const home = tmpHome();
  const mock = await startMockCore({ home, static: true });
  t.after(() => mock.close());
  const info = readCoreJson(home);
  assert.ok(info);
  assert.equal(info.port, mock.port);
  assert.equal(info.pid, process.pid);
  assert.deepEqual(await checkHealth(info), { ok: true, version: 'mock-0.1.0' });
  assert.equal(await checkHealth({ port: mock.port, token: 'wrong' }), null);
  const bad = new WebSocket(`ws://127.0.0.1:${mock.port}/rpc?token=wrong`);
  await new Promise((resolve) => { bad.onerror = resolve; bad.onclose = resolve; });
  assert.notEqual(bad.readyState, WebSocket.OPEN);
});

test('mock core implements every protocol method', async (t) => {
  const mock = await startMockCore({ home: tmpHome(), static: true });
  t.after(() => mock.close());
  const c = rpc(mock.port, mock.token);
  await c.open;
  t.after(() => c.ws.close());
  assert.deepEqual(await c.call('hello', { clientName: 't' }), { version: 'mock-0.1.0', protocol: PROTOCOL_VERSION });
  for (const m of METHODS) {
    try { await c.call(m, { id: 'docs-pass', path: os.tmpdir(), spaceId: 'cc-dashboard', name: 'x', data: '', text: '', cols: 80, rows: 24 }); }
    catch (e) { assert.notEqual(/** @type {any} */ (e).code, 'bad_request', `${m} unknown to the mock`); }
  }
});

test('attach replays scrollback, input echoes, output only reaches attached clients', async (t) => {
  const mock = await startMockCore({ home: tmpHome(), static: true });
  t.after(() => mock.close());
  const a = rpc(mock.port, mock.token);
  const b = rpc(mock.port, mock.token);
  await Promise.all([a.open, b.open]);
  t.after(() => { a.ws.close(); b.ws.close(); });
  const list = await a.call('agents.list');
  assert.ok(list.length >= 5);
  assert.ok(list.some((/** @type {any} */ e) => e.status.state === 'needs_you'));
  const { replay } = await a.call('agents.attach', { id: 'docs-pass' });
  assert.match(replay, /Update the README/);
  await a.call('agents.input', { id: 'docs-pass', data: 'hi\r' });
  await until(() => a.events.some((e) => e.event === 'agent.output' && /GOT: hi/.test(e.data.data)));
  assert.ok(!b.events.some((e) => e.event === 'agent.output'));
  assert.deepEqual(mock.inputs, ['hi\r']);
  // stopped agents refuse input
  await assert.rejects(a.call('agents.input', { id: 'old-spike', data: 'x' }), /not running/);
  await assert.rejects(a.call('agents.attach', { id: 'nope' }), (e) => /** @type {any} */ (e).code === 'not_found');
});

test('create, status events and notify', async (t) => {
  const mock = await startMockCore({ home: tmpHome(), static: true });
  t.after(() => mock.close());
  const c = rpc(mock.port, mock.token);
  await c.open;
  t.after(() => c.ws.close());
  const agent = await c.call('agents.create', { spaceId: 'storefront', name: 'New One' });
  assert.equal(agent.id, 'new-one');
  assert.equal(agent.spaceId, 'storefront');
  await until(() => c.events.some((e) => e.event === 'agent.created' && e.data.agent.id === 'new-one'));
  await until(() => c.events.some((e) => e.event === 'agent.status' && e.data.agentId === 'new-one' && e.data.state === 'idle'));
  mock.setStatus('new-one', { state: 'needs_you', message: 'Pick one' });
  await until(() => c.events.some((e) => e.event === 'notify' && e.data.agentId === 'new-one'));
  const sp = await c.call('spaces.add', { path: path.join(os.tmpdir(), 'My Project') });
  assert.equal(sp.id, 'my-project');
  await until(() => c.events.some((e) => e.event === 'space.changed'));
});

test('mock core v4: usage.get seeds, usage fields on statuses, subagent models', async (t) => {
  const home = tmpHome();
  const mock = await startMockCore({ home, static: true });
  const high = await startMockCore({ home: tmpHome(), static: true, usage: 'high', writeCoreJson: false });
  const none = await startMockCore({ home: tmpHome(), static: true, usage: 'none', writeCoreJson: false });
  t.after(() => Promise.all([mock.close(), high.close(), none.close()]));
  const c = rpc(mock.port, mock.token);
  await c.open;
  t.after(() => c.ws.close());
  const u = await c.call('usage.get');
  assert.equal(u.limits.fiveHour.usedPct, 62);
  assert.equal(u.limits.sevenDay.usedPct, 31);
  assert.ok(u.limits.fiveHour.resetsAt > Date.now(), 'resetsAt is ms epoch in the future');
  assert.equal(u.limits.fromAgentId, 'fix-flaky-tests');
  assert.ok(u.byAgent['refactor-auth'].costUsd > 0 && u.byAgent['refactor-auth'].name === 'refactor-auth');
  assert.ok(u.byAgent['old-migration'], 'a removed agent keeps its totals');
  assert.ok(u.bySpace['cc-dashboard'].inputTokens > 0);
  assert.ok(Object.keys(u.byDay).every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)) && Object.keys(u.byDay).length >= 3);
  const list = await c.call('agents.list');
  const fix = list.find((/** @type {any} */ e) => e.agent.id === 'fix-flaky-tests').status.usage;
  assert.equal(fix.source, 'statusline');
  assert.equal(fix.contextWindow, 1_000_000);
  assert.equal(fix.context, Math.round(1_000_000 * fix.contextPct / 100));
  assert.equal(typeof fix.costUsd, 'number');
  assert.equal(list.find((/** @type {any} */ e) => e.agent.id === 'old-spike').status.usage.source, 'transcript');
  const subs = await c.call('subagents.list', { agentId: 'fix-flaky-tests' });
  assert.equal(subs.find((/** @type {any} */ s) => s.type === 'Explore').model, 'claude-haiku-4-5-20251001');
  assert.ok(subs.every((/** @type {any} */ s) => typeof s.model === 'string' && s.model));
  assert.equal(high.usage.usage.limits.fiveHour.usedPct, 93);
  assert.equal(none.usage.usage.limits.updatedAt, 0);
  assert.equal(none.usage.usage.limits.fiveHour, undefined);
  // setLimits broadcasts usage.changed
  mock.usage.setLimits({ fiveHour: { usedPct: 91, resetsAt: Date.now() + 60e3 }, updatedAt: Date.now() });
  const ev = await until(() => c.events.find((e) => e.event === 'usage.changed'));
  assert.equal(ev.data.usage.limits.fiveHour.usedPct, 91);
});
