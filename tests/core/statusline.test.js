'use strict';
// M4 track A: the core side of the status line (statusline.js), against a stub core.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  StatusLine, parseSnapshot, findUserStatusLine, userRun, firstWord, localDay, claudeShell, KEEP_DAYS,
} = require('../../packages/core/src/statusline');
const { buildSettings, displayOptions, statusLineCommand } = require('../../packages/core/src/hooks-settings');
const { tempHome, rmrf, waitFor } = require('./helpers');

const FIX = path.join(__dirname, '..', 'fixtures', 'statusline');
const SAMPLE = () => JSON.parse(fs.readFileSync(path.join(FIX, 'sample.json'), 'utf8'));
const STARTUP = () => JSON.parse(fs.readFileSync(path.join(FIX, 'startup.json'), 'utf8'));

/** A stand-in for Core: agents, update() and broadcast(), nothing else. */
function stubCore(home) {
  const statuses = new Map();
  const events = [];
  const core = {
    home,
    env: { CLAUDE_CONFIG_DIR: path.join(home, 'claude-config') },
    agents: new Map([
      ['a1', { id: 'a1', name: 'Alpha', spaceId: 's1', cwd: home }],
      ['a2', { id: 'a2', name: 'Beta', spaceId: 's1', cwd: home }],
    ]),
    statuses,
    events,
    updates: 0,
    update(id, fn) {
      const s = statuses.get(id) || { agentId: id, usage: { total: 0, context: 0, contextPct: 0, model: '' } };
      const out = fn(s, {});
      if (!out) return s;
      core.updates++;
      statuses.set(id, out.status);
      return out.status;
    },
    broadcast(event, data) { events.push({ event, data: JSON.parse(JSON.stringify(data)) }); },
  };
  return core;
}

/** @param {any} p @param {{cost?: number, input?: number, output?: number, pct?: number|null, session?: string}} o */
function withTotals(p, o) {
  if (o.cost !== undefined) p.cost.total_cost_usd = o.cost;
  if (o.input !== undefined) p.context_window.total_input_tokens = o.input;
  if (o.output !== undefined) p.context_window.total_output_tokens = o.output;
  if (o.pct !== undefined) p.context_window.used_percentage = o.pct;
  if (o.session !== undefined) p.session_id = o.session;
  return p;
}

function setup(t, opts = { throttleMs: 0 }) {
  const home = tempHome();
  t.after(() => rmrf(home));
  const core = stubCore(home);
  const sl = new StatusLine(/** @type {any} */ (core), opts);
  sl.start();
  t.after(() => sl.shutdown());
  return { home, core, sl };
}

test('parseSnapshot reads both real fixtures', () => {
  const s = parseSnapshot(SAMPLE());
  assert.deepEqual(s, {
    sessionId: '0b7d3c2e-5f41-4a8e-9c6d-1e2f3a4b5c6d', model: 'claude-haiku-5-5', window: 1000000, pct: 10,
    context: 6 + 3120 + 94870, cost: 0.4127, inputTokens: 181204, outputTokens: 6120,
    fiveHour: { usedPct: 62, resetsAt: 1767225600000 }, sevenDay: { usedPct: 31, resetsAt: 1767657600000 },
  });
  const st = parseSnapshot(STARTUP());
  assert.equal(st.window, 1000000);
  assert.equal(st.pct, null);
  assert.equal(st.context, null);
  assert.equal(st.fiveHour, undefined);
  assert.equal(st.cost, 0);
});

test('parseSnapshot never throws on junk, nulls or missing fields', () => {
  for (const junk of [null, undefined, 42, 'x', [], {}, { context_window: null, cost: 'a', model: 7, rate_limits: [] },
    { context_window: { context_window_size: '1000000', used_percentage: NaN, current_usage: 'x' } },
    { rate_limits: { five_hour: { used_percentage: null }, seven_day: 'x' } }]) {
    const s = parseSnapshot(junk);
    assert.equal(s.window, null);
    assert.equal(s.pct, null);
    assert.equal(s.fiveHour, undefined);
    assert.equal(s.sevenDay, undefined);
  }
  assert.equal(parseSnapshot({ context_window: { used_percentage: 140 } }).pct, 100);
  assert.deepEqual(parseSnapshot({ rate_limits: { five_hour: { used_percentage: 5 } } }).fiveHour, { usedPct: 5, resetsAt: 0 });
});

test('a status line after a reply: Claude\'s own %, window, context and cost; total keeps its meaning', (t) => {
  const { core, sl } = setup(t);
  core.statuses.set('a1', { agentId: 'a1', usage: { total: 5555, context: 470000, contextPct: 100, model: 'claude-haiku-5-5', contextWindow: 200000, source: 'transcript' } });
  sl.handle('a1', SAMPLE());
  assert.deepEqual(core.statuses.get('a1').usage, {
    total: 5555, context: 97996, contextPct: 10, model: 'claude-haiku-5-5', contextWindow: 1000000, source: 'statusline', costUsd: 0.4127,
  });
  // A later transcript read (a hook) keeps the status line's numbers and takes its total.
  const merged = sl.merge('a1', { total: 6000, context: 99000, contextPct: 49.5, model: 'claude-haiku-5-5', contextWindow: 200000, source: 'transcript' });
  assert.equal(merged.total, 6000);
  assert.equal(merged.contextPct, 10);
  assert.equal(merged.source, 'statusline');
});

test('before the first reply (used_percentage null): the transcript estimate, with the status line\'s window', (t) => {
  const { core, sl } = setup(t);
  core.statuses.set('a1', { agentId: 'a1', usage: { total: 1510, context: 100000, contextPct: 50, model: 'claude-haiku-5-5', contextWindow: 200000, source: 'transcript' } });
  sl.handle('a1', STARTUP());
  assert.deepEqual(core.statuses.get('a1').usage, {
    total: 1510, context: 100000, contextPct: 10, model: 'claude-haiku-5-5', contextWindow: 1000000, source: 'transcript', costUsd: 0,
  });
  // The window is remembered for this agent and this model id (the transcript fallback uses it).
  assert.equal(sl.windowFor('a1', 'x'), 1000000);
  assert.equal(sl.windowFor('a2', 'claude-haiku-5-5'), 1000000);
  assert.equal(sl.windowFor('a2', 'other'), undefined);
});

test('junk payloads and unknown agents change nothing and never throw', (t) => {
  const { core, sl } = setup(t);
  for (const junk of [null, 'text', 42, [], [1, 2]]) sl.handle('a1', junk);
  assert.equal(core.updates, 0);
  sl.handle('nobody', SAMPLE());
  assert.deepEqual(sl.usageGet().byAgent, {});
  sl.handle('a1', { context_window: null, cost: null, model: null });
  assert.equal(core.statuses.get('a1') ? core.statuses.get('a1').usage.source : 'none', 'transcript');
});

test('at most one update per agent per second; the last one always lands', async (t) => {
  const { core, sl } = setup(t, { throttleMs: 1000 });
  const started = Date.now();
  sl.handle('a1', withTotals(SAMPLE(), { pct: 11 }));
  assert.equal(core.statuses.get('a1').usage.contextPct, 11);
  sl.handle('a1', withTotals(SAMPLE(), { pct: 12 }));
  sl.handle('a1', withTotals(SAMPLE(), { pct: 13 }));
  sl.handle('a2', withTotals(SAMPLE(), { pct: 50, session: 'other' })); // per agent: not held back by a1
  assert.equal(core.statuses.get('a2').usage.contextPct, 50);
  assert.equal(core.statuses.get('a1').usage.contextPct, 11);
  await waitFor(() => core.statuses.get('a1').usage.contextPct === 13, { what: 'trailing update', timeout: 3000 });
  const took = Date.now() - started;
  assert.ok(took >= 900, `trailing update after ${took} ms`);
  assert.equal(core.updates, 3); // 11, 50, 13: 12 never applied
});

test('usage.changed at most about once a second, with the latest Usage', async (t) => {
  const { core, sl } = setup(t);
  for (let i = 1; i <= 5; i++) sl.handle('a1', withTotals(SAMPLE(), { cost: i }));
  const changed = () => core.events.filter((e) => e.event === 'usage.changed');
  assert.equal(changed().length, 1);
  await waitFor(() => changed().length === 2, { what: 'trailing usage.changed', timeout: 3000 });
  assert.equal(changed()[1].data.usage.byAgent.a1.costUsd, 4); // first update is the baseline (1), then +4
});

test('limits from the freshest update that has rate_limits (resets_at x 1000), fromAgentId', (t) => {
  const { sl } = setup(t);
  assert.equal(sl.usageGet().limits.updatedAt, 0);
  sl.handle('a1', SAMPLE());
  const l1 = sl.usageGet().limits;
  assert.deepEqual({ ...l1, updatedAt: 0 }, {
    updatedAt: 0, fromAgentId: 'a1', fiveHour: { usedPct: 62, resetsAt: 1767225600000 }, sevenDay: { usedPct: 31, resetsAt: 1767657600000 },
  });
  assert.ok(l1.updatedAt > 0);
  sl.handle('a2', STARTUP()); // no rate_limits: the last ones stay
  assert.equal(sl.usageGet().limits.fromAgentId, 'a1');
  const p = SAMPLE();
  p.rate_limits = { five_hour: { used_percentage: 70, resets_at: 1767225600 } };
  sl.handle('a2', p);
  assert.deepEqual(sl.usageGet().limits.fiveHour, { usedPct: 70, resetsAt: 1767225600000 });
  assert.equal(sl.usageGet().limits.sevenDay, undefined);
  assert.equal(sl.usageGet().limits.fromAgentId, 'a2');
});

test('totals from deltas: first update is the baseline, a drop (new process / resume) starts a new one', (t) => {
  const { sl } = setup(t);
  const day = localDay(Date.now());
  sl.handle('a1', withTotals(STARTUP(), { cost: 0, input: 0, output: 0 }));
  sl.handle('a1', withTotals(SAMPLE(), { cost: 0.5, input: 1000, output: 100 }));
  sl.handle('a1', withTotals(SAMPLE(), { cost: 0.75, input: 1500, output: 150 }));
  sl.handle('a1', withTotals(SAMPLE(), { cost: 0.75, input: 1500, output: 150 })); // same again: nothing
  const want = { costUsd: 0.75, inputTokens: 1500, outputTokens: 150 };
  assert.deepEqual(sl.usageGet().byAgent.a1, { ...want, name: 'Alpha', spaceId: 's1' });
  // Restarted (a new process starts at 0, or --resume restores less): new baseline, nothing counted twice.
  sl.handle('a1', withTotals(SAMPLE(), { cost: 0.1, input: 100, output: 10 }));
  assert.deepEqual(sl.usageGet().byAgent.a1, { ...want, name: 'Alpha', spaceId: 's1' });
  sl.handle('a1', withTotals(SAMPLE(), { cost: 0.3, input: 300, output: 30 }));
  const after = { costUsd: 0.95, inputTokens: 1700, outputTokens: 170 };
  assert.deepEqual(sl.usageGet().byAgent.a1, { ...after, name: 'Alpha', spaceId: 's1' });
  // A different session id: new baseline too.
  sl.handle('a1', withTotals(SAMPLE(), { cost: 5, input: 5000, output: 500, session: 'new-session' }));
  assert.deepEqual(sl.usageGet().byAgent.a1, { ...after, name: 'Alpha', spaceId: 's1' });
  // Another agent in the same space adds to the space and the day.
  sl.handle('a2', withTotals(SAMPLE(), { cost: 1, input: 10, output: 1, session: 's2' }));
  sl.handle('a2', withTotals(SAMPLE(), { cost: 1.05, input: 20, output: 2, session: 's2' }));
  assert.deepEqual(sl.usageGet().bySpace.s1, { costUsd: 1, inputTokens: 1710, outputTokens: 171 });
  assert.deepEqual(sl.usageGet().byDay[day], { costUsd: 1, inputTokens: 1710, outputTokens: 171 });
});

test('usage.json: saved atomically, survives a restart (baselines too), old days pruned', (t) => {
  const home = tempHome();
  t.after(() => rmrf(home));
  const core = stubCore(home);
  let sl = new StatusLine(/** @type {any} */ (core), { throttleMs: 0 });
  sl.start();
  sl.handle('a1', withTotals(SAMPLE(), { cost: 1, input: 100, output: 10 }));
  sl.handle('a1', withTotals(SAMPLE(), { cost: 1.5, input: 300, output: 30 }));
  sl.usage.byDay['2000-01-01'] = { costUsd: 9, inputTokens: 9, outputTokens: 9 };
  sl.shutdown();
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'usage.json'), 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.byDay['2000-01-01'], undefined, `days older than ${KEEP_DAYS} are dropped`);
  assert.equal(saved.windows['claude-haiku-5-5'], 1000000);
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')), []);

  sl = new StatusLine(/** @type {any} */ (core), { throttleMs: 0 });
  sl.start();
  const u = sl.usageGet();
  assert.deepEqual(u.byAgent.a1, { costUsd: 0.5, inputTokens: 200, outputTokens: 20, name: 'Alpha', spaceId: 's1' });
  assert.equal(u.limits.fromAgentId, 'a1');
  assert.equal(u.limits.fiveHour.usedPct, 62);
  assert.equal(sl.windowFor('a1', ''), 1000000);
  assert.equal(sl.windowFor('zz', 'claude-haiku-5-5'), 1000000);
  // The same process goes on after the core restarted: only what is new counts.
  sl.handle('a1', withTotals(SAMPLE(), { cost: 2, input: 400, output: 40 }));
  assert.deepEqual(sl.usageGet().byAgent.a1, { costUsd: 1, inputTokens: 300, outputTokens: 30, name: 'Alpha', spaceId: 's1' });
  sl.shutdown();
});

test('a broken usage.json is ignored', (t) => {
  const home = tempHome();
  t.after(() => rmrf(home));
  fs.writeFileSync(path.join(home, 'usage.json'), '{ not json');
  const sl = new StatusLine(/** @type {any} */ (stubCore(home)));
  sl.start();
  assert.deepEqual(sl.usageGet().byAgent, {});
  fs.writeFileSync(path.join(home, 'usage.json'), JSON.stringify({ byAgent: { a: 'x', b: { costUsd: 'y', name: 3 } }, windows: { m: -1 }, agents: [] }));
  const sl2 = new StatusLine(/** @type {any} */ (stubCore(home)));
  sl2.start();
  assert.deepEqual(sl2.usageGet().byAgent, { a: { costUsd: 0, inputTokens: 0, outputTokens: 0 }, b: { costUsd: 0, inputTokens: 0, outputTokens: 0 } });
  assert.equal(sl2.windowFor('a', 'm'), undefined);
});

test('a pending (throttled) update is applied on shutdown', (t) => {
  const { core, sl } = setup(t, { throttleMs: 60_000 });
  sl.handle('a1', withTotals(SAMPLE(), { pct: 20 }));
  sl.handle('a1', withTotals(SAMPLE(), { pct: 30 }));
  assert.equal(core.statuses.get('a1').usage.contextPct, 20);
  sl.shutdown();
  assert.equal(core.statuses.get('a1').usage.contextPct, 30);
});

test('onRemove keeps the totals under the saved name, drops the live state', (t) => {
  const { core, sl } = setup(t);
  sl.handle('a1', withTotals(SAMPLE(), { cost: 1 }));
  sl.handle('a1', withTotals(SAMPLE(), { cost: 2 }));
  sl.onRemove('a1');
  core.agents.delete('a1');
  assert.deepEqual(sl.usageGet().byAgent.a1, { costUsd: 1, inputTokens: 0, outputTokens: 0, name: 'Alpha', spaceId: 's1' });
  assert.equal(sl.live.has('a1'), false);
  assert.equal(sl.windowFor('a1', ''), undefined);
  const u = { total: 1, context: 1, contextPct: 0, model: 'm' };
  assert.equal(sl.merge('a1', u), u);
});

// ---- the user's own status line --------------------------------------------------------------

test('findUserStatusLine: local, then project, then CLAUDE_CONFIG_DIR settings; ours and non-commands skipped', (t) => {
  const dir = tempHome();
  t.after(() => rmrf(dir));
  const cwd = path.join(dir, 'proj');
  const config = path.join(dir, 'config');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: config };
  const write = (file, sl) => fs.writeFileSync(file, JSON.stringify(sl === undefined ? { model: 'x' } : { statusLine: sl }));
  assert.equal(findUserStatusLine(cwd, env), null);
  write(path.join(config, 'settings.json'), { type: 'command', command: 'user-line', padding: 0 });
  assert.deepEqual(findUserStatusLine(cwd, env), { type: 'command', command: 'user-line', padding: 0 });
  write(path.join(cwd, '.claude', 'settings.json'), { type: 'command', command: 'project-line' });
  assert.equal(findUserStatusLine(cwd, env).command, 'project-line');
  write(path.join(cwd, '.claude', 'settings.local.json'), { type: 'command', command: 'local-line', refreshInterval: 5 });
  assert.equal(findUserStatusLine(cwd, env).command, 'local-line');
  write(path.join(cwd, '.claude', 'settings.local.json'), undefined); // no statusLine there: the next file
  assert.equal(findUserStatusLine(cwd, env).command, 'project-line');
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), '{ broken');
  assert.equal(findUserStatusLine(cwd, env).command, 'user-line');
  write(path.join(cwd, '.claude', 'settings.json'), { type: 'command', command: '"C:/Users/me/.cc-dashboard/cc-statusline.cmd"' });
  assert.equal(findUserStatusLine(cwd, env), null);
  write(path.join(cwd, '.claude', 'settings.json'), { type: 'static', text: 'x' });
  assert.equal(findUserStatusLine(cwd, env), null);
});

test('userRun: the way Claude runs a status-line command on each platform', () => {
  assert.deepEqual(userRun('~/sl.sh', { shell: 'bash', bash: null }, {}, 'linux'), { command: '~/sl.sh', shell: true });
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.deepEqual(userRun('node C:/x/line.js', { shell: 'bash', bash }, {}, 'win32'), { command: 'node C:/x/line.js', shell: bash });
  assert.deepEqual(userRun('"C:/my dir/line.sh" --x', { shell: 'bash', bash }, {}, 'win32'), { command: 'bash "C:/my dir/line.sh" --x', shell: bash });
  const ps = userRun('Write-Output ${CLAUDE_PROJECT_DIR}', { shell: 'powershell', bash: null }, { PATH: '' }, 'win32');
  assert.deepEqual(ps.args, ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output ${env:CLAUDE_PROJECT_DIR}']);
  assert.match(String(ps.file), /p(ower)?sh/i);
  assert.equal(firstWord(`'a b.sh' c`), 'a b.sh');
  assert.equal(firstWord('a\\ b.sh c'), 'a b.sh');
  assert.deepEqual(claudeShell({}, 'darwin'), { shell: 'bash', bash: null });
});

test('claudeShell on Windows honours CLAUDE_CODE_GIT_BASH_PATH like Claude', { skip: process.platform !== 'win32' }, (t) => {
  const dir = tempHome();
  t.after(() => rmrf(dir));
  const fake = path.join(dir, 'bash.exe');
  fs.writeFileSync(fake, '');
  assert.deepEqual(claudeShell({ CLAUDE_CODE_GIT_BASH_PATH: fake, PATH: '' }, 'win32'), { shell: 'bash', bash: fake });
  const notBash = path.join(dir, 'zsh.exe');
  fs.writeFileSync(notBash, '');
  const r = claudeShell({ CLAUDE_CODE_GIT_BASH_PATH: notBash, PATH: '' }, 'win32');
  assert.notEqual(r.bash, notBash);
});

test('settings register the relay; display options are kept; PowerShell gets a call operator', () => {
  const s = buildSettings('C:\\h\\cc-hook.cmd', { statusLauncher: 'C:\\h\\cc-statusline.cmd', display: { padding: 2, refreshInterval: 5 } });
  assert.deepEqual(s.statusLine, { padding: 2, refreshInterval: 5, type: 'command', command: '"C:/h/cc-statusline.cmd"' });
  assert.equal(buildSettings('C:\\h\\cc-hook.cmd').statusLine, undefined);
  assert.equal(statusLineCommand("C:\\it's\\cc-statusline.cmd", 'powershell'), "& 'C:/it''s/cc-statusline.cmd'");
  assert.deepEqual(displayOptions({ type: 'command', command: 'x', padding: 0, hideVimModeIndicator: true }), { padding: 0, hideVimModeIndicator: true });
  assert.deepEqual(displayOptions(null), {});
});

test('prepare: our settings with the user\'s display options, and the relay env; none when they have no line', (t) => {
  const { home, core, sl } = setup(t);
  const config = core.env.CLAUDE_CONFIG_DIR;
  const plain = sl.prepare({ cwd: home });
  assert.deepEqual(plain.env, {});
  const base = JSON.parse(fs.readFileSync(plain.settingsPath, 'utf8'));
  assert.equal(base.statusLine.type, 'command');
  assert.match(base.statusLine.command, /cc-statusline\.(cmd|sh)/);
  assert.ok(base.hooks.Stop, 'the hooks are still there');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo hi', padding: 3 } }));
  const user = sl.prepare({ cwd: home });
  assert.notEqual(user.settingsPath, plain.settingsPath);
  const s = JSON.parse(fs.readFileSync(user.settingsPath, 'utf8'));
  assert.equal(s.statusLine.padding, 3);
  assert.equal(s.statusLine.command, base.statusLine.command);
  const run = JSON.parse(user.env.CC_STATUSLINE);
  assert.ok(run.command === 'echo hi' || (run.args && run.args.includes('echo hi')), JSON.stringify(run));
});
