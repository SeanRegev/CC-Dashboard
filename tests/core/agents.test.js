'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { connect } = require('../../packages/core/src/client');
const { startCore, claudeCmd, waitFor, argvLog, FIXTURES } = require('./helpers');

const WRAPPED = claudeCmd(path.join(FIXTURES, 'wrapped-claude.js'));

test('create agent: starting -> idle, with lastPrompt, files, counts, usage and history', async (t) => {
  const core = await startCore({ claude: WRAPPED });
  t.after(() => core.dispose());
  const space = await core.space();
  const created = core.collect('agent.created');
  const statuses = core.collect('agent.status');
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'Fix Bug', prompt: 'fix the bug', model: 'sonnet', effort: 'high', mode: 'plan' });
  assert.equal(agent.id, 'fix-bug');
  assert.equal(agent.spaceId, space.id);
  assert.equal(agent.cwd, space.path);
  assert.match(agent.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(created.length, 1);
  assert.equal(created[0].agent.id, agent.id);
  assert.equal(created[0].status.state, 'starting');

  const s = await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 1, 'idle after first turn');
  assert.equal(s.running, true);
  assert.equal(s.lastPrompt, 'fix the bug');
  assert.deepEqual(s.files, [path.join(space.path, 'app.js')]);
  assert.deepEqual(s.counts, { tools: 1, turns: 1, errors: 0, subagents: 0 });
  assert.equal(s.tool, '');
  const states = s.history.map(([, st]) => st);
  assert.equal(states[0], 'starting');
  assert.deepEqual(states.slice(-2), ['working', 'idle']);
  assert.ok(statuses.some((x) => x.state === 'working' && x.tool === 'Bash' && x.detail === 'npm test'));
  // Usage from the fake transcript: total = input + output + cache_write, context = input + cache_read + cache_write.
  assert.deepEqual(s.usage, { total: 510, context: 1010, contextPct: 0.51, model: 'fake-model' });

  const argv = argvLog(core.home)[0];
  assert.deepEqual(argv.slice(0, 2), ['--session-id', agent.sessionId]);
  assert.equal(argv[argv.indexOf('--settings') + 1], path.join(core.home, 'hooks-settings.json'));
  assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(argv[argv.length - 1], 'fix the bug');

  const again = await core.client.call('agents.create', { spaceId: space.id, name: 'Fix Bug' });
  assert.equal(again.id, 'fix-bug-2');
});

test('agent env: CC_AGENT_ID / CC_CORE_URL / CC_TOKEN set; ELECTRON_RUN_AS_NODE and CLAUDECODE stripped', async (t) => {
  const core = await startCore({ claude: WRAPPED, env: { ELECTRON_RUN_AS_NODE: '1', CLAUDECODE: '1' } });
  t.after(() => core.dispose());
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'a', prompt: 'x' });
  // Hooks still reach the core through the launcher.
  await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 1);
  const env = JSON.parse(fs.readFileSync(path.join(core.home, 'env.log'), 'utf8').trim().split('\n')[0]);
  assert.deepEqual(env, {
    CC_AGENT_ID: agent.id, CC_CORE_URL: `http://127.0.0.1:${core.info.port}`, CC_TOKEN: core.info.token,
    ELECTRON_RUN_AS_NODE: null, CLAUDECODE: null,
  });
});

test('send text: typed into the terminal, a new turn starts and ends', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'a', prompt: 'hello' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 1);
  const statuses = core.collect('agent.status');
  assert.equal(await core.client.call('agents.send', { id: agent.id, text: 'second task' }), true);
  const s = await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 2, 'second turn');
  assert.equal(s.lastPrompt, 'second task');
  assert.ok(statuses.some((x) => x.state === 'working' && x.lastPrompt === 'second task'));
  await waitFor(async () => (await core.replay(agent.id)).includes('GOT: second task'), { what: 'GOT in replay' });
  // Raw input works too.
  await core.client.call('agents.input', { id: agent.id, data: 'raw keys\r' });
  await waitFor(async () => (await core.replay(agent.id)).includes('GOT: raw keys'), { what: 'raw input echoed' });
});

test('attach replays scrollback, then output flows only to attached clients until detach', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'a' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle');
  const other = await connect({ home: core.home });
  t.after(() => other.close());
  const mine = core.collect('agent.output');
  const theirs = [];
  other.on('agent.output', (d) => theirs.push(d));

  const { replay } = await core.client.call('agents.attach', { id: agent.id });
  assert.match(replay, /FAKE CLAUDE READY/);
  await core.client.call('agents.send', { id: agent.id, text: 'ping' });
  await waitFor(() => mine.map((o) => o.data).join('').includes('GOT: ping'), { what: 'output event' });
  assert.ok(mine.every((o) => o.id === agent.id));
  // The other client never attached.
  await other.call('agents.list'); // a round trip, so anything sent to it has arrived
  assert.equal(theirs.length, 0);

  await core.client.call('agents.detach', { id: agent.id });
  const count = mine.length;
  await core.client.call('agents.send', { id: agent.id, text: 'pong' });
  await waitFor(async () => (await other.call('agents.attach', { id: agent.id })).replay.includes('GOT: pong'), { what: 'pong in replay' });
  await core.client.call('agents.list');
  assert.equal(mine.length, count);
});

test('resize changes the terminal size the agent sees', async (t) => {
  const core = await startCore({ claude: WRAPPED });
  t.after(() => core.dispose());
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'a' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle');
  assert.equal(await core.client.call('agents.resize', { id: agent.id, cols: 101, rows: 37 }), true);
  await core.client.call('agents.send', { id: agent.id, text: 'size' });
  await waitFor(async () => (await core.replay(agent.id)).includes('SIZE 101x37'), { what: 'new size' });
  await assert.rejects(core.client.call('agents.resize', { id: agent.id, cols: 0, rows: 10 }), { code: 'bad_request' });
  await assert.rejects(core.client.call('agents.resize', { id: agent.id, cols: 'x', rows: 10 }), { code: 'bad_request' });
});

test('stop keeps the record; resume uses --resume when the transcript exists', async (t) => {
  const core = await startCore({ claude: WRAPPED });
  t.after(() => core.dispose());
  const space = await core.space();
  const exits = core.collect('agent.exit');
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'a', prompt: 'first' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 1);
  assert.equal(await core.client.call('agents.stop', { id: agent.id }), true);
  let s = await core.waitStatus(agent.id, (x) => x.state === 'stopped' && !x.running, 'stopped');
  await waitFor(() => exits.length === 1, { what: 'agent.exit' });
  assert.equal(exits[0].id, agent.id);
  assert.equal(s.lastPrompt, 'first');
  await assert.rejects(core.client.call('agents.send', { id: agent.id, text: 'x' }), { code: 'not_running' });
  await assert.rejects(core.client.call('agents.input', { id: agent.id, data: 'x' }), { code: 'not_running' });
  await assert.rejects(core.client.call('agents.approve', { id: agent.id }), { code: 'not_running' });
  // Stopping twice is fine.
  assert.equal(await core.client.call('agents.stop', { id: agent.id }), true);

  assert.equal(await core.client.call('agents.resume', { id: agent.id }), true);
  s = await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.running, 'idle after resume');
  const argv = argvLog(core.home);
  assert.equal(argv.length, 2);
  assert.deepEqual(argv[1].slice(0, 2), ['--resume', agent.sessionId]);
  assert.ok(!argv[1].includes('first'), 'the first prompt is not sent again');
  const states = s.history.map(([, st]) => st);
  assert.deepEqual(states.slice(-3), ['stopped', 'starting', 'idle']);
  // Usage is deduplicated by message id: the resumed fake writes the same reply again.
  assert.equal(s.usage.total, 510);
  // Resuming a running agent is a no-op.
  assert.equal(await core.client.call('agents.resume', { id: agent.id }), true);
  assert.equal(argvLog(core.home).length, 2);
});

test('resume without a transcript starts fresh with the same session id and resends the first prompt', async (t) => {
  const core = await startCore({ claude: WRAPPED });
  t.after(() => core.dispose());
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'a', prompt: 'the task' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 1);
  await core.client.call('agents.stop', { id: agent.id });
  await core.waitStatus(agent.id, (x) => !x.running);
  fs.rmSync(path.join(core.home, `transcript-${agent.sessionId}.jsonl`));
  await core.client.call('agents.resume', { id: agent.id });
  await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 2 && x.running, 'fresh second run');
  const argv = argvLog(core.home)[1];
  assert.deepEqual(argv.slice(0, 2), ['--session-id', agent.sessionId]);
  assert.equal(argv[argv.length - 1], 'the task');
});

test('an agent that exits by itself is marked exited; remove deletes the record', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const space = await core.space();
  const exits = core.collect('agent.exit');
  const removed = core.collect('agent.removed');
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'a' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle');
  await core.client.call('agents.send', { id: agent.id, text: '/exit' });
  await core.waitStatus(agent.id, (x) => x.state === 'exited' && !x.running, 'exited');
  await waitFor(() => exits.length === 1, { what: 'agent.exit' });
  assert.equal(exits[0].code, 0);
  assert.equal(await core.client.call('agents.remove', { id: agent.id }), true);
  assert.deepEqual(removed, [{ id: agent.id }]);
  assert.deepEqual(await core.client.call('agents.list'), []);
});

test('removing a running agent kills it', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'a' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle');
  assert.equal(await core.client.call('agents.remove', { id: agent.id }), true);
  assert.deepEqual(await core.client.call('agents.list'), []);
  await assert.rejects(core.client.call('agents.attach', { id: agent.id }), { code: 'not_found' });
});

test('a turn that takes long enough sends a "done" notification', async (t) => {
  const core = await startCore({ env: { CC_LONG_TURN_MS: '1' } });
  t.after(() => core.dispose());
  const space = await core.space();
  const notes = core.collect('notify');
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'Long One', prompt: 'big job' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 1);
  await waitFor(() => notes.length >= 1, { what: 'notify' });
  assert.match(notes[0].title, /^Long One is done \(\d+m\d\ds\)$/);
  assert.equal(notes[0].body, 'big job');
  assert.equal(notes[0].agentId, agent.id);
});

test('a short turn does not notify', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const space = await core.space();
  const notes = core.collect('notify');
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'a', prompt: 'quick' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 1);
  await core.client.call('agents.list');
  assert.deepEqual(notes, []);
});

test('a missing claude executable marks the agent exited with a reason', async (t) => {
  const core = await startCore({ claude: 'definitely-not-a-real-claude-binary' });
  t.after(() => core.dispose());
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'a' });
  const s = await core.waitStatus(agent.id, (x) => x.state === 'exited');
  assert.equal(s.running, false);
  assert.match(s.detail, /not found/);
});
