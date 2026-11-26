'use strict';
// End to end: a real core and server, agents run tests/fake-claude.js in its subagent mode
// ("subagents:<n>", "bg", "nopre"), hooks go through the real launcher. Checks subagents.list,
// activity.list, the events, the session status rules, restart, resume and remove.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startCore, postHook, waitFor } = require('./helpers');

/** Every event of these kinds, in the order they arrived. */
function timeline(core, kinds) {
  const seen = [];
  for (const k of kinds) core.client.on(k, (d) => seen.push({ event: k, data: d }));
  return seen;
}

const subs = (core, agentId) => core.client.call('subagents.list', { agentId });
const log = (core, agentId, params = {}) => core.client.call('activity.list', { agentId, ...params });

test('foreground subagents: titles, types, done, counts; the session keeps its own tools', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const space = await core.space();
  const seen = timeline(core, ['activity', 'subagent.updated']);
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'fg', prompt: 'subagents:2' });
  const s = await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 1, 'turn done', 20000);
  assert.deepEqual(s.subagents, { running: 0, total: 2 });
  assert.equal(s.counts.tools, 2, 'only the two Agent calls are the session\'s own tools');
  assert.equal(s.counts.subagents, 2);
  assert.equal(s.lastPrompt, 'subagents:2');

  const list = await subs(core, agent.id);
  assert.deepEqual(list.map((x) => [x.title, x.type, x.state, x.background, x.counts.tools]), [
    ['Count files here', 'general-purpose', 'done', false, 2],
    ['Find token call sites', 'Explore', 'done', false, 2],
  ]);
  assert.ok(list.every((x) => x.agentId === agent.id && /^a[0-9a-f]{16}$/.test(x.id) && x.summary.startsWith('Done: ')));

  const { entries, more } = await log(core, agent.id);
  assert.equal(more, false);
  const kinds = entries.map((e) => e.kind);
  assert.equal(kinds[0], 'session_start');
  assert.equal(kinds[1], 'prompt');
  assert.equal(kinds.filter((k) => k === 'subagent_start').length, 2);
  assert.equal(kinds.filter((k) => k === 'subagent_end').length, 2);
  assert.equal(kinds[kinds.length - 1], 'turn_end');
  const first = list[0].id;
  const own = await log(core, agent.id, { subagentId: first });
  assert.deepEqual(own.entries.map((e) => [e.kind, e.tool || '']), [
    ['subagent_start', ''], ['tool', 'Bash'], ['tool_done', 'Bash'], ['tool', 'Read'], ['tool_done', 'Read'], ['subagent_end', ''],
  ]);
  assert.equal(own.entries[2].ms, 40);

  // The same lines arrived as events, in seq order, and every subagent change was sent.
  await waitFor(() => seen.filter((e) => e.event === 'activity').flatMap((e) => e.data.entries).length >= entries.length, { what: 'activity events' });
  const sent = seen.filter((e) => e.event === 'activity').flatMap((e) => e.data.entries).map((e) => e.seq);
  assert.deepEqual(sent.slice(0, entries.length), entries.map((e) => e.seq));
  const lastUpdate = new Map();
  for (const e of seen) if (e.event === 'subagent.updated') lastUpdate.set(e.data.subagent.id, e.data.subagent);
  assert.deepEqual([...lastUpdate.values()].map((x) => x.state), ['done', 'done']);
});

test('background subagents: working "N subagents running" after Stop, idle when the last ends; done notification waits', async (t) => {
  const core = await startCore({ env: { CC_FAKE_SUBAGENT_MS: '1500', CC_LONG_TURN_MS: '1' } });
  t.after(() => core.dispose());
  const space = await core.space();
  const seen = timeline(core, ['notify', 'subagent.updated', 'agent.status']);
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'bg', prompt: 'subagents:2 bg' });
  const mid = await core.waitStatus(agent.id, (x) => x.counts.turns === 1, 'first Stop', 20000);
  assert.equal(mid.state, 'working');
  assert.equal(mid.detail, '2 subagents running');
  assert.deepEqual(mid.subagents, { running: 2, total: 2 });
  assert.ok((await subs(core, agent.id)).every((x) => x.state === 'running' && x.background));

  const end = await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 3, 'both notifications handled', 20000);
  assert.deepEqual(end.subagents, { running: 0, total: 2 });
  assert.equal(end.lastPrompt, 'subagents:2 bg', 'task notifications are not the user\'s prompt');
  const list = await subs(core, agent.id);
  assert.deepEqual(list.map((x) => [x.title, x.state, x.background]), [['Count files here', 'done', true], ['Find token call sites', 'done', true]]);
  const { entries } = await log(core, agent.id);
  assert.deepEqual(entries.filter((e) => e.kind === 'notice').map((e) => e.text),
    ['Subagent finished: Count files here', 'Subagent finished: Find token call sites']);

  // No "done" notification while subagents still ran; the first comes after both ended.
  await waitFor(() => seen.some((e) => e.event === 'notify' && e.data.kind === 'done'), { what: 'done notification' });
  const firstDone = seen.findIndex((e) => e.event === 'notify' && e.data.kind === 'done');
  const doneUpdates = seen.map((e, i) => (e.event === 'subagent.updated' && e.data.subagent.state === 'done' ? i : -1)).filter((i) => i >= 0);
  assert.ok(doneUpdates.length >= 2 && doneUpdates.every((i) => i < firstDone), 'done notification after the subagents ended');
  const before = seen.slice(0, firstDone).filter((e) => e.event === 'agent.status').map((e) => e.data);
  assert.ok(before.some((x) => x.state === 'working' && x.detail === '2 subagents running'));
});

test('titles from meta.json when Claude sent no Agent call', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'np', prompt: 'subagents:1 nopre' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 1, 'turn done', 20000);
  const [sub] = await subs(core, agent.id);
  assert.equal(sub.title, 'Count files here');
  assert.equal(sub.state, 'done');
  assert.ok(fs.existsSync(path.join(core.home, agent.sessionId, 'subagents', `agent-${sub.id}.meta.json`)));
});

test('a permission prompt from a subagent: askedBy + needsYou, cleared by approve and deny', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'ask', prompt: 'hello' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 1);
  const hook = (event, payload) => postHook(core, agent.id, event, payload);
  await hook('UserPromptSubmit', { prompt: 'go' });
  await hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 't1', tool_input: { description: 'Delete temp files', subagent_type: 'general-purpose' } });
  await hook('SubagentStart', { agent_id: 's1', agent_type: 'general-purpose' });
  assert.equal(await hook('PermissionRequest', { agent_id: 's1', agent_type: 'general-purpose', tool_name: 'Bash', tool_input: { command: 'rm -rf tmp' } }), 200);
  let s = await core.waitStatus(agent.id, (x) => x.state === 'needs_you');
  assert.equal(s.askedBy, 's1');
  assert.equal(s.permission, true);
  assert.equal(s.message, 'Wants to use Bash: rm -rf tmp');
  let [sub] = await subs(core, agent.id);
  assert.deepEqual([sub.title, sub.needsYou, sub.tool, sub.detail], ['Delete temp files', true, 'Bash', 'rm -rf tmp']);

  await core.client.call('agents.approve', { id: agent.id });
  s = await core.status(agent.id);
  assert.equal(s.state, 'working');
  assert.equal(s.askedBy, undefined);
  [sub] = await subs(core, agent.id);
  assert.equal(sub.needsYou, false);
  assert.equal(sub.state, 'running');

  // Deny: the turn ends, and with it the foreground subagent.
  await hook('PermissionRequest', { agent_id: 's1', tool_name: 'Bash', tool_input: { command: 'rm -rf tmp' } });
  await core.waitStatus(agent.id, (x) => x.state === 'needs_you' && x.askedBy === 's1');
  await core.client.call('agents.deny', { id: agent.id });
  s = await core.status(agent.id);
  assert.equal(s.state, 'idle');
  [sub] = await subs(core, agent.id);
  assert.deepEqual([sub.state, sub.needsYou], ['stopped', false]);

  // A background subagent asks and is denied: the session stays working while it runs.
  await hook('UserPromptSubmit', { prompt: 'again' });
  await hook('SubagentStart', { agent_id: 's2', agent_type: 'Explore' });
  await hook('Stop', { background_tasks: [{ id: 's2', type: 'subagent', status: 'running', description: 'Scan the repo', agent_type: 'Explore' }] });
  s = await core.waitStatus(agent.id, (x) => x.detail === '1 subagent running');
  assert.equal(s.state, 'working');
  await hook('PermissionRequest', { agent_id: 's2', tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } });
  await core.waitStatus(agent.id, (x) => x.state === 'needs_you' && x.askedBy === 's2');
  await core.client.call('agents.deny', { id: agent.id });
  s = await core.status(agent.id);
  assert.deepEqual([s.state, s.detail, s.subagents], ['working', '1 subagent running', { running: 1, total: 2 }]);
  const s2 = (await subs(core, agent.id)).find((x) => x.id === 's2');
  assert.deepEqual([s2.title, s2.state, s2.background, s2.needsYou], ['Scan the repo', 'running', true, false]);
  await hook('SubagentStop', { agent_id: 's2', last_assistant_message: 'Scanned.' });
  s = await core.waitStatus(agent.id, (x) => x.state === 'idle');
  assert.deepEqual(s.subagents, { running: 0, total: 2 });
});

test('restart, resume, remove: subagents survive (running -> stopped), seq continues, files go', async (t) => {
  const core = await startCore({ env: { CC_FAKE_SUBAGENT_MS: '60000' } });
  t.after(() => core.dispose());
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'rs', prompt: 'subagents:2 bg' });
  await core.waitStatus(agent.id, (x) => x.detail === '2 subagents running', 'background subagents running', 20000);
  const beforeSeq = (await log(core, agent.id)).entries.slice(-1)[0].seq;
  // Windows stops the core with a hard kill: nothing may depend on shutdown() running.
  await core.stop('SIGKILL');

  const again = await startCore({ home: core.home, env: { CC_FAKE_SUBAGENT_MS: '60000' } });
  t.after(() => again.stop());
  let s = await again.status(agent.id);
  assert.equal(s.state, 'stopped');
  assert.deepEqual(s.subagents, { running: 0, total: 2 });
  const list = await subs(again, agent.id);
  assert.deepEqual(list.map((x) => [x.title, x.state]), [['Count files here', 'stopped'], ['Find token call sites', 'stopped']]);
  const kept = (await log(again, agent.id)).entries;
  assert.equal(kept[kept.length - 1].seq, beforeSeq, 'every line written before the kill is there');

  await again.client.call('agents.resume', { id: agent.id });
  await waitFor(async () => (await log(again, agent.id)).entries.some((e) => e.kind === 'session_start' && e.text === 'resume'), { what: 'resume line' });
  const after = (await log(again, agent.id)).entries;
  const resumed = after.find((e) => e.kind === 'session_start' && e.text === 'resume');
  assert.equal(resumed.seq, beforeSeq + 1, 'the same log goes on');
  s = await again.waitStatus(agent.id, (x) => x.state === 'idle');

  const dir = path.join(core.home, 'activity');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith(agent.id)));
  await again.client.call('agents.remove', { id: agent.id });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith(agent.id)), []);
  await assert.rejects(again.client.call('subagents.list', { agentId: agent.id }), (e) => e.code === 'not_found');
  await assert.rejects(again.client.call('activity.list', { agentId: agent.id }), (e) => e.code === 'not_found');
});

test('typed subagent lines work too, and activity.list pages with before', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'typed' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle');
  await core.client.call('agents.send', { id: agent.id, text: 'subagents:3' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.subagents && x.subagents.total === 3 && x.counts.turns === 1, 'three subagents', 20000);
  assert.deepEqual((await subs(core, agent.id)).map((x) => x.title), ['Count files here', 'Find token call sites', 'Plan the retry fix']);
  const all = (await log(core, agent.id, { limit: 1000 })).entries;
  const page = await log(core, agent.id, { limit: 5 });
  assert.deepEqual(page.entries, all.slice(-5));
  assert.equal(page.more, true);
  const older = await log(core, agent.id, { before: page.entries[0].seq, limit: 5 });
  assert.deepEqual(older.entries, all.slice(-10, -5));
});
