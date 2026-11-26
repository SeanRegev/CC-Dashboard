// @ts-check
'use strict';
// agents.approve / agents.deny v2 against the fake Claude drawing real prompt layouts
// (tests/fixtures/prompts). The fake logs every key it receives, so "no key was sent" is checked
// for real, not inferred from the status.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startCore, waitFor, postHook } = require('./helpers');

/** Keys the fake received, one entry per chunk. @param {any} core @param {any} agent @returns {string[]} */
function keys(core, agent) {
  try {
    return fs.readFileSync(path.join(core.home, `keys-${agent.sessionId}.log`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Long enough for a key in flight to reach the fake and be logged. */
const settle = () => new Promise((r) => setTimeout(r, 400));

/** An agent showing the given layout(s), once status.prompt has been read off its screen. */
async function promptAgent(core, layouts, name = 'agent', extra = '') {
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name, prompt: `please layout:${layouts} ${extra}`.trim() });
  const s = await core.waitStatus(agent.id, (x) => x.state === 'needs_you' && x.permission === true && x.prompt, 'status.prompt');
  return { agent, s, prompt: s.prompt };
}

const screenHas = (core, agent, text) => waitFor(async () => (await core.replay(agent.id)).includes(text), { what: `screen shows ${text}` });

test('status.prompt is read off the screen: tool, detail, question, options by kind', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const { s, prompt } = await promptAgent(core, 'bash-4opt');
  assert.equal(s.tool, 'Bash');
  assert.equal(prompt.tool, 'Bash');
  assert.equal(prompt.detail, 'npm test 2>&1 | tail -80');
  assert.equal(prompt.question, 'Do you want to proceed?');
  assert.deepEqual(prompt.options.map((/** @type {any} */ o) => [o.key, o.kind]), [['1', 'allow'], ['2', 'allow_always'], ['3', 'allow_other'], ['4', 'deny']]);
  assert.match(prompt.id, /^p-[0-9a-f]{24}$/);
});

test('allow presses the "Yes" key; the prompt is cleared from the status', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const { agent, prompt } = await promptAgent(core, 'bash-4opt');
  assert.equal(await core.client.call('agents.approve', { id: agent.id, promptId: prompt.id }), true);
  const s = await core.status(agent.id);
  assert.equal(s.state, 'working');
  assert.equal(s.prompt, undefined);
  assert.equal(s.permission, undefined);
  await screenHas(core, agent, 'CHOSE: 1');
  await settle();
  assert.deepEqual(keys(core, agent), ['1']);
  await core.waitStatus(agent.id, (x) => x.state === 'idle', 'idle after the fake ran the tool');
});

test('allow_always picks "don\'t ask again" by wording: option 2 of 4, 2 of 3 on an edit, never auto mode', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  for (const [layout, label] of [['bash-4opt', "Yes, and don't ask again for: npm test *"], ['edit', 'Yes, allow all edits during this session (shift+tab)'],
    ['bash-wrapped', 'Yes, and always allow access to /home/user/claudeultimatedeck from this project']]) {
    const { agent, prompt } = await promptAgent(core, layout, `always-${layout}`);
    assert.equal(prompt.options.find((/** @type {any} */ o) => o.kind === 'allow_always').label, label);
    assert.equal(await core.client.call('agents.approve', { id: agent.id, promptId: prompt.id, choice: 'allow_always' }), true);
    await screenHas(core, agent, 'CHOSE: 2');
    await settle();
    assert.deepEqual(keys(core, agent), ['2'], layout);
  }
});

test('allow_always on a prompt without that option is refused, and nothing else is pressed', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const { agent, prompt } = await promptAgent(core, 'bash-3opt');
  assert.equal(prompt.options.some((/** @type {any} */ o) => o.kind === 'allow_always'), false);
  await assert.rejects(core.client.call('agents.approve', { id: agent.id, promptId: prompt.id, choice: 'allow_always' }), { code: 'bad_request' });
  // Without a promptId the core can't know which option it would be: refused too, never "1".
  await assert.rejects(core.client.call('agents.approve', { id: agent.id, choice: 'allow_always' }), { code: 'bad_request' });
  await settle();
  assert.deepEqual(keys(core, agent), []);
  const s = await core.status(agent.id);
  assert.equal(s.state, 'needs_you');
  assert.equal(s.prompt.id, prompt.id);
});

test('a stale or made-up promptId is refused with prompt_changed and no key is sent', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const { agent, prompt } = await promptAgent(core, 'bash-4opt');
  for (const promptId of ['p-000000000000000000000000', `${prompt.id}x`, prompt.id.toUpperCase()]) {
    await assert.rejects(core.client.call('agents.approve', { id: agent.id, promptId }), { code: 'prompt_changed' });
    await assert.rejects(core.client.call('agents.deny', { id: agent.id, promptId }), { code: 'prompt_changed' });
  }
  await settle();
  assert.deepEqual(keys(core, agent), []);
  assert.equal((await core.status(agent.id)).state, 'needs_you');
});

test('the prompt changed between render and click: refused, even before the status caught up', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const { agent, prompt } = await promptAgent(core, 'bash-4opt,edit');
  await core.client.call('agents.input', { id: agent.id, data: '~' }); // Claude now asks about an edit
  await screenHas(core, agent, 'Do you want to make this edit to app.js?');
  await assert.rejects(core.client.call('agents.approve', { id: agent.id, promptId: prompt.id }), { code: 'prompt_changed' });
  await assert.rejects(core.client.call('agents.approve', { id: agent.id, promptId: prompt.id, choice: 'allow_always' }), { code: 'prompt_changed' });
  await assert.rejects(core.client.call('agents.deny', { id: agent.id, promptId: prompt.id }), { code: 'prompt_changed' });
  // The status now shows the new prompt, which can be answered.
  const s = await core.waitStatus(agent.id, (x) => x.prompt && x.prompt.id !== prompt.id, 'new prompt');
  assert.equal(s.prompt.tool, 'Edit');
  assert.equal(s.prompt.detail, 'src/app.js');
  await settle();
  assert.deepEqual(keys(core, agent), ['~']);
  assert.equal(await core.client.call('agents.approve', { id: agent.id, promptId: s.prompt.id }), true);
  await screenHas(core, agent, 'CHOSE: 1');
});

test('the same prompt asked again (a new PermissionRequest) gets a new id; the old one is refused', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const { agent, prompt } = await promptAgent(core, 'bash-4opt');
  await core.client.call('agents.input', { id: agent.id, data: '!' });
  const s = await core.waitStatus(agent.id, (x) => x.prompt && x.prompt.id !== prompt.id, 'new id for the repeated prompt');
  assert.equal(s.prompt.detail, prompt.detail);
  assert.deepEqual(s.prompt.options, prompt.options);
  await assert.rejects(core.client.call('agents.approve', { id: agent.id, promptId: prompt.id }), { code: 'prompt_changed' });
  await settle();
  assert.deepEqual(keys(core, agent), ['!']);
});

test('an unreadable prompt: permission without status.prompt; promptIds are refused, v1 approve still presses 1', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  // The fake's old minimal dialog (no header) and a dialog with two "Yes" options.
  const space = await core.space();
  const old = await core.client.call('agents.create', { spaceId: space.id, name: 'old', prompt: 'needs permission please' });
  await core.waitStatus(old.id, (x) => x.state === 'needs_you' && x.permission === true, 'permission');
  const ambiguous = await core.client.call('agents.create', { spaceId: space.id, name: 'ambiguous', prompt: 'please layout:bad-two-yes' });
  await core.waitStatus(ambiguous.id, (x) => x.state === 'needs_you' && x.permission === true, 'permission');
  await screenHas(core, ambiguous, 'rm -rf build');
  await new Promise((r) => setTimeout(r, 300)); // several ticks and screen reads
  for (const a of [old, ambiguous]) {
    const s = await core.status(a.id);
    assert.equal(s.permission, true);
    assert.equal(s.prompt, undefined, a.name);
    await assert.rejects(core.client.call('agents.approve', { id: a.id, promptId: 'p-anything' }), { code: 'prompt_changed' });
    await assert.rejects(core.client.call('agents.approve', { id: a.id, choice: 'allow_always' }), { code: 'bad_request' });
  }
  await settle();
  assert.deepEqual(keys(core, ambiguous), []);
  assert.equal(await core.client.call('agents.approve', { id: ambiguous.id }), true); // v1 behaviour
  await waitFor(() => keys(core, ambiguous).length === 1, { what: 'v1 key' });
  assert.deepEqual(keys(core, ambiguous), ['1']);
});

test('two agents prompting at once do not cross', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const a = await promptAgent(core, 'bash-4opt', 'alpha');
  const b = await promptAgent(core, 'bash-4opt', 'beta'); // same prompt text on both screens
  assert.notEqual(a.prompt.id, b.prompt.id);
  await assert.rejects(core.client.call('agents.approve', { id: a.agent.id, promptId: b.prompt.id }), { code: 'prompt_changed' });
  await assert.rejects(core.client.call('agents.deny', { id: b.agent.id, promptId: a.prompt.id }), { code: 'prompt_changed' });
  assert.equal(await core.client.call('agents.approve', { id: b.agent.id, promptId: b.prompt.id, choice: 'allow_always' }), true);
  await screenHas(core, b.agent, 'CHOSE: 2');
  await settle();
  assert.deepEqual(keys(core, a.agent), []);
  assert.deepEqual(keys(core, b.agent), ['2']);
  assert.equal((await core.status(a.agent.id)).prompt.id, a.prompt.id);
  assert.equal(await core.client.call('agents.approve', { id: a.agent.id, promptId: a.prompt.id }), true);
  await screenHas(core, a.agent, 'CHOSE: 1');
  await settle();
  assert.deepEqual(keys(core, a.agent), ['1']);
  assert.deepEqual(keys(core, b.agent), ['2']);
});

test('deny sends Escape after the same check -> idle, prompt cleared', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const { agent, prompt } = await promptAgent(core, 'mcp');
  assert.equal(prompt.tool, 'mcp__github__create_issue');
  assert.equal(await core.client.call('agents.deny', { id: agent.id, promptId: prompt.id }), true);
  const s = await core.status(agent.id);
  assert.equal(s.state, 'idle');
  assert.equal(s.prompt, undefined);
  await screenHas(core, agent, 'DENIED');
  await settle();
  assert.deepEqual(keys(core, agent), ['\x1b']);
  await assert.rejects(core.client.call('agents.deny', { id: agent.id, promptId: prompt.id }), { code: 'no_permission_pending' });
});

test('a double click answers once', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const { agent, prompt } = await promptAgent(core, 'fetch');
  const results = await Promise.allSettled([
    core.client.call('agents.approve', { id: agent.id, promptId: prompt.id }),
    core.client.call('agents.approve', { id: agent.id, promptId: prompt.id }),
    core.client.call('agents.deny', { id: agent.id, promptId: prompt.id }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results));
  for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.code, 'no_permission_pending');
  await settle();
  assert.equal(keys(core, agent).length, 1);
});

test('the prompt leaves the screen (answered in the terminal): status.prompt is cleared', async (t) => {
  const core = await startCore({ env: { CC_PROMPT_GONE_MS: '60000' } });
  t.after(() => core.dispose());
  const { agent, prompt } = await promptAgent(core, 'create');
  await core.client.call('agents.input', { id: agent.id, data: '\x1b' }); // no hook fires for this
  const s = await core.waitStatus(agent.id, (x) => !x.prompt, 'prompt cleared');
  assert.equal(s.state, 'needs_you'); // still waiting until the prompt-gone timer decides
  await assert.rejects(core.client.call('agents.approve', { id: agent.id, promptId: prompt.id }), { code: 'prompt_changed' });
});

test('older Claude (Notification only, no PermissionRequest): the prompt is still read and answerable', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const { agent, s, prompt } = await promptAgent(core, 'edit', 'legacy', 'nohook');
  assert.match(s.message, /needs your permission/);
  assert.equal(prompt.tool, 'Edit');
  assert.equal(await core.client.call('agents.approve', { id: agent.id, promptId: prompt.id, choice: 'allow_always' }), true);
  await screenHas(core, agent, 'CHOSE: 2');
});

test('bad params are refused before anything is pressed', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const { agent, prompt } = await promptAgent(core, 'bash-4opt');
  for (const params of [{ id: agent.id, promptId: prompt.id, choice: 'allow_other' }, { id: agent.id, promptId: prompt.id, choice: 'deny' },
    { id: agent.id, promptId: 5 }, { id: agent.id, promptId: '' }, { id: agent.id, choice: '1' }]) {
    await assert.rejects(core.client.call('agents.approve', params), { code: 'bad_request' }, JSON.stringify(params));
  }
  await assert.rejects(core.client.call('agents.deny', { id: agent.id, promptId: {} }), { code: 'bad_request' });
  await assert.rejects(core.client.call('agents.approve', { id: 'nobody', promptId: prompt.id }), { code: 'not_found' });
  await settle();
  assert.deepEqual(keys(core, agent), []);
});

test('notify carries kind: needs_you, done', async (t) => {
  const core = await startCore({ env: { CC_LONG_TURN_MS: '0' } });
  t.after(() => core.dispose());
  const notes = core.collect('notify');
  const { agent } = await promptAgent(core, 'bash-3opt', 'kinds');
  await waitFor(() => notes.some((n) => n.kind === 'needs_you' && n.agentId === agent.id), { what: 'needs_you notify' });
  await postHook(core, agent.id, 'UserPromptSubmit', { prompt: 'go' });
  await postHook(core, agent.id, 'Stop', {});
  await waitFor(() => notes.some((n) => n.kind === 'done' && n.agentId === agent.id), { what: 'done notify' });
});
