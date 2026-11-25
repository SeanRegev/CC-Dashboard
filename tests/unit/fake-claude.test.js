// @ts-check
'use strict';
// tests/fake-claude.js is the stand-in for `claude` in every core and e2e test, so its behaviour is
// part of the test contract. Runs it in a real PTY (node-pty; ConPTY on Windows) with a settings
// file whose hooks append the event name to a log, exactly like the core's hooks would fire.
// Portable: no bash, hook command is a Node one-liner with quoted paths (works in cmd.exe and sh).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

const FAKE_CLAUDE = path.join(__dirname, '..', 'fake-claude.js');

/** Hook command: reads the hook payload from stdin and appends hook_event_name to logFile. */
function hookCommand(logFile) {
  // Only single quotes inside the script, so it survives cmd.exe and sh double-quoting alike.
  // No `$`, backticks, `%` or `!` either (sh / cmd expansion).
  const js = "let s='';process.stdin.on('data',(d)=>{s+=d});process.stdin.on('end',()=>{"
    + "require('fs').appendFileSync(process.argv[1],JSON.parse(s).hook_event_name+String.fromCharCode(10))})";
  return `"${process.execPath}" -e "${js}" "${logFile}"`;
}

/** Temp CC_HOME with settings.json registering every event the fake fires. */
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fake-test-'));
  const log = path.join(home, 'hooks.log');
  const command = hookCommand(log);
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
    'Notification', 'Stop', 'SessionEnd'];
  const hooks = {};
  for (const e of events) hooks[e] = [{ matcher: '', hooks: [{ type: 'command', command }] }];
  const settings = path.join(home, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks }, null, 2));
  return { home, log, settings };
}

/** Starts fake-claude in a PTY. */
function start(env, args) {
  const term = pty.spawn(process.execPath, [FAKE_CLAUDE, ...args], {
    name: 'xterm-color', cols: 120, rows: 30, cwd: env.home,
    env: { ...process.env, CC_HOME: env.home },
  });
  const proc = { term, output: '', exited: /** @type {null | {exitCode:number}} */ (null) };
  term.onData((d) => { proc.output += d; });
  term.onExit((e) => { proc.exited = e; });
  return proc;
}

const readLog = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean) : []);

/** Polls until fn() is truthy; fails with a message showing what was seen. */
async function waitFor(fn, what, describe, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}; saw: ${describe()}`);
}

function cleanup(env, proc) {
  try { if (!proc.exited) proc.term.kill(); } catch (_) { /* already gone */ }
  try { fs.rmSync(env.home, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
}

test('normal prompt: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop', { timeout: 60000 }, async (t) => {
  const env = setup();
  const proc = start(env, ['--settings', env.settings, '--session-id', 'sess-normal', 'fix the bug']);
  t.after(() => cleanup(env, proc));
  const expected = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
  await waitFor(() => readLog(env.log).length >= expected.length, 'hook events',
    () => JSON.stringify({ log: readLog(env.log), output: proc.output }));
  assert.match(proc.output, /FAKE CLAUDE READY/);
  assert.deepEqual(readLog(env.log), expected);
  // a transcript with usage is written where Claude would (inside CC_HOME for the fake)
  assert.ok(fs.existsSync(path.join(env.home, 'transcript-sess-normal.jsonl')), 'transcript written');
});

test('permission prompt: dialog on screen, then PermissionRequest + Notification, no Stop', { timeout: 60000 }, async (t) => {
  const env = setup();
  const proc = start(env, ['--settings', env.settings, '--session-id', 'sess-perm', 'needs permission please']);
  t.after(() => cleanup(env, proc));
  const expected = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification'];
  await waitFor(() => readLog(env.log).length >= expected.length, 'hook events',
    () => JSON.stringify({ log: readLog(env.log), output: proc.output }));
  assert.match(proc.output, /Do you want to proceed\?/);
  assert.match(proc.output, /1\. Yes/);
  await new Promise((r) => setTimeout(r, 500)); // nothing else should arrive
  assert.deepEqual(readLog(env.log), expected);
});

test('typed lines print GOT: and fire UserPromptSubmit + Stop; /exit fires SessionEnd', { timeout: 60000 }, async (t) => {
  const env = setup();
  const proc = start(env, ['--settings', env.settings, '--session-id', 'sess-typed']);
  t.after(() => cleanup(env, proc));
  await waitFor(() => readLog(env.log).includes('SessionStart') && /FAKE CLAUDE READY/.test(proc.output),
    'startup', () => JSON.stringify({ log: readLog(env.log), output: proc.output }));
  assert.deepEqual(readLog(env.log), ['SessionStart'], 'no prompt given: only SessionStart');

  proc.term.write('hello there\r');
  await waitFor(() => /GOT: hello there/.test(proc.output), '"GOT: hello there"', () => JSON.stringify(proc.output));
  await waitFor(() => readLog(env.log).length >= 3, 'prompt hooks', () => JSON.stringify(readLog(env.log)));
  assert.deepEqual(readLog(env.log), ['SessionStart', 'UserPromptSubmit', 'Stop']);

  proc.term.write('/exit\r');
  await waitFor(() => proc.exited !== null, 'exit', () => JSON.stringify(proc.output));
  assert.equal(/** @type {{exitCode:number}} */ (proc.exited).exitCode, 0);
  assert.deepEqual(readLog(env.log), ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
});
