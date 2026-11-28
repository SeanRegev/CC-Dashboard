'use strict';
// M4 track A: statusline-relay.js, the status-line command of every agent. It must print the user's own
// line unchanged (or a short default), nothing else, and never be held up by the core.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { STATUSLINE_SCRIPT, ensureSettings } = require('../../packages/core/src/hooks-settings');
const { userRun, claudeShell } = require('../../packages/core/src/statusline');
const { tempHome, rmrf } = require('./helpers');

const SAMPLE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'statusline', 'sample.json'), 'utf8');
const STARTUP = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'statusline', 'startup.json'), 'utf8');

/** A user status-line script: prints "USER <model> <pct>% <first arg>" from its stdin, to stderr "warn", exits with $SL_EXIT. */
function userScript(dir) {
  const file = path.join(dir, 'my-line.js');
  fs.writeFileSync(file, [
    "let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => {",
    '  const p = JSON.parse(s);',
    "  process.stdout.write(`USER ${p.model.display_name} ${p.context_window.used_percentage}% ${process.argv[2] || ''} ✓\\n\\x1b[2mline two\\x1b[0m\\n`);",
    "  process.stderr.write('warn');",
    '  process.exit(Number(process.env.SL_EXIT || 0));',
    '});',
  ].join('\n'));
  return file;
}

/**
 * Run the relay like Claude does (stdin JSON) and collect what it printed.
 * @param {Record<string, string|undefined>} env @param {string} [input] @param {string[]} [cmd] a different command line (through the shell)
 */
function runRelay(env, input = SAMPLE, cmd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const full = { ...process.env, CC_AGENT_ID: '', CC_CORE_URL: '', CC_STATUSLINE: '', ...env };
    for (const [k, v] of Object.entries(full)) if (v === undefined) delete full[k];
    const p = cmd
      ? spawn(cmd[0], { shell: cmd[1] || true, env: full, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(process.execPath, [STATUSLINE_SCRIPT], { env: full, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    let stderr = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr, ms: Date.now() - started }));
    p.stdin.end(input);
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = /** @type {any} */ (s.address()); s.close(() => resolve(port)); });
  });
}

/** A core stand-in that records what was posted. @param {number} [delayMs] */
async function fakeCore(t, delayMs = 0) {
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ url: req.url, token: req.headers['x-cc-token'], body: Buffer.concat(chunks).toString('utf8') });
      setTimeout(() => { res.end('{"ok":true}'); }, delayMs);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { got, url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
}

/** CC_STATUSLINE for a user command, resolved the way the core does at launch. @param {string} command */
const runFor = (command) => JSON.stringify(userRun(command, claudeShell(process.env), process.env));

test('no status line of its own: a short default from the snapshot', async () => {
  const r = await runRelay({});
  assert.deepEqual(r, { ...r, code: 0, stdout: 'Haiku 5.5 · ctx 10% · 5h 62%\n', stderr: '' });
  const s = await runRelay({}, STARTUP); // before the first reply: no % yet, no limits
  assert.equal(s.stdout, 'Haiku 5.5\n');
  for (const junk of ['', 'not json', '"str"', '[]', '{"model":null,"context_window":{"used_percentage":"x"}}']) {
    const j = await runRelay({}, junk);
    assert.equal(j.code, 0, junk);
    assert.equal(j.stdout, '', junk);
    assert.equal(j.stderr, '', junk);
  }
});

test('the user\'s own status line: same stdin, stdout as is, stderr and exit code passed through', async (t) => {
  const dir = tempHome();
  t.after(() => rmrf(dir));
  const script = userScript(dir).replace(/\\/g, '/');
  const command = `node "${script}" arg1`;
  const r = await runRelay({ CC_STATUSLINE: runFor(command) });
  assert.equal(r.stdout, 'USER Haiku 5.5 10% arg1 ✓\n\x1b[2mline two\x1b[0m\n');
  assert.equal(r.stderr, 'warn');
  assert.equal(r.code, 0);
  const bad = await runRelay({ CC_STATUSLINE: runFor(command), SL_EXIT: '3' });
  assert.equal(bad.code, 3);
  assert.match(bad.stdout, /^USER /);
  // The relay's own ELECTRON_RUN_AS_NODE never reaches the user's command; the nesting guard does.
  const envScript = path.join(dir, 'env.js');
  fs.writeFileSync(envScript, "process.stdout.write(`[${process.env.ELECTRON_RUN_AS_NODE || ''}][${process.env.CC_STATUSLINE_DEPTH}]`)");
  const e = await runRelay({ CC_STATUSLINE: runFor(`node "${envScript.replace(/\\/g, '/')}"`), ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(e.stdout, '[][1]');
});

test('a user command that cannot start, or a broken CC_STATUSLINE, never hangs or prints junk', async () => {
  const missing = await runRelay({ CC_STATUSLINE: JSON.stringify({ file: path.join(__dirname, 'no-such-program.exe'), args: [] }) });
  assert.equal(missing.stdout, '');
  assert.notEqual(missing.code, 0);
  const broken = await runRelay({ CC_STATUSLINE: '{nope' });
  assert.equal(broken.stdout, 'Haiku 5.5 · ctx 10% · 5h 62%\n'); // falls back to the default
  assert.equal(broken.code, 0);
  // Run inside a user command again (it never should be): no loop, the default only.
  const nested = await runRelay({ CC_STATUSLINE: runFor('echo loop'), CC_STATUSLINE_DEPTH: '1' });
  assert.equal(nested.stdout, 'Haiku 5.5 · ctx 10% · 5h 62%\n');
});

test('at its timeout the user command is ended with everything it started', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sl-tree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'grandchild.pid');
  // The user's command starts a long-lived grandchild and waits on it, like a shell running a script.
  const parent = path.join(dir, 'parent.js');
  fs.writeFileSync(parent, `const { spawn } = require('child_process');
const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: process.platform === 'win32' }); // outside node's kill-on-close job, like a bash child
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
setTimeout(() => {}, 60000);`);
  const r = await runRelay({ CC_STATUSLINE: JSON.stringify({ file: process.execPath, args: [parent], timeoutMs: 1500 }) });
  assert.equal(r.code, 1);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === 'EPERM'; } };
  const end = Date.now() + 5000;
  while (alive() && Date.now() < end) await new Promise((res) => setTimeout(res, 100));
  const still = alive();
  if (still) try { process.kill(pid); } catch { /* gone */ }
  assert.equal(still, false, 'the grandchild was ended too');
});

test('a user command that hangs is stopped at its timeout', async () => {
  const r = await runRelay({ CC_STATUSLINE: JSON.stringify({ file: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 500 }) });
  assert.equal(r.code, 1);
  assert.ok(r.ms < 4000, `took ${r.ms} ms`);
});

test('posts the snapshot with agent and token, and prints the line too', async (t) => {
  const core = await fakeCore(t);
  const r = await runRelay({ CC_AGENT_ID: 'my agent', CC_CORE_URL: core.url, CC_TOKEN: 'tok' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'Haiku 5.5 · ctx 10% · 5h 62%\n');
  assert.deepEqual(core.got, [{ url: '/statusline?agent=my%20agent', token: 'tok', body: SAMPLE }]);
});

test('without CC_AGENT_ID (a claude the core did not start): the line only, no post', async (t) => {
  const core = await fakeCore(t);
  const r = await runRelay({ CC_CORE_URL: core.url, CC_AGENT_ID: undefined });
  assert.equal(r.stdout, 'Haiku 5.5 · ctx 10% · 5h 62%\n');
  assert.deepEqual(core.got, []);
});

test('a dead core never delays the line', async () => {
  const port = await freePort();
  const r = await runRelay({ CC_AGENT_ID: 'a', CC_CORE_URL: `http://127.0.0.1:${port}`, CC_TOKEN: 't' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'Haiku 5.5 · ctx 10% · 5h 62%\n');
  assert.equal(r.stderr, '');
  assert.ok(r.ms < 1500, `took ${r.ms} ms`);
});

test('a hung core delays the line by a moment at most', async (t) => {
  const sockets = [];
  // Accepts, never answers. When the relay leaves, Windows resets the connection: expected here.
  const server = net.createServer((s) => { s.on('error', () => {}); sockets.push(s); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { sockets.forEach((s) => s.destroy()); server.close(); });
  const r = await runRelay({ CC_AGENT_ID: 'a', CC_CORE_URL: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, CC_TOKEN: 't' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'Haiku 5.5 · ctx 10% · 5h 62%\n');
  assert.ok(r.ms < 1500, `took ${r.ms} ms (the POST grace is 300 ms)`);
  // A slow user command gives a slow core the time it needs.
  const slow = await fakeCore(t, 600);
  const dir = tempHome();
  t.after(() => rmrf(dir));
  const sleepy = path.join(dir, 'sleepy.js').replace(/\\/g, '/');
  fs.writeFileSync(sleepy, "setTimeout(() => process.stdout.write('slow line'), 800)");
  const s = await runRelay({ CC_AGENT_ID: 'a', CC_CORE_URL: slow.url, CC_STATUSLINE: runFor(`node "${sleepy}"`) });
  assert.equal(s.stdout, 'slow line');
  assert.equal(slow.got.length, 1);
});

test('the generated launcher runs the relay through the shell, like Claude', async (t) => {
  const home = tempHome();
  t.after(() => rmrf(home));
  const settings = JSON.parse(fs.readFileSync(ensureSettings(home), 'utf8'));
  const launcher = path.join(home, process.platform === 'win32' ? 'cc-statusline.cmd' : 'cc-statusline.sh');
  assert.ok(fs.existsSync(launcher));
  if (process.platform !== 'win32') assert.equal(fs.statSync(launcher).mode & 0o111, 0o111);
  const core = await fakeCore(t);
  const dir = tempHome();
  t.after(() => rmrf(dir));
  const user = runFor(`node "${userScript(dir).replace(/\\/g, '/')}"`);
  // cmd.exe (or /bin/sh), then Git Bash on Windows: Claude uses Git Bash when it finds one.
  const shells = [true];
  const sh = claudeShell(process.env);
  if (process.platform === 'win32' && sh.bash) shells.push(sh.bash);
  for (const shell of shells) {
    core.got.length = 0;
    const r = await runRelay({ CC_AGENT_ID: 'a', CC_CORE_URL: core.url, CC_TOKEN: 't', CC_STATUSLINE: user }, SAMPLE, [settings.statusLine.command, shell]);
    assert.equal(r.stdout, 'USER Haiku 5.5 10%  ✓\n\x1b[2mline two\x1b[0m\n', `shell ${shell}`);
    assert.equal(r.code, 0, `shell ${shell}`);
    assert.equal(core.got.length, 1, `shell ${shell}`);
    assert.equal(core.got[0].body, SAMPLE);
  }
});

test('without Git Bash Claude uses PowerShell: the PowerShell form of our command runs the relay', { skip: process.platform !== 'win32' }, async (t) => {
  const home = tempHome();
  t.after(() => rmrf(home));
  const settings = JSON.parse(fs.readFileSync(ensureSettings(home, { shell: 'powershell' }), 'utf8'));
  assert.match(settings.statusLine.command, /^& '.*cc-statusline\.cmd'$/);
  const core = await fakeCore(t);
  const r = await new Promise((resolve) => {
    const env = { ...process.env, CC_AGENT_ID: 'a', CC_CORE_URL: core.url, CC_TOKEN: 't' };
    delete env.CC_STATUSLINE;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', settings.statusLine.command], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.on('close', (code) => resolve({ code, stdout }));
    p.stdin.end(SAMPLE);
  });
  assert.equal(r.code, 0);
  assert.equal(core.got.length, 1);
  assert.equal(core.got[0].body, SAMPLE);
  assert.match(r.stdout, /^Haiku 5\.5 .* ctx 10% .* 5h 62%\r?\n$/); // PowerShell may re-encode the middle dot
});
