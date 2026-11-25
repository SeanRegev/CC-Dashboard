'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startCore, claudeCmd, waitFor, postHook, FIXTURES } = require('./helpers');
const { STUCK_MESSAGE } = require('../../packages/core/src/core');

/** An agent whose first prompt makes the fake show a permission prompt. */
async function permissionAgent(core, name = 'Perm') {
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name, prompt: 'needs permission please' });
  const s = await core.waitStatus(agent.id, (x) => x.state === 'needs_you' && x.permission === true, 'permission prompt');
  return { agent, s };
}

test('permission prompt -> needs_you with permission=true, message and a notify event', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const notes = core.collect('notify');
  const { agent, s } = await permissionAgent(core);
  assert.equal(s.message, 'Wants to use Bash: npm test');
  assert.equal(s.tool, 'Bash');
  assert.ok(s.needsSince > 0);
  await waitFor(() => notes.length >= 1, { what: 'notify' });
  assert.deepEqual(notes[0], { title: 'Perm needs you', body: 'Wants to use Bash: npm test', agentId: agent.id });
  // The fake's follow-up Notification does not notify a second time.
  await core.client.call('agents.list');
  assert.equal(notes.length, 1);
});

test('approve presses 1 -> working; a late "needs your permission" Notification is ignored', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const { agent } = await permissionAgent(core);
  const output = core.collect('agent.output');
  await core.client.call('agents.attach', { id: agent.id });
  assert.equal(await core.client.call('agents.approve', { id: agent.id }), true);
  let s = await core.status(agent.id);
  assert.equal(s.state, 'working');
  assert.equal(s.permission, undefined);
  assert.equal(s.message, '');
  // The hook is applied before the HTTP reply, so the status can be checked right after.
  assert.equal(await postHook(core, agent.id, 'Notification', { message: 'Claude needs your permission to use Bash' }), 200);
  s = await core.status(agent.id);
  assert.equal(s.state, 'working');
  // The idle reminder never counts as needing you either.
  await postHook(core, agent.id, 'Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
  assert.equal((await core.status(agent.id)).state, 'working');
  // But a genuinely new notification does.
  await postHook(core, agent.id, 'Notification', { message: 'Claude needs you to pick an option' });
  s = await core.status(agent.id);
  assert.equal(s.state, 'needs_you');
  assert.equal(s.message, 'Claude needs you to pick an option');
  // The "1" reached the terminal (echoed by the tty).
  await waitFor(() => output.map((o) => o.data).join('').includes('1'), { what: 'key 1 echoed' });
});

test('deny presses Escape -> idle', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const { agent } = await permissionAgent(core);
  assert.equal(await core.client.call('agents.deny', { id: agent.id }), true);
  const s = await core.status(agent.id);
  assert.equal(s.state, 'idle');
  assert.equal(s.permission, undefined);
  await assert.rejects(core.client.call('agents.deny', { id: agent.id }), { code: 'no_permission_pending' });
  await assert.rejects(core.client.call('agents.approve', { id: agent.id }), { code: 'no_permission_pending' });
});

test('approve with nothing pending is refused', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'a', prompt: 'just work' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 1);
  await assert.rejects(core.client.call('agents.approve', { id: agent.id }), { code: 'no_permission_pending' });
});

test('a permission prompt answered inside the terminal is noticed from the screen', async (t) => {
  const core = await startCore({ claude: claudeCmd(path.join(FIXTURES, 'perm-claude.js')), env: { CC_PROMPT_GONE_MS: '300' } });
  t.after(() => core.dispose());
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'a' });
  await core.waitStatus(agent.id, (x) => x.state === 'needs_you' && x.permission === true, 'permission prompt');
  // While the prompt is on screen it stays needs_you, well past the grace period.
  await waitFor(async () => (await core.replay(agent.id)).includes('Esc to cancel'), { what: 'prompt drawn' });
  const since = Date.now();
  await waitFor(() => Date.now() - since > 800, { what: 'grace period' });
  assert.equal((await core.status(agent.id)).state, 'needs_you');
  // The user presses Esc in the terminal: no hook fires, only the screen changes.
  await core.client.call('agents.input', { id: agent.id, data: '\x1b' });
  const s = await core.waitStatus(agent.id, (x) => x.state === 'idle', 'idle after answering in terminal');
  assert.equal(s.permission, undefined);
  // A late permission Notification after that is stale.
  await postHook(core, agent.id, 'Notification', { message: 'Claude needs your permission to use Bash' });
  assert.equal((await core.status(agent.id)).state, 'idle');
});

test('stuck on a setup screen: no hook after launch -> needs_you with a message, then recovers on a hook', async (t) => {
  const core = await startCore({ claude: claudeCmd(path.join(FIXTURES, 'silent-claude.js')), env: { CC_STUCK_MS: '400' } });
  t.after(() => core.dispose());
  const notes = core.collect('notify');
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'Stuck', prompt: 'hello' });
  assert.equal((await core.status(agent.id)).state, 'starting');
  const s = await core.waitStatus(agent.id, (x) => x.state === 'needs_you', 'stuck detection');
  assert.equal(s.message, STUCK_MESSAGE);
  assert.notEqual(s.permission, true);
  await waitFor(() => notes.length >= 1, { what: 'notify' });
  assert.equal(notes[0].title, 'Stuck needs you');
  await assert.rejects(core.client.call('agents.approve', { id: agent.id }), { code: 'no_permission_pending' });
  // Once the user gets past the screen, Claude fires SessionStart.
  await postHook(core, agent.id, 'SessionStart', { source: 'startup' });
  assert.equal((await core.status(agent.id)).state, 'idle');
});
