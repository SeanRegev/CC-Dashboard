'use strict';
// Activity's files and events, on a real Core object in a temp CC_HOME (no processes, no server):
// batched appends, seq across restarts, paging from the file, rotation, removal, restart rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Core } = require('../../packages/core/src/core');
const { Activity } = require('../../packages/core/src/activity');
const { newStatus, newRuntime } = require('../../packages/core/src/status');
const { tempHome, rmrf, waitFor } = require('./helpers');

/** A started Core with agent 'a' (and any others named), without launching anything. */
function makeCore(home, ids = ['a'], env = {}) {
  const core = new Core({ home, version: 't', env: { ...process.env, ...env } });
  // Agents exist in the saved state, like after a restart.
  const state = { spaces: [], agents: ids.map((id) => ({ id, spaceId: 's', name: id, cwd: home, sessionId: `sess-${id}`, role: { id: 'worker', label: 'Worker', emoji: '' }, createdAt: 1 })), status: {}, runtime: {} };
  const file = path.join(home, 'state.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ version: 1, ...state }));
  core.start();
  const events = [];
  core.on('broadcast', (event, data) => events.push({ event, data }));
  return { core, events };
}

const activityFile = (home, id) => path.join(home, 'activity', `${id}.jsonl`);
const fileLines = (home, id) => (fs.existsSync(activityFile(home, id)) ? fs.readFileSync(activityFile(home, id), 'utf8').split('\n').filter(Boolean) : []);

test('tool lines are batched (<= 250 ms), state-changing lines are on disk at once', async (t) => {
  const home = tempHome();
  const { core } = makeCore(home);
  t.after(() => { core.shutdown(); rmrf(home); });
  core.activity.onHook('a', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(fileLines(home, 'a').length, 0, 'batched');
  await waitFor(() => fileLines(home, 'a').length === 1, { timeout: 1000, what: 'batched flush' });
  core.activity.onHook('a', 'PreToolUse', { tool_name: 'Read' });
  core.activity.onHook('a', 'Stop', { last_assistant_message: 'done' });
  // Stop is written synchronously, together with the batch before it.
  assert.deepEqual(fileLines(home, 'a').map((l) => JSON.parse(l).kind), ['tool', 'tool', 'turn_end']);
});

test('activity events are batched in seq order; subagent.updated is coalesced', async (t) => {
  const home = tempHome();
  const { core, events } = makeCore(home);
  t.after(() => { core.shutdown(); rmrf(home); });
  core.activity.onHook('a', 'PreToolUse', { tool_name: 'Agent', tool_use_id: 't1', tool_input: { description: 'Count files', subagent_type: 'Explore' } });
  core.activity.onHook('a', 'SubagentStart', { agent_id: 's1', agent_type: 'Explore' });
  for (let i = 0; i < 5; i++) {
    core.activity.onHook('a', 'PreToolUse', { agent_id: 's1', tool_name: 'Read', tool_input: { file_path: `f${i}` } });
    core.activity.onHook('a', 'PostToolUse', { agent_id: 's1', tool_name: 'Read', tool_input: { file_path: `f${i}` } });
  }
  await waitFor(() => events.some((e) => e.event === 'activity'), { timeout: 1000, what: 'activity event' });
  await new Promise((r) => setTimeout(r, 150));
  const act = events.filter((e) => e.event === 'activity');
  assert.equal(act.length, 1, 'one batch');
  assert.equal(act[0].data.agentId, 'a');
  assert.deepEqual(act[0].data.entries.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const ups = events.filter((e) => e.event === 'subagent.updated');
  assert.ok(ups.length >= 1 && ups.length <= 3, `coalesced (${ups.length})`);
  const last = ups[ups.length - 1].data;
  assert.equal(last.agentId, 'a');
  assert.equal(last.subagent.title, 'Count files');
  assert.deepEqual(last.subagent.counts, { tools: 5, errors: 0 });
});

test('seq continues after a restart; list pages older entries from the file; torn last line repaired', (t) => {
  const home = tempHome();
  t.after(() => rmrf(home));
  let { core } = makeCore(home, ['a'], { CC_ACTIVITY_MEM: '10' });
  for (let i = 0; i < 25; i++) core.activity.onHook('a', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: `f${i}` } });
  core.activity.onHook('a', 'SubagentStart', { agent_id: 's1', agent_type: 'Plan' });
  core.shutdown();
  // A hard kill in the middle of an append leaves half a line.
  fs.appendFileSync(activityFile(home, 'a'), '{"seq":27,"at":1,"kin');

  ({ core } = makeCore(home, ['a'], { CC_ACTIVITY_MEM: '10' }));
  t.after(() => core.shutdown());
  core.activity.onHook('a', 'Stop', {});
  const lines = fileLines(home, 'a').map((l) => JSON.parse(l));
  assert.deepEqual(lines.slice(-2).map((e) => [e.seq, e.kind]), [[26, 'subagent_start'], [27, 'turn_end']]);

  const page = core.activity.list({ agentId: 'a', limit: 5 });
  assert.deepEqual(page.entries.map((e) => e.seq), [23, 24, 25, 26, 27]);
  assert.equal(page.more, true);
  const older = core.activity.list({ agentId: 'a', before: 23, limit: 20 });
  assert.deepEqual(older.entries.map((e) => e.seq), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
  assert.equal(older.more, true);
  const oldest = core.activity.list({ agentId: 'a', before: 3 });
  assert.deepEqual([oldest.entries.map((e) => e.seq), oldest.more], [[1, 2], false]);
  // subagentId filters ('' = the session's own lines), across memory and file.
  const mine = core.activity.list({ agentId: 'a', subagentId: 's1' });
  assert.deepEqual(mine.entries.map((e) => e.seq), [26]);
  assert.equal(core.activity.list({ agentId: 'a', subagentId: '' }).entries.length, 26);
  // Limits and bad params.
  assert.equal(core.activity.list({ agentId: 'a', limit: 5000 }).entries.length, 27);
  for (const bad of [{ limit: 0 }, { limit: 1.5 }, { before: 'x' }, { subagentId: 3 }]) {
    assert.throws(() => core.activity.list({ agentId: 'a', ...bad }), (e) => e.code === 'bad_request', JSON.stringify(bad));
  }
});

test('a log past the size limit is rewritten with its last entries; paging still works', (t) => {
  const home = tempHome();
  const { core } = makeCore(home, ['a'], { CC_ACTIVITY_MAX_BYTES: '20000', CC_ACTIVITY_KEEP: '50', CC_ACTIVITY_MEM: '20' });
  t.after(() => { core.shutdown(); rmrf(home); });
  for (let i = 0; i < 400; i++) core.activity.onHook('a', 'UserPromptSubmit', { prompt: `prompt number ${i} `.padEnd(80, '.') });
  const size = fs.statSync(activityFile(home, 'a')).size;
  assert.ok(size <= 20000, `rotated (${size} bytes)`);
  const lines = fileLines(home, 'a').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 50 && lines.length < 400, `${lines.length} lines kept`);
  assert.equal(lines[lines.length - 1].seq, 400);
  assert.deepEqual(lines.map((e) => e.seq), lines.map((_, i) => lines[0].seq + i), 'a contiguous tail');
  // No temp files left behind.
  assert.deepEqual(fs.readdirSync(path.join(home, 'activity')).filter((f) => f.endsWith('.tmp')), []);
  const all = core.activity.list({ agentId: 'a', limit: 1000 });
  assert.equal(all.more, false);
  assert.equal(all.entries[0].seq, lines[0].seq);
});

test('subagents survive a restart; running ones become stopped, the status count follows', (t) => {
  const home = tempHome();
  t.after(() => rmrf(home));
  let { core } = makeCore(home);
  core.activity.onHook('a', 'PreToolUse', { tool_name: 'Agent', tool_use_id: 't1', tool_input: { description: 'Long job' } });
  core.activity.onHook('a', 'SubagentStart', { agent_id: 's1', agent_type: 'general-purpose' });
  core.activity.onHook('a', 'SubagentStart', { agent_id: 's2', agent_type: 'Explore' });
  core.activity.onHook('a', 'SubagentStop', { agent_id: 's2', last_assistant_message: 'found it' });
  core.status.set('a', { ...core.status.get('a'), subagents: { running: 1, total: 2 }, state: 'working', detail: '1 subagent running', tool: 'Agent' });
  core.store.saveNow();
  // Hard kill: no shutdown(). State changes were written already.
  ({ core } = makeCore(home));
  t.after(() => core.shutdown());
  const list = core.activity.subagentsList({ agentId: 'a' });
  assert.deepEqual(list.map((s) => [s.id, s.title, s.state]), [['s1', 'Long job', 'stopped'], ['s2', 'Explore', 'done']]);
  assert.ok(list[0].endedAt);
  assert.equal(list[1].summary, 'found it');
  const st = core.status.get('a');
  assert.deepEqual(st.subagents, { running: 0, total: 2 });
  assert.equal(st.state, 'stopped');
  assert.equal(st.detail, '');
});

test('the agent process exiting stops its subagents and updates status.subagents', async (t) => {
  const home = tempHome();
  const { core, events } = makeCore(home);
  t.after(() => { core.shutdown(); rmrf(home); });
  core.activity.onHook('a', 'SubagentStart', { agent_id: 's1', agent_type: 'Plan' });
  core.update('a', (s) => ({ status: { ...s, state: 'working', tool: 'Agent', detail: '1 subagent running', subagents: { running: 1, total: 1 } } }));
  core.broadcast('agent.exit', { id: 'a', code: 0 });
  assert.equal(core.activity.subagentsList({ agentId: 'a' })[0].state, 'stopped');
  assert.deepEqual(core.status.get('a').subagents, { running: 0, total: 1 });
  assert.equal(core.status.get('a').detail, '');
  await waitFor(() => events.some((e) => e.event === 'subagent.updated' && e.data.subagent.state === 'stopped'), { timeout: 1000, what: 'stopped event' });
});

test('needsYou is cleared when the status no longer shows that prompt', async (t) => {
  const home = tempHome();
  const { core } = makeCore(home);
  t.after(() => { core.shutdown(); rmrf(home); });
  core.activity.onHook('a', 'SubagentStart', { agent_id: 's1', agent_type: 'Plan' });
  core.activity.onHook('a', 'PermissionRequest', { agent_id: 's1', tool_name: 'Bash' });
  assert.equal(core.activity.subagentsList({ agentId: 'a' })[0].needsYou, true);
  core.update('a', (s) => ({ status: { ...s, state: 'needs_you', permission: true, askedBy: 's1' } }));
  assert.equal(core.activity.subagentsList({ agentId: 'a' })[0].needsYou, true);
  core.update('a', (s) => ({ status: { ...s, state: 'working', permission: undefined, askedBy: undefined } }));
  assert.equal(core.activity.subagentsList({ agentId: 'a' })[0].needsYou, false);
});

test('onRemove deletes the files; shutdown flushes what is pending', (t) => {
  const home = tempHome();
  t.after(() => rmrf(home));
  const { core } = makeCore(home, ['a', 'con']);
  core.activity.onHook('a', 'SubagentStart', { agent_id: 's1', agent_type: 'Plan' });
  core.activity.onHook('con', 'PreToolUse', { tool_name: 'Read' });
  core.shutdown();
  // A Windows device name gets a safe file name; the batched line was flushed by shutdown.
  assert.equal(fileLines(home, 'con_').length, 1);
  const files = () => fs.readdirSync(path.join(home, 'activity')).sort();
  assert.deepEqual(files(), ['a.jsonl', 'a.subagents.json', 'con_.jsonl']);
  const act = new Activity(core);
  act.onRemove('a');
  assert.deepEqual(files(), ['con_.jsonl']);
  assert.deepEqual(act.subagentsList({ agentId: 'a' }), []);
  assert.deepEqual(act.list({ agentId: 'a' }), { entries: [], more: false });
});

test('a fresh agent has an empty log and no files until something happens', (t) => {
  const home = tempHome();
  const { core } = makeCore(home);
  t.after(() => { core.shutdown(); rmrf(home); });
  core.status.set('b', newStatus('b'));
  core.rt.set('b', newRuntime());
  assert.deepEqual(core.activity.list({ agentId: 'b' }), { entries: [], more: false });
  assert.ok(!fs.existsSync(activityFile(home, 'b')));
});
