'use strict';
// Outside sessions end to end: a real core process, a temp CLAUDE_CONFIG_DIR with running-session
// files written by live child processes (tests/fake-claude-registry/claude.js), fixture transcripts, and
// takeOver resuming the conversation with tests/fake-claude.js (via the argv-logging wrapper).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startCore, claudeCmd, waitFor, argvLog, FIXTURES, REPO } = require('./helpers');
const { projectDirName } = require('../../packages/core/src/transcript');

const FAKE_REG = path.join(REPO, 'tests', 'fake-claude-registry', 'claude.js');
const SESSIONS = path.join(REPO, 'tests', 'fixtures', 'sessions');
const WRAPPED = claudeCmd(path.join(FIXTURES, 'wrapped-claude.js'));
// Take over reads the process with PowerShell on Windows, which can be slow to start: give it what the app gives it.
const TAKEOVER_MS = 45000;
const SID = '00000000-0000-4000-8000-000000000001';
const FAST = { CC_EXTERNAL_POLL_MS: '100', CC_EXTERNAL_TAIL_MS: '100', CC_TAKEOVER_TERM_MS: '500' };

async function setup(t, env = {}) {
  const core = await startCore({ claude: WRAPPED, env: { ...FAST, ...env } });
  t.after(() => core.dispose());
  const config = core.env.CLAUDE_CONFIG_DIR;
  assert.ok(config.startsWith(core.home), 'the test config dir is a temp folder');
  const space = await core.space('proj');
  return { core, config, space };
}

/** Start an outside "Claude": a live process that writes its own registry file. */
async function outside(t, config, args, script = FAKE_REG) {
  const proc = spawn(process.execPath, [script, ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: config }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  await waitFor(() => out.includes('READY'), { what: 'fake outside claude ready' });
  return { proc, exited, alive: () => proc.exitCode === null && proc.signalCode === null, send: (line) => proc.stdin.write(`${line}\n`) };
}

/** Put the fixture transcripts where Claude keeps them for cwd. */
function writeTranscripts(config, cwd, { sub = true } = {}) {
  const dir = path.join(config, 'projects', projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const main = path.join(dir, `${SID}.jsonl`);
  fs.copyFileSync(path.join(SESSIONS, 'main-transcript.jsonl'), main);
  const subDir = path.join(dir, SID, 'subagents');
  if (sub) {
    fs.mkdirSync(subDir, { recursive: true });
    fs.copyFileSync(path.join(SESSIONS, 'agent-ae0d14e7ad2db2bf5.jsonl'), path.join(subDir, 'agent-ae0d14e7ad2db2bf5.jsonl'));
    fs.copyFileSync(path.join(SESSIONS, 'subagents-meta', 'agent-ae0d14e7ad2db2bf5.meta.json'), path.join(subDir, 'agent-ae0d14e7ad2db2bf5.meta.json'));
  }
  return { dir, main, subDir };
}

const listed = (core) => core.client.call('external.list');

test('an outside session is listed with its state, space and transcript activity; changes are pushed', async (t) => {
  const { core, config, space } = await setup(t);
  const changed = core.collect('external.changed');
  const activity = core.collect('activity');
  const subUpdates = core.collect('subagent.updated');
  const { main, subDir } = writeTranscripts(config, space.path, { sub: false });
  const o = await outside(t, config, ['--session', SID, '--cwd', space.path, '--status', 'idle', '--entrypoint', 'vscode', '--name', 'review comments']);
  const [s] = await waitFor(async () => { const l = await listed(core); return l.length === 1 && l; }, { what: 'listed' });
  assert.equal(s.id, `ext:${SID}`);
  assert.equal(s.pid, o.proc.pid);
  assert.equal(s.state, 'idle');
  assert.equal(s.spaceId, space.id);
  assert.equal(s.name, 'review comments');
  assert.equal(s.entrypoint, 'vscode');
  assert.equal(s.version, '2.1.332');
  assert.match(s.lastPrompt, /^Use the Agent\/Task tool/);
  assert.equal(s.tool, 'Agent');
  await waitFor(() => changed.some((c) => c.sessions.some((x) => x.id === s.id)), { what: 'external.changed' });
  const backlog = await core.client.call('activity.list', { agentId: s.id });
  assert.deepEqual(backlog.entries.map((e) => e.kind), ['prompt', 'tool', 'tool_done', 'notice']);

  // Busy in the registry → working, and the tail speeds up.
  o.send('status busy');
  await waitFor(() => changed.some((c) => c.sessions.some((x) => x.id === s.id && x.state === 'working')), { what: 'working' });

  // New transcript lines → an activity event for the ext: id.
  fs.appendFileSync(main, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'toolu_new', name: 'Bash', input: { command: 'npm test' } }] } }) + '\n'
    + '{"type":"user","message":{"content":"half a li');
  const ev = await waitFor(() => activity.find((a) => a.agentId === s.id && a.entries.some((e) => e.kind === 'tool' && e.detail === 'npm test')), { what: 'activity event' });
  assert.equal(ev.entries[0].seq, backlog.entries[backlog.entries.length - 1].seq + 1);
  fs.appendFileSync(main, 'ne"}}\n');
  await waitFor(() => activity.some((a) => a.agentId === s.id && a.entries.some((e) => e.kind === 'prompt' && e.text === 'half a line')), { what: 'the rest of the line' });

  // A subagent appears: subagent.updated, and the session counts it.
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-ab12.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find token call sites', requestShape: 'background', model: 'claude-haiku-4-5-20251001' }));
  fs.writeFileSync(path.join(subDir, 'agent-ab12.jsonl'), JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'ab12', timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_use', id: 'toolu_g', name: 'Grep', input: { pattern: 'token' } }] } }) + '\n');
  const up = await waitFor(() => subUpdates.find((u) => u.agentId === s.id && u.subagent.id === 'ab12' && u.subagent.tool === 'Grep'), { what: 'subagent.updated' });
  assert.equal(up.subagent.title, 'Find token call sites');
  assert.equal(up.subagent.type, 'Explore');
  assert.equal(up.subagent.state, 'running');
  assert.equal(up.subagent.background, true);
  assert.equal(up.subagent.model, 'claude-haiku-4-5-20251001', 'M4: the model from meta.json');
  assert.equal(up.subagent.detail, 'token');
  await waitFor(() => changed.some((c) => c.sessions.some((x) => x.id === s.id && x.subagents.running === 1 && x.subagents.total === 1)), { what: 'subagent count' });
  const subs = await core.client.call('subagents.list', { agentId: s.id });
  assert.deepEqual(subs.map((x) => x.id), ['ab12']);
  const only = await core.client.call('activity.list', { agentId: s.id, subagentId: 'ab12' });
  assert.deepEqual(only.entries.map((e) => e.kind), ['subagent_start', 'tool']);

  // It finishes: done, with an end line.
  fs.writeFileSync(path.join(subDir, 'agent-ab12.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find token call sites', requestShape: 'background', finished: true }));
  await waitFor(() => subUpdates.some((u) => u.subagent.id === 'ab12' && u.subagent.state === 'done'), { what: 'subagent done' });

  // Back to idle: a turn_end line.
  o.send('status idle');
  await waitFor(() => activity.some((a) => a.agentId === s.id && a.entries.some((e) => e.kind === 'turn_end' && /^DONE/.test(e.text))), { what: 'turn_end' });

  // The process ends: the session leaves the list.
  o.proc.kill('SIGTERM');
  await waitFor(async () => (await listed(core)).length === 0, { what: 'gone from the list' });
  await waitFor(() => changed.length && changed[changed.length - 1].sessions.length === 0, { what: 'external.changed empty' });
});

test('not listed: our own agents\' sessions, dead pids, junk files; unknown ext ids answer not_found', async (t) => {
  const { core, config, space } = await setup(t);
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'mine', prompt: 'hi' });
  await outside(t, config, ['--session', agent.sessionId, '--cwd', space.path]);
  fs.mkdirSync(path.join(config, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(config, 'sessions', '999999.json'), JSON.stringify({ pid: 2 ** 22 + 999, sessionId: 'dead-one', cwd: space.path }));
  fs.writeFileSync(path.join(config, 'sessions', 'junk.json'), '{"pid":');
  const visible = await outside(t, config, ['--session', 'visible-one', '--cwd', path.join(core.home, 'elsewhere')]);
  const l = await waitFor(async () => { const x = await listed(core); return x.length && x; }, { what: 'listed' });
  assert.deepEqual(l.map((x) => x.id), ['ext:visible-one']);
  assert.equal(l[0].spaceId, undefined, 'a folder outside every space');
  assert.equal(l[0].name, 'elsewhere');
  assert.ok(visible.alive());
  for (const m of ['activity.list', 'subagents.list']) {
    await assert.rejects(core.client.call(m, { agentId: 'ext:nope' }), (e) => e.code === 'not_found');
  }
  await assert.rejects(core.client.call('external.takeOver', { id: 'ext:nope' }, TAKEOVER_MS), (e) => e.code === 'not_found');
});

test('takeOver: refuses a busy session without force, then ends it and resumes the same conversation here', async (t) => {
  const { core, config, space } = await setup(t);
  const { main } = writeTranscripts(config, space.path);
  const o = await outside(t, config, ['--session', SID, '--cwd', space.path, '--status', 'busy', '--name', 'outside work']);
  await waitFor(async () => (await listed(core)).length === 1, { what: 'listed' });
  const before = await waitFor(async () => { const r = await core.client.call('activity.list', { agentId: `ext:${SID}` }); return r.entries.length && r; }, { what: 'outside log' });
  const subsBefore = await core.client.call('subagents.list', { agentId: `ext:${SID}` });
  await assert.rejects(core.client.call('external.takeOver', { id: `ext:${SID}` }, TAKEOVER_MS), (e) => e.code === 'still_working');
  assert.ok(o.alive(), 'refused: the process is untouched');

  const changed = core.collect('external.changed');
  const created = core.collect('agent.created');
  const agent = await core.client.call('external.takeOver', { id: `ext:${SID}`, force: true }, TAKEOVER_MS);
  await o.exited; // the outside process ended
  assert.equal(agent.sessionId, SID);
  assert.equal(agent.cwd, space.path);
  assert.equal(agent.spaceId, space.id);
  assert.equal(agent.name, 'outside work');
  assert.equal(agent.role.id, 'main');
  assert.ok(created.some((c) => c.agent.id === agent.id));
  assert.deepEqual(await listed(core), []);
  assert.ok(changed.some((c) => c.sessions.length === 0));
  const argv = await waitFor(() => argvLog(core.home).find((a) => a.includes('--resume')), { what: 'resumed' });
  assert.deepEqual(argv.slice(0, 2), ['--resume', SID]);
  await core.waitStatus(agent.id, (s) => s.running && s.state === 'idle', 'resumed agent idle');
  assert.ok(fs.existsSync(main), 'the transcript is left alone');
  // The log and subagents the app showed for it outside carry over to the agent (seq from 1).
  const after = await core.client.call('activity.list', { agentId: agent.id });
  const carried = after.entries.slice(0, before.entries.length);
  assert.deepEqual(carried.map((e) => [e.kind, e.tool || '', e.subagentId]), before.entries.map((e) => [e.kind, e.tool || '', e.subagentId]));
  assert.deepEqual(carried.map((e) => e.seq), carried.map((_, i) => i + 1));
  const subsAfter = await core.client.call('subagents.list', { agentId: agent.id });
  assert.deepEqual(subsAfter.map((x) => [x.id, x.title]), subsBefore.map((x) => [x.id, x.title]));
  assert.ok(subsAfter.every((x) => x.agentId === agent.id && x.state !== 'running'));
  // The same session coming back (now ours) is not listed again.
  await outside(t, config, ['--session', SID, '--cwd', space.path]);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(await listed(core), []);
});

test('takeOver: a session in a folder outside every space gets a new space; a given name wins', async (t) => {
  const { core, config } = await setup(t);
  const cwd = path.join(core.home, 'notes');
  fs.mkdirSync(cwd);
  await outside(t, config, ['--session', 'notes-session', '--cwd', cwd, '--status', 'idle']);
  await waitFor(async () => (await listed(core)).length === 1, { what: 'listed' });
  const agent = await core.client.call('external.takeOver', { id: 'ext:notes-session', name: 'My notes' }, TAKEOVER_MS);
  assert.equal(agent.name, 'My notes');
  const spaces = await core.client.call('spaces.list');
  const sp = spaces.find((s) => s.id === agent.spaceId);
  assert.equal(sp.path, cwd);
});

test('takeOver: a process that ignores SIGTERM is killed', async (t) => {
  if (process.platform === 'win32') return t.skip('taskkill /F on Windows');
  const { core, config, space } = await setup(t);
  const o = await outside(t, config, ['--session', 'stubborn', '--cwd', space.path, '--ignore-term', '--keep-file']);
  await waitFor(async () => (await listed(core)).length === 1, { what: 'listed' });
  const agent = await core.client.call('external.takeOver', { id: 'ext:stubborn' }, TAKEOVER_MS);
  const { signal } = await o.exited;
  assert.equal(signal, 'SIGKILL');
  assert.equal(agent.sessionId, 'stubborn');
  return undefined;
});

test('takeOver: refuses (and leaves alone) a live process that does not look like Claude', async (t) => {
  const { core, config, space } = await setup(t);
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } });
  fs.mkdirSync(path.join(config, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(config, 'sessions', `${proc.pid}.json`), JSON.stringify({ pid: proc.pid, sessionId: 'impostor', cwd: space.path, status: 'idle', startedAt: Date.now() }));
  await waitFor(async () => (await listed(core)).length === 1, { what: 'listed' });
  await assert.rejects(core.client.call('external.takeOver', { id: 'ext:impostor', force: true }, TAKEOVER_MS), (e) => e.code === 'not_allowed' && /does not look like Claude/.test(e.message));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(proc.exitCode, null);
  assert.equal(proc.signalCode, null);
  assert.equal((await core.client.call('agents.list')).length, 0);
});
