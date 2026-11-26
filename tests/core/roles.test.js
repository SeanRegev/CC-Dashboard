'use strict';
// Session roles (👑 Main, 🔧 Worker, ...), agents.update, agents.restart and core.shutdown (protocol v2).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROLES } = require('../../packages/shared/protocol');
const { normalizeRole } = require('../../packages/core/src/core');
const { startCore, tempHome, rmrf, waitFor, argvLog, readJson, claudeCmd, FIXTURES } = require('./helpers');

const WRAPPED = claudeCmd(path.join(FIXTURES, 'wrapped-claude.js'));

const roleIds = async (core) => Object.fromEntries((await core.client.call('agents.list')).map((r) => [r.agent.name, r.agent.role.id]));

test('normalizeRole: built-in ids get label and emoji, custom needs a label, junk is refused', () => {
  assert.deepEqual(normalizeRole({ id: 'main' }), { id: 'main', label: 'Main', emoji: '👑' });
  assert.deepEqual(normalizeRole({ id: 'tests', label: 'E2E' }), { id: 'tests', label: 'E2E', emoji: '🧪' });
  assert.deepEqual(normalizeRole({ id: 'custom', label: '  Release captain ', emoji: '🚀' }), { id: 'custom', label: 'Release captain', emoji: '🚀' });
  assert.equal(normalizeRole({ id: 'custom', label: '' }), null);
  assert.equal(normalizeRole({ id: 'boss' }), null);
  assert.equal(normalizeRole('main'), null);
  assert.equal(normalizeRole({ id: 'custom', label: 'x'.repeat(100) }).label.length, 24);
  assert.equal(ROLES[0].id, 'main');
});

test('the first agent of a space is Main, later ones Worker; a chosen role is kept', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const a = await core.space('a');
  const b = await core.space('b');
  const first = await core.client.call('agents.create', { spaceId: a.id, name: 'first' });
  assert.deepEqual(first.role, { id: 'main', label: 'Main', emoji: '👑' });
  const second = await core.client.call('agents.create', { spaceId: a.id, name: 'second' });
  assert.equal(second.role.id, 'worker');
  const rev = await core.client.call('agents.create', { spaceId: a.id, name: 'rev', role: { id: 'reviewer' } });
  assert.deepEqual(rev.role, { id: 'reviewer', label: 'Reviewer', emoji: '🔍' });
  const other = await core.client.call('agents.create', { spaceId: b.id, name: 'other' });
  assert.equal(other.role.id, 'main', 'Main is per space');
  await assert.rejects(core.client.call('agents.create', { spaceId: a.id, name: 'bad', role: { id: 'boss' } }), { code: 'bad_request' });
});

test('agents.update: rename, custom role, moving Main demotes the old Main; events for both', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const sp = await core.space();
  const m = await core.client.call('agents.create', { spaceId: sp.id, name: 'm' });
  const w = await core.client.call('agents.create', { spaceId: sp.id, name: 'w' });
  const updates = core.collect('agent.updated');

  const renamed = await core.client.call('agents.update', { id: w.id, name: '  builder ', role: { id: 'custom', label: 'Builder', emoji: '🏗️' } });
  assert.equal(renamed.name, 'builder');
  assert.deepEqual(renamed.role, { id: 'custom', label: 'Builder', emoji: '🏗️' });

  await core.client.call('agents.update', { id: w.id, role: { id: 'main' } });
  assert.deepEqual(await roleIds(core), { m: 'worker', builder: 'main' });
  await waitFor(() => updates.some((u) => u.agent.id === m.id && u.agent.role.id === 'worker'), { what: 'agent.updated for the old Main' });

  // Taking Main away from the only Main hands it to the oldest other agent.
  await core.client.call('agents.update', { id: w.id, role: { id: 'docs' } });
  assert.deepEqual(await roleIds(core), { m: 'main', builder: 'docs' });

  await assert.rejects(core.client.call('agents.update', { id: m.id, name: '   ' }), { code: 'bad_request' });
  await assert.rejects(core.client.call('agents.update', { id: 'nope', name: 'x' }), { code: 'not_found' });
  // Saved: the state file has the roles.
  await waitFor(() => {
    const st = readJson(path.join(core.home, 'state.json'));
    return st && st.agents.find((a) => a.id === w.id).role.id === 'docs';
  }, { what: 'roles on disk' });
});

test('removing the Main promotes the oldest remaining agent', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const sp = await core.space();
  const m = await core.client.call('agents.create', { spaceId: sp.id, name: 'm' });
  await core.client.call('agents.create', { spaceId: sp.id, name: 'older' });
  await core.client.call('agents.create', { spaceId: sp.id, name: 'newer' });
  await core.client.call('agents.remove', { id: m.id });
  assert.deepEqual(await roleIds(core), { older: 'main', newer: 'worker' });
});

test('state from before roles: on load every agent gets a role and each space exactly one Main', async (t) => {
  const home = tempHome();
  t.after(() => rmrf(home));
  const now = Date.now();
  fs.mkdirSync(home, { recursive: true });
  const agent = (id, spaceId, createdAt, extra = {}) => ({ id, spaceId, name: id, cwd: home, sessionId: `00000000-0000-4000-8000-00000000000${id.length}`, createdAt, ...extra });
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
    version: 1,
    spaces: [{ id: 's1', name: 's1', path: home, createdAt: now }, { id: 's2', name: 's2', path: home, createdAt: now }],
    agents: [
      agent('young', 's1', now - 1000), agent('old', 's1', now - 5000),
      agent('two-mains-a', 's2', now - 3000, { role: { id: 'main', label: 'Main', emoji: '👑' } }),
      agent('two-mains-b', 's2', now - 2000, { role: { id: 'main', label: 'Main', emoji: '👑' } }),
    ],
    status: {}, runtime: {},
  }));
  const core = await startCore({ home });
  t.after(() => core.stop());
  assert.deepEqual(await roleIds(core), { young: 'worker', old: 'main', 'two-mains-a': 'main', 'two-mains-b': 'worker' });
});

test('agents.restart stops and resumes the same conversation', async (t) => {
  const core = await startCore({ claude: WRAPPED });
  t.after(() => core.dispose());
  const sp = await core.space();
  const a = await core.client.call('agents.create', { spaceId: sp.id, name: 'a', prompt: 'hi' });
  await core.waitStatus(a.id, (s) => s.state === 'idle' && s.running, 'idle');
  const exits = core.collect('agent.exit');
  assert.equal(await core.client.call('agents.restart', { id: a.id }), true);
  await waitFor(() => exits.length === 1, { what: 'the old process exits' });
  await core.waitStatus(a.id, (s) => s.running, 'running again');
  // Launched twice: first with --session-id, then with --resume or the same --session-id.
  const runs = argvLog(core.home);
  assert.equal(runs.length, 2);
  const sid = runs[0][runs[0].indexOf('--session-id') + 1];
  assert.ok(runs[1].includes(sid), 'the restart uses the same session id');
});

test('core.shutdown stops the agents, saves, and the core exits', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const sp = await core.space();
  const a = await core.client.call('agents.create', { spaceId: sp.id, name: 'a' });
  await core.waitStatus(a.id, (s) => s.running, 'running');
  assert.equal(await core.client.call('core.shutdown', {}), true);
  const res = await Promise.race([core.exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
  assert.notEqual(res, 'timeout', 'the core process exited');
  const st = readJson(path.join(core.home, 'state.json'));
  assert.ok(st.agents.some((x) => x.id === a.id), 'records kept');
});
