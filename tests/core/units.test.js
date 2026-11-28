'use strict';
// Pure-function tests: status rules, transcript usage, command lines, scrollback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { newStatus, newRuntime, applyEvent, withState, MAX_HISTORY } = require('../../packages/core/src/status');
const { UsageReader } = require('../../packages/core/src/usage');
const { splitCommand, quoteWinArg, escapeCmdArg, claudeArgs, npmShimTarget, spawnSpec, which } = require('../../packages/core/src/command');
const { Scrollback } = require('../../packages/core/src/terminal');
const { defaultTranscriptPath, slug } = require('../../packages/core/src/core');
const { tempHome, rmrf } = require('./helpers');

/** Feed events through applyEvent. */
function run(events, start = { status: newStatus('a', 0), rt: newRuntime() }) {
  let cur = start;
  let now = 1000;
  for (const [event, payload] of events) cur = applyEvent(cur.status, cur.rt, event, payload || {}, (now += 1000));
  return cur;
}

test('status: a normal turn', () => {
  const { status: s, rt } = run([
    ['SessionStart', { transcript_path: '/t.jsonl' }],
    ['UserPromptSubmit', { prompt: 'do it' }],
    ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm   test\n --x' } }],
    ['PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.js' } }],
    ['PostToolUse', { tool_name: 'Write', tool_input: { file_path: 'b.js' } }],
    ['PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.js' } }],
    ['PostToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { is_error: true } }],
    ['SubagentStop'],
    ['Stop'],
  ]);
  assert.equal(s.state, 'idle');
  assert.equal(s.lastPrompt, 'do it');
  assert.deepEqual(s.files, ['b.js', 'a.js']); // most recent last, no duplicates
  assert.deepEqual(s.counts, { tools: 4, turns: 1, errors: 1, subagents: 1 });
  assert.equal(rt.transcriptPath, '/t.jsonl');
  assert.deepEqual(s.history.map(([, x]) => x), ['starting', 'idle', 'working', 'idle']);
});

test('status: tool detail is a one-line summary', () => {
  const { status: s } = run([['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm   test\n --x' } }]]);
  assert.equal(s.detail, 'npm test --x');
  assert.equal(s.tool, 'Bash');
});

test('status: PermissionRequest sets permission; leaving needs_you clears it', () => {
  let cur = run([['UserPromptSubmit', { prompt: 'p' }], ['PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }]]);
  assert.equal(cur.status.state, 'needs_you');
  assert.equal(cur.status.permission, true);
  assert.equal(cur.status.message, 'Wants to use Bash: rm -rf x');
  assert.ok(cur.status.needsSince);
  cur = run([['PostToolUse', { tool_name: 'Bash' }]], cur);
  assert.equal(cur.status.state, 'working');
  assert.equal(cur.status.permission, undefined);
  assert.equal(cur.status.needsSince, undefined);
  assert.equal(cur.status.message, '');
});

test('status: idle reminder and late permission notice are ignored', () => {
  let cur = run([['Stop']]);
  cur = run([['Notification', { message: 'Claude is waiting for your input' }]], cur);
  assert.equal(cur.status.state, 'idle');
  cur = run([['Notification', { message: 'whatever', notification_type: 'idle_prompt' }]], cur);
  assert.equal(cur.status.state, 'idle');
  // Prompt shown, then answered (PostToolUse), then the Notification arrives late.
  cur = run([['PermissionRequest', { tool_name: 'Bash' }], ['PostToolUse', { tool_name: 'Bash' }],
    ['Notification', { message: 'Claude needs your permission to use Bash' }]], cur);
  assert.equal(cur.status.state, 'working');
  // Without an answer it does count (older Claude only sends the Notification).
  const fresh = run([['UserPromptSubmit', {}], ['Notification', { message: 'Claude needs your permission to use Bash' }]]);
  assert.equal(fresh.status.state, 'needs_you');
  assert.equal(fresh.status.message, 'Claude needs your permission to use Bash');
});

test('status: a Notification while already needing you keeps the first message', () => {
  const cur = run([['PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: 'x.py' } }], ['Notification', { message: 'Claude needs your permission to use Edit' }]]);
  assert.equal(cur.status.message, 'Wants to use Edit: x.py');
  assert.equal(cur.status.permission, true);
});

test('status: SessionStart after compaction keeps a working agent working; SessionEnd exits', () => {
  let cur = run([['UserPromptSubmit', {}], ['PreCompact'], ['SessionStart', { source: 'compact' }]]);
  assert.equal(cur.status.state, 'working');
  assert.equal(cur.status.detail, 'compacting context');
  cur = run([['SessionEnd', { reason: 'exit' }]], cur);
  assert.equal(cur.status.state, 'exited');
  assert.equal(cur.status.detail, 'exit');
});

test('status: history is capped and applyEvent does not mutate its input', () => {
  const start = { status: newStatus('a', 0), rt: newRuntime() };
  const frozen = JSON.stringify(start);
  const events = [];
  for (let i = 0; i < MAX_HISTORY; i++) events.push(['UserPromptSubmit', {}], ['Stop']);
  const cur = run(events, start);
  assert.equal(cur.status.history.length, MAX_HISTORY);
  assert.equal(JSON.stringify(start), frozen);
});

test('status: withState keeps explicit needs_you fields', () => {
  const s = withState(newStatus('a', 0), 'needs_you', { message: 'm', needsSince: 5 }, 10);
  assert.equal(s.state, 'needs_you');
  assert.equal(s.message, 'm');
  assert.equal(s.needsSince, 5);
  const back = withState(s, 'idle', {}, 20);
  assert.equal(back.message, '');
  assert.equal(back.needsSince, undefined);
  assert.deepEqual(back.history.map(([, x]) => x), ['starting', 'needs_you', 'idle']);
});

function reply(id, model, u) {
  return JSON.stringify({ type: 'assistant', message: { id, model, usage: u } }) + '\n';
}

test('usage: incremental, deduplicated by message id, partial lines wait', (t) => {
  const dir = tempHome();
  t.after(() => rmrf(dir));
  const file = path.join(dir, 't.jsonl');
  const r = new UsageReader();
  assert.equal(r.read(file), null); // missing file
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n'
    + reply('m1', 'claude-opus-4', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 400 })
    + reply('m1', 'claude-opus-4', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 400 })
    + 'not json\n');
  // v4: the window and the source are part of the estimate (tests/core/usage-window.test.js has the rules).
  const est = { contextWindow: 200000, source: 'transcript' };
  assert.deepEqual(r.read(file), { total: 550, context: 1500, contextPct: 0.75, model: 'claude-opus-4', ...est });
  const line = reply('m2', 'claude-opus-4[1m]', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 99990, cache_creation_input_tokens: 0 });
  fs.appendFileSync(file, line.slice(0, 20)); // half a line
  assert.equal(r.read(file).total, 550);
  fs.appendFileSync(file, line.slice(20));
  assert.deepEqual(r.read(file), { total: 565, context: 100000, contextPct: 10, model: 'claude-opus-4[1m]', ...est, contextWindow: 1000000 });
  // Replaced by a shorter file: start over.
  fs.writeFileSync(file, reply('m9', 'm', { input_tokens: 1, output_tokens: 1 }));
  assert.deepEqual(r.read(file), { total: 2, context: 1, contextPct: 0, model: 'm', ...est });
});

test('usage: context percentage caps at 100', (t) => {
  const dir = tempHome();
  t.after(() => rmrf(dir));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, reply('x', 'sonnet', { input_tokens: 300000, output_tokens: 0 }));
  // v4: over 200k means the window is bigger (1M), so 30%; a known window caps at 100.
  assert.equal(new UsageReader().read(file).contextPct, 30);
  assert.equal(new UsageReader().read(file, { windowFor: () => 200000 }).contextPct, 100);
});

test('command: CC_CLAUDE is split like a quoted command line', () => {
  assert.deepEqual(splitCommand('node /a/fake.js'), ['node', '/a/fake.js']);
  assert.deepEqual(splitCommand('"/x y/node" "/a b/fake.js" --flag'), ['/x y/node', '/a b/fake.js', '--flag']);
  assert.deepEqual(splitCommand("'it''s' \"\" a\\ b", 'linux'), ['its', '', 'a b']);
  assert.deepEqual(splitCommand('"C:\\Program Files\\nodejs\\node.exe" C:\\repo\\tests\\fake-claude.js', 'win32'),
    ['C:\\Program Files\\nodejs\\node.exe', 'C:\\repo\\tests\\fake-claude.js']);
  assert.deepEqual(splitCommand('  claude  '), ['claude']);
});

test('command: claude arguments', () => {
  const agent = { sessionId: 'u-1', model: 'opus', effort: 'max', mode: 'acceptEdits' };
  assert.deepEqual(claudeArgs(agent, { resume: false, settingsPath: 's.json', prompt: 'go' }),
    ['--session-id', 'u-1', '--settings', 's.json', '--model', 'opus', '--effort', 'max', '--permission-mode', 'acceptEdits', 'go']);
  assert.deepEqual(claudeArgs({ sessionId: 'u-1' }, { resume: true, settingsPath: 's.json' }), ['--resume', 'u-1', '--settings', 's.json']);
});

test('command: Windows argument quoting round-trips CommandLineToArgvW rules', () => {
  assert.equal(quoteWinArg('plain'), 'plain');
  assert.equal(quoteWinArg(''), '""');
  assert.equal(quoteWinArg('two words'), '"two words"');
  assert.equal(quoteWinArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWinArg('"quoted all"'), '"\\"quoted all\\""');
  assert.equal(quoteWinArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
  assert.equal(quoteWinArg('line1\nline2'), '"line1\nline2"');
  // cmd.exe: metacharacters are caret-escaped, newlines can't be carried
  assert.equal(escapeCmdArg('a & b', false), '^"a^ ^&^ b^"');
  assert.equal(escapeCmdArg('x\ny', false), '^"x^ y^"');
});

test('command: npm cmd-shim target is found so claude.cmd runs without cmd.exe', (t) => {
  const dir = tempHome();
  t.after(() => rmrf(dir));
  const js = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, '');
  const shim = path.join(dir, 'claude.cmd');
  fs.writeFileSync(shim, '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n'
    + '  SET "_prog=node"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  assert.equal(npmShimTarget(shim), js);
  fs.writeFileSync(shim, '@echo off\r\n"C:\\somewhere\\claude.exe" %*\r\n');
  assert.equal(npmShimTarget(shim), null);
});

test('command: spawnSpec resolves the executable on PATH and errors clearly', (t) => {
  const dir = tempHome();
  t.after(() => rmrf(dir));
  const exe = path.join(dir, process.platform === 'win32' ? 'myclaude.exe' : 'myclaude');
  fs.writeFileSync(exe, '');
  fs.chmodSync(exe, 0o755);
  const env = { ...process.env, PATH: dir + path.delimiter + (process.env.PATH || '') };
  assert.equal(which('myclaude', { env }), exe);
  const spec = spawnSpec(['myclaude'], ['--x', 'a b'], { env });
  assert.equal(spec.file, exe);
  if (process.platform === 'win32') assert.equal(spec.args, '--x "a b"');
  else assert.deepEqual(spec.args, ['--x', 'a b']);
  assert.throws(() => spawnSpec(['no-such-claude-here'], [], { env }), /not found on PATH/);
});

test('scrollback keeps the last ~256 KB, starting at a line break', () => {
  const sb = new Scrollback(1000);
  for (let i = 0; i < 100; i++) sb.push(`line ${i} ${'x'.repeat(40)}\n`);
  const text = sb.toString();
  assert.ok(text.length <= 1000);
  assert.ok(text.endsWith(`line 99 ${'x'.repeat(40)}\n`));
  assert.match(text, /^line \d+ /);
});

test('ids and default transcript location', () => {
  assert.equal(slug('  My Project!! (v2) '), 'my-project-v2');
  assert.equal(slug('Ünïcode'), 'unicode');
  const p = defaultTranscriptPath(path.join(path.sep, 'home', 'me', 'my.proj'), 'abc', { CLAUDE_CONFIG_DIR: path.join(path.sep, 'cfg') });
  assert.equal(p, path.join(path.sep, 'cfg', 'projects', '-home-me-my-proj', 'abc.jsonl'));
});
