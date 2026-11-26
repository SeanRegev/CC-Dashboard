// @ts-check
'use strict';
// The dev mock core answers agents.approve / agents.deny like the real core (the e2e tests rely on it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMockCore } = require('../../packages/app/src/renderer/dev/mock-core.js');

/** @param {number} port @param {string} token */
async function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${token}`);
  let id = 0;
  /** @type {Map<number, any>} */
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Object.assign(new Error(m.error.message), m.error)) : p.resolve(m.result); }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return {
    ws,
    /** @param {string} method @param {any} [params] @returns {Promise<any>} */
    call: (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); }),
  };
}

async function setup(t) {
  const mock = await startMockCore({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mock-appr-')), static: true });
  const c = await rpc(mock.port, mock.token);
  t.after(async () => { c.ws.close(); await mock.close(); });
  return { mock, c };
}

test('mock: approve presses the key of the asked kind; the prompt is cleared', async (t) => {
  const { mock, c } = await setup(t);
  const prompt = mock.state.agents.get('refactor-auth')?.status.prompt;
  assert.ok(prompt);
  assert.equal(await c.call('agents.approve', { id: 'refactor-auth', promptId: prompt.id, choice: 'allow_always' }), true);
  assert.deepEqual(mock.presses, [{ id: 'refactor-auth', key: '2' }]);
  const st = mock.state.agents.get('refactor-auth')?.status;
  assert.equal(st.state, 'working');
  assert.equal(st.prompt, undefined);
  await assert.rejects(c.call('agents.approve', { id: 'refactor-auth', promptId: prompt.id }), { code: 'no_permission_pending' });
});

test('mock: stale promptId, missing option, bad params and question-only agents are refused, nothing pressed', async (t) => {
  const { mock, c } = await setup(t);
  const e = /** @type {any} */ (mock.state.agents.get('refactor-auth'));
  const old = e.status.prompt;
  e.status.prompt = { ...old, id: 'p-changed', options: old.options.filter((/** @type {any} */ o) => o.kind !== 'allow_always') };
  await assert.rejects(c.call('agents.approve', { id: 'refactor-auth', promptId: old.id }), { code: 'prompt_changed' });
  await assert.rejects(c.call('agents.deny', { id: 'refactor-auth', promptId: old.id }), { code: 'prompt_changed' });
  await assert.rejects(c.call('agents.approve', { id: 'refactor-auth', promptId: 'p-changed', choice: 'allow_always' }), { code: 'bad_request' });
  await assert.rejects(c.call('agents.approve', { id: 'refactor-auth', choice: 'allow_always' }), { code: 'bad_request' });
  await assert.rejects(c.call('agents.approve', { id: 'refactor-auth', promptId: 'p-changed', choice: 'yolo' }), { code: 'bad_request' });
  await assert.rejects(c.call('agents.approve', { id: 'etl-retry', promptId: 'p-x' }), { code: 'no_permission_pending' });
  assert.deepEqual(mock.presses, []);
  assert.equal(await c.call('agents.deny', { id: 'refactor-auth', promptId: 'p-changed' }), true);
  assert.deepEqual(mock.presses, [{ id: 'refactor-auth', key: '\x1b' }]);
  assert.equal(mock.state.agents.get('refactor-auth')?.status.state, 'idle');
});

test('mock: v1 approve (no promptId) still presses 1', async (t) => {
  const { mock, c } = await setup(t);
  assert.equal(await c.call('agents.approve', { id: 'refactor-auth' }), true);
  assert.deepEqual(mock.presses, [{ id: 'refactor-auth', key: '1' }]);
});
