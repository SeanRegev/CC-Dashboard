'use strict';
// The outside-sessions logic without a core process: pure helpers, and External with the OS calls
// (process alive / identity / signals) replaced, so the refusal paths of takeOver can be tested
// without ending any real process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const X = require('../../packages/core/src/external');
const { projectDirName } = require('../../packages/core/src/transcript');
const { rmrf } = require('./helpers');

const SESSIONS = path.join(__dirname, '..', 'fixtures', 'sessions');

test('parseRegistry: the real sample, and junk never throws', () => {
  const sample = JSON.parse(fs.readFileSync(path.join(SESSIONS, 'registry-sample.json'), 'utf8'));
  assert.deepEqual(X.parseRegistry(sample), {
    pid: 43210, sessionId: '00000000-0000-4000-8000-0000000000aa', cwd: '<CWD>', status: 'busy', name: 'my-session',
    entrypoint: 'cli', version: '2.1.332', kind: 'interactive', startedAt: 1795695270919, updatedAt: 1795696063679, procStart: '152',
  });
  for (const bad of [null, 1, 'x', [], {}, { pid: '1', sessionId: 'a', cwd: '/' }, { pid: 0, sessionId: 'a', cwd: '/' },
    { pid: 1.5, sessionId: 'a', cwd: '/' }, { pid: 5, sessionId: '../x', cwd: '/' }, { pid: 5, sessionId: 'a', cwd: '' }, { pid: 5, sessionId: 'a' }]) {
    assert.equal(X.parseRegistry(bad), null, JSON.stringify(bad));
  }
  const odd = X.parseRegistry({ pid: 5, sessionId: 'a', cwd: '/x', status: 7, name: { n: 1 }, updatedAt: 'soon', procStart: 99 });
  assert.equal(odd.status, '');
  assert.equal(odd.name, '');
  assert.equal(odd.updatedAt, 0);
  assert.equal(odd.procStart, '99');
});

test('stateOf: busy → working, idle → idle, waiting / permission → needs_you, else unknown', () => {
  assert.equal(X.stateOf('busy'), 'working');
  assert.equal(X.stateOf('idle'), 'idle');
  for (const s of ['waiting', 'waiting_for_permission', 'permission', 'needs_input', 'blocked']) assert.equal(X.stateOf(s), 'needs_you', s);
  for (const s of ['', 'compacting', 'shutting_down']) assert.equal(X.stateOf(s), 'unknown', s);
});

test('pathInside / matchSpace: Windows is case-insensitive with either slash; POSIX is exact; deepest space wins', () => {
  assert.ok(X.pathInside('C:/Users/Me/Proj/src', 'c:\\users\\me\\proj', 'win32'));
  assert.ok(X.pathInside('c:\\users\\me\\proj\\', 'C:/Users/Me/Proj', 'win32'));
  assert.ok(!X.pathInside('C:\\Users\\Me\\Project', 'C:\\Users\\Me\\Proj', 'win32'));
  assert.ok(X.pathInside('D:\\x', 'D:\\', 'win32'));
  assert.ok(X.pathInside('/home/me/proj/a', '/home/me/proj', 'linux'));
  assert.ok(X.pathInside('/home/me/proj', '/home/me/proj/', 'linux'));
  assert.ok(!X.pathInside('/home/me/Proj', '/home/me/proj', 'linux'));
  assert.ok(!X.pathInside('/home/me/project', '/home/me/proj', 'linux'));
  const spaces = [{ id: 'outer', path: 'C:\\work' }, { id: 'inner', path: 'C:\\work\\app' }];
  assert.equal(X.matchSpace(spaces, 'c:/WORK/app/src', 'win32').id, 'inner');
  assert.equal(X.matchSpace(spaces, 'C:\\work\\docs', 'win32').id, 'outer');
  assert.equal(X.matchSpace(spaces, 'C:\\elsewhere', 'win32'), null);
});

test('process identity: tasklist CSV, /proc stat, what looks like Claude', () => {
  const csv = '"claude.exe","4242","Console","1","215,332 K"\r\n';
  assert.equal(X.parseTasklist(csv, 4242), 'claude.exe');
  assert.equal(X.parseTasklist(csv, 42), '');
  assert.equal(X.parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n', 4242), '');
  assert.equal(X.parseProcStat('105 (claude (x) y) S 1 105 105 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 12 0 152 1000 50'), '152');
  assert.equal(X.parseProcStat('junk'), '');

  assert.ok(X.looksLikeClaude({ argv: ['/opt/claude-code/bin/claude', '--preload', 'x'] }));
  assert.ok(X.looksLikeClaude({ argv: ['/usr/bin/node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'], command: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js' }));
  assert.ok(X.looksLikeClaude({ image: 'claude.exe' }));
  assert.ok(X.looksLikeClaude({ image: 'node.exe', command: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js' }));
  assert.ok(!X.looksLikeClaude({ image: 'node.exe' }), 'node.exe without a command line is not enough');
  assert.ok(!X.looksLikeClaude({ argv: ['/usr/bin/node', 'server.js'], command: 'node server.js' }));
  assert.ok(!X.looksLikeClaude({ argv: ['/usr/bin/python3', 'claude.py'], command: 'python3 claude.py' }));
  assert.ok(!X.looksLikeClaude({ image: 'Code.exe', command: 'Code.exe --claude' }));
  assert.ok(!X.looksLikeClaude(null));
});

test('confirmIdentity: start time must match on Linux, and the process may not start after the session', () => {
  const reg = X.parseRegistry({ pid: 7, sessionId: 's', cwd: '/x', procStart: '152', startedAt: 1_000_000 });
  const claude = { argv: ['/opt/claude-code/bin/claude'], command: '/opt/claude-code/bin/claude' };
  assert.equal(X.confirmIdentity(reg, { ...claude, procStart: '152' }, 'linux').ok, true);
  assert.equal(X.confirmIdentity(reg, { ...claude, procStart: '999' }, 'linux').ok, false);
  assert.match(X.confirmIdentity(reg, { ...claude, procStart: '999' }, 'linux').reason, /start time/);
  assert.equal(X.confirmIdentity(reg, { image: 'claude.exe', startMs: 999_000 }, 'win32').ok, true);
  assert.equal(X.confirmIdentity(reg, { image: 'claude.exe', startMs: 1_000_000 + 61_000 }, 'win32').ok, false);
  assert.equal(X.confirmIdentity(reg, { argv: ['node'], command: 'node app.js' }, 'darwin').ok, false);
  assert.equal(X.confirmIdentity(reg, null, 'linux').ok, false);
});

test('readIdentity on this machine reads a live process; a dead pid gives null', async (t) => {
  if (process.platform === 'win32') return t.skip('reads tasklist / PowerShell on Windows: covered by the parsers');
  const info = await X.readIdentity(process.pid, process.platform);
  assert.ok(info && /node/i.test(info.command || ''));
  assert.equal(await X.readIdentity(2 ** 22 + 12345, process.platform), null);
  assert.equal(X.pidAlive(process.pid), true);
  assert.equal(X.pidAlive(2 ** 22 + 12345), false);
  assert.equal(X.pidAlive(0), false);
  return undefined;
});

// ---- External with a stub core and stub OS calls ------------------------------------------------

function setup(t, { sys = {}, platform = process.platform, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ext-unit-'));
  t.after(() => rmrf(root));
  const config = path.join(root, 'claude-config');
  const cwd = path.join(root, 'proj');
  fs.mkdirSync(path.join(config, 'sessions'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const events = [];
  const adopted = [];
  const core = {
    env: { CLAUDE_CONFIG_DIR: config, CC_EXTERNAL_POLL_MS: '100000', CC_EXTERNAL_TAIL_MS: '100000', CC_TAKEOVER_TERM_MS: '200', CC_TAKEOVER_WAIT_MS: '400', ...env },
    agents: new Map(), terms: new Map(), spaces: new Map(),
    broadcast: (e, d) => events.push([e, d]),
    spacesAdd: ({ path: p }) => { const s = { id: 'new-space', name: path.basename(p), path: p, createdAt: 0 }; core.spaces.set(s.id, s); return s; },
    adoptSession: (p) => { adopted.push(p); return { id: 'adopted', ...p }; },
  };
  const state = { alive: new Set([4242]), signals: [], taskkills: [], identity: { argv: ['/opt/claude-code/bin/claude'], command: '/opt/claude-code/bin/claude', procStart: '' } };
  const ext = new X.External(/** @type {any} */ (core), {
    platform,
    sys: {
      alive: (pid) => state.alive.has(pid),
      identity: async () => state.identity,
      signal: (pid, sig) => { state.signals.push([pid, sig]); if (state.onSignal) state.onSignal(pid, sig); },
      taskkill: async (pid) => { state.taskkills.push(pid); if (state.onSignal) state.onSignal(pid, 'TASKKILL'); },
      ...sys,
    },
  });
  t.after(() => ext.shutdown());
  const writeReg = (reg) => fs.writeFileSync(path.join(config, 'sessions', `${reg.pid}.json`), JSON.stringify({ sessionId: 'sess-1', cwd, status: 'idle', startedAt: Date.now(), ...reg }));
  return { root, config, cwd, core, ext, events, adopted, state, writeReg };
}

test('discovery: keeps live, well-formed sessions that are not ours; skips junk, dead pids, our own sessions and pids', (t) => {
  const { ext, core, config, state, writeReg, cwd } = setup(t, { platform: 'linux' });
  writeReg({ pid: 4242, sessionId: 'sess-1', name: 'outside one', entrypoint: 'vscode', version: '2.1.332' });
  writeReg({ pid: 5555, sessionId: 'sess-dead' });
  writeReg({ pid: 6666, sessionId: 'sess-ours' });
  writeReg({ pid: 7777, sessionId: 'sess-our-pid' });
  fs.writeFileSync(path.join(config, 'sessions', 'broken.json'), '{nope');
  fs.writeFileSync(path.join(config, 'sessions', '8888.json'), JSON.stringify({ pid: 8888 }));
  fs.writeFileSync(path.join(config, 'sessions', '105.abc.key'), 'x');
  for (const p of [6666, 7777, 8888]) state.alive.add(p);
  core.agents.set('a', { id: 'a', sessionId: 'sess-ours' });
  core.terms.set('b', { pid: 7777 });
  core.spaces.set('proj', { id: 'proj', name: 'proj', path: cwd });
  ext.start();
  const list = ext.list();
  assert.deepEqual(list.map((s) => s.id), ['ext:sess-1']);
  const s = list[0];
  assert.equal(s.name, 'outside one');
  assert.equal(s.state, 'idle');
  assert.equal(s.spaceId, 'proj');
  assert.equal(s.entrypoint, 'vscode');
  assert.equal(s.version, '2.1.332');
  assert.equal(s.pid, 4242);
  assert.equal(s.cwd, cwd);
  assert.deepEqual(s.subagents, { running: 0, total: 0 });
});

test('discovery on Linux: a live pid whose start time differs from the registry (pid reused) is not listed', (t) => {
  if (process.platform !== 'linux') return t.skip('reads /proc');
  const { ext, state, writeReg } = setup(t, { platform: 'linux' });
  state.alive.add(process.ppid);
  writeReg({ pid: process.ppid, sessionId: 'sess-reused', procStart: '1' });
  ext.start();
  assert.deepEqual(ext.list(), []);
  return undefined;
});

test('external.changed is sent only when the list changes', async (t) => {
  const { ext, events, writeReg, state } = setup(t);
  ext.start();
  await new Promise((r) => setImmediate(r));
  const changed = () => events.filter(([e]) => e === 'external.changed');
  assert.equal(changed().length, 0, 'empty → empty sends nothing');
  writeReg({ pid: 4242 });
  ext.scan();
  ext.scan();
  await new Promise((r) => setImmediate(r));
  assert.equal(changed().length, 1);
  assert.equal(changed()[0][1].sessions.length, 1);
  ext.scan();
  await new Promise((r) => setImmediate(r));
  assert.equal(changed().length, 1, 'nothing changed');
  state.alive.delete(4242);
  ext.scan();
  await new Promise((r) => setImmediate(r));
  assert.equal(changed().length, 2);
  assert.deepEqual(changed()[1][1].sessions, []);
});

test('takeOver refuses: unknown id, bad params, unknown space, registry changed or gone, not Claude, still working', async (t) => {
  const { ext, writeReg, state, config } = setup(t);
  writeReg({ pid: 4242, status: 'busy' });
  ext.start();
  const code = async (p) => { try { await ext.takeOver(p); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(await code({ id: 'nope' }), 'bad_request');
  assert.equal(await code({ id: 'ext:nope' }), 'not_found');
  assert.equal(await code({ id: 'ext:sess-1', force: 'yes' }), 'bad_request');
  assert.equal(await code({ id: 'ext:sess-1', spaceId: 'missing' }), 'not_found');
  assert.equal(await code({ id: 'ext:sess-1' }), 'still_working');
  state.identity = { argv: ['/usr/bin/node'], command: 'node server.js' };
  assert.equal(await code({ id: 'ext:sess-1', force: true }), 'not_allowed');
  state.identity = null;
  assert.equal(await code({ id: 'ext:sess-1', force: true }), 'not_allowed');
  state.identity = { argv: ['/opt/claude-code/bin/claude'], command: 'claude' };
  writeReg({ pid: 4242, sessionId: 'another-session' });
  assert.equal(await code({ id: 'ext:sess-1', force: true }), 'not_allowed');
  fs.unlinkSync(path.join(config, 'sessions', '4242.json'));
  assert.equal(await code({ id: 'ext:sess-1', force: true }), 'not_found');
  assert.deepEqual(state.signals, [], 'nothing was ever signalled');
});

test('takeOver: SIGTERM; when ignored and still the same process, SIGKILL; then adopt with --resume data', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX signals');
  const { ext, writeReg, state, adopted, cwd, core, events } = setup(t);
  writeReg({ pid: 4242, name: 'outside one' });
  core.spaces.set('proj', { id: 'proj', name: 'proj', path: cwd });
  ext.start();
  state.onSignal = (pid, sig) => { if (sig === 'SIGKILL') state.alive.delete(pid); };
  const agent = await ext.takeOver({ id: 'ext:sess-1' });
  assert.deepEqual(state.signals, [[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
  assert.equal(agent.id, 'adopted');
  assert.deepEqual(adopted, [{ spaceId: 'proj', name: 'outside one', cwd, sessionId: 'sess-1', transcriptPath: '' }]);
  assert.deepEqual(ext.list(), []);
  const last = events.filter(([e]) => e === 'external.changed').pop();
  assert.deepEqual(last[1].sessions, []);
  return undefined;
});

test('takeOver: no SIGKILL when the pid changed hands after SIGTERM; not_allowed when it never exits', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX signals');
  const { ext, writeReg, state, adopted } = setup(t);
  writeReg({ pid: 4242 });
  ext.start();
  state.onSignal = (pid, sig) => { if (sig === 'SIGTERM') state.identity = { argv: ['/usr/bin/python3'], command: 'python3 other.py' }; };
  await assert.rejects(ext.takeOver({ id: 'ext:sess-1' }), (e) => e.code === 'not_allowed' && /did not exit/.test(e.message));
  assert.deepEqual(state.signals, [[4242, 'SIGTERM']]);
  assert.deepEqual(adopted, []);
  assert.equal(ext.list().length, 1, 'still listed: it is still running outside');
  return undefined;
});

test('takeOver on Windows: taskkill /T /F, then a new space for a folder outside every space', async (t) => {
  const { ext, writeReg, state, adopted, cwd } = setup(t, { platform: 'win32' });
  writeReg({ pid: 4242, status: 'busy' });
  state.identity = { image: 'claude.exe' };
  ext.start();
  state.onSignal = (pid) => state.alive.delete(pid);
  await ext.takeOver({ id: 'ext:sess-1', force: true, name: '  Picked name ' });
  assert.deepEqual(state.taskkills, [4242]);
  assert.deepEqual(state.signals, []);
  assert.equal(adopted[0].spaceId, 'new-space');
  assert.equal(adopted[0].name, 'Picked name');
  assert.equal(adopted[0].cwd, cwd);
});

test('takeOver twice at once: the second is refused while the first runs', async (t) => {
  const { ext, writeReg, state } = setup(t, { env: { CC_TAKEOVER_TERM_MS: '100' } });
  writeReg({ pid: 4242 });
  ext.start();
  state.onSignal = (pid) => setTimeout(() => state.alive.delete(pid), 150);
  const first = ext.takeOver({ id: 'ext:sess-1' });
  await assert.rejects(ext.takeOver({ id: 'ext:sess-1' }), (e) => e.code === 'not_allowed');
  await first;
});

test('activity and subagents from fixture transcripts; logs capped at 2000; activity.list paging', (t) => {
  const { ext, writeReg, config, cwd } = setup(t);
  const sid = '00000000-0000-4000-8000-000000000001';
  const dir = path.join(config, 'projects', projectDirName(cwd));
  const subDir = path.join(dir, sid, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.copyFileSync(path.join(SESSIONS, 'main-transcript.jsonl'), path.join(dir, `${sid}.jsonl`));
  fs.copyFileSync(path.join(SESSIONS, 'agent-ae0d14e7ad2db2bf5.jsonl'), path.join(subDir, 'agent-ae0d14e7ad2db2bf5.jsonl'));
  fs.copyFileSync(path.join(SESSIONS, 'subagents-meta', 'agent-ae0d14e7ad2db2bf5.meta.json'), path.join(subDir, 'agent-ae0d14e7ad2db2bf5.meta.json'));
  writeReg({ pid: 4242, sessionId: sid });
  ext.start();
  const id = `ext:${sid}`;
  const [sub] = ext.subagentsList({ agentId: id });
  assert.equal(sub.title, 'Count files here');
  assert.equal(sub.type, 'general-purpose');
  assert.equal(sub.state, 'done');
  assert.equal(sub.background, true);
  assert.deepEqual(sub.counts, { tools: 2, errors: 0 });
  assert.match(sub.summary, /^\*\*1\. `ls` output/);
  assert.equal(sub.agentId, id);
  const { entries } = ext.activityList({ agentId: id });
  assert.deepEqual(entries.map((e) => e.seq), entries.map((_, i) => i + 1));
  const kinds = entries.map((e) => `${e.subagentId ? 'sub' : 'main'}:${e.kind}`);
  for (const k of ['main:prompt', 'main:tool', 'main:tool_done', 'main:notice', 'sub:subagent_start', 'sub:tool', 'sub:tool_done', 'sub:subagent_end']) assert.ok(kinds.includes(k), k);
  assert.equal(ext.activityList({ agentId: id, subagentId: '' }).entries.every((e) => e.subagentId === ''), true);
  assert.equal(ext.activityList({ agentId: id, subagentId: 'ae0d14e7ad2db2bf5' }).entries.length, 6);
  const page = ext.activityList({ agentId: id, limit: 2 });
  assert.equal(page.entries.length, 2);
  assert.equal(page.more, true);
  const older = ext.activityList({ agentId: id, before: page.entries[0].seq, limit: 1000 });
  assert.equal(older.entries[older.entries.length - 1].seq, page.entries[0].seq - 1);
  assert.equal(older.more, false);
  const s = ext.list()[0];
  assert.deepEqual(s.subagents, { running: 0, total: 1 });
  assert.equal(s.tool, 'Agent');
  assert.equal(s.detail, 'Count files here');
  assert.match(s.lastPrompt, /^Use the Agent\/Task tool/);
  assert.throws(() => ext.activityList({ agentId: 'ext:nope' }), (e) => e.code === 'not_found');
  assert.throws(() => ext.subagentsList({ agentId: 'ext:nope' }), (e) => e.code === 'not_found');

  // Cap: a long transcript keeps the last 2000 entries.
  const rec = ext.sessions.get(id);
  ext.append(rec, Array.from({ length: 2500 }, (_, i) => ({ at: i, subagentId: '', kind: 'notice', text: String(i) })));
  assert.equal(rec.log.length, X.MAX_LOG);
  assert.equal(rec.log[rec.log.length - 1].text, '2499');
});
