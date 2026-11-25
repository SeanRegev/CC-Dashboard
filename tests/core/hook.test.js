'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, exec } = require('child_process');
const { HOOK_EVENTS } = require('../../packages/shared/protocol');
const { buildSettings, ensureSettings, launcherText, HOOK_SCRIPT } = require('../../packages/core/src/hooks-settings');
const { tempHome, rmrf } = require('./helpers');

/** Run hook.js like Claude would; resolves with exit code, stdout and how long it took. */
function runHook(env, input = '{"session_id":"s"}', event = 'Stop') {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, [HOOK_SCRIPT, event], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('exit', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    p.stdin.end(input);
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = /** @type {any} */ (s.address()); s.close(() => resolve(port)); });
  });
}

test('hook.js exits 0 silently when the core is down', async () => {
  const port = await freePort();
  const r = await runHook({ CC_AGENT_ID: 'a', CC_CORE_URL: `http://127.0.0.1:${port}`, CC_TOKEN: 't' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.ok(r.ms < 2500, `took ${r.ms} ms`);
});

test('hook.js gives up within ~2 s when the core hangs', async (t) => {
  const sockets = [];
  const server = net.createServer((s) => sockets.push(s)); // accepts, never answers
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { sockets.forEach((s) => s.destroy()); server.close(); });
  const r = await runHook({ CC_AGENT_ID: 'a', CC_CORE_URL: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, CC_TOKEN: 't' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(r.ms < 3000, `took ${r.ms} ms`);
});

test('hook.js does nothing for a claude the core did not start', async () => {
  const r = await runHook({ CC_AGENT_ID: '', CC_CORE_URL: '' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('hook.js posts the payload with event, agent and token', async (t) => {
  let got;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got = { url: req.url, event: req.headers['x-cc-event'], token: req.headers['x-cc-token'], body: Buffer.concat(chunks).toString() };
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const r = await runHook({ CC_AGENT_ID: 'my agent', CC_CORE_URL: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, CC_TOKEN: 'tok' }, '{"prompt":"hi ✓"}', 'UserPromptSubmit');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.deepEqual(got, { url: '/hook?agent=my%20agent', event: 'UserPromptSubmit', token: 'tok', body: '{"prompt":"hi ✓"}' });
});

test('hooks settings register every event through the launcher, matcher "" for tool events', () => {
  const s = buildSettings('C:\\Users\\me\\.cc-dashboard\\cc-hook.cmd');
  assert.deepEqual(Object.keys(s.hooks).sort(), [...HOOK_EVENTS].sort());
  for (const event of HOOK_EVENTS) {
    const [entry] = s.hooks[event];
    assert.equal(entry.hooks[0].type, 'command');
    assert.equal(entry.hooks[0].command, `"C:/Users/me/.cc-dashboard/cc-hook.cmd" ${event}`);
    if (['PreToolUse', 'PostToolUse', 'PermissionRequest'].includes(event)) assert.equal(entry.matcher, '');
    else assert.equal(entry.matcher, undefined);
  }
});

test('hook launcher sets ELECTRON_RUN_AS_NODE for hook.js only', () => {
  const win = launcherText('C:\\Program Files\\App\\app.exe', 'C:\\x\\hook.js', 'win32');
  assert.equal(win, '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\App\\app.exe" "C:\\x\\hook.js" %*\r\n');
  const sh = launcherText('/opt/app/app', "/it's/hook.js", 'linux');
  assert.equal(sh, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/opt/app/app' '/it'\\''s/hook.js' "$@"\n`);
});

test('the generated launcher really runs hook.js (through the shell, like Claude does)', async (t) => {
  const home = tempHome();
  t.after(() => rmrf(home));
  const file = ensureSettings(home);
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const launcher = path.join(home, process.platform === 'win32' ? 'cc-hook.cmd' : 'cc-hook.sh');
  assert.ok(fs.existsSync(launcher));
  if (process.platform !== 'win32') assert.equal(fs.statSync(launcher).mode & 0o111, 0o111);
  let got;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { got = { event: req.headers['x-cc-event'], body: Buffer.concat(chunks).toString() }; res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  // Async on purpose: the test server lives in this process.
  const out = await new Promise((resolve, reject) => {
    const p = exec(settings.hooks.Stop[0].hooks[0].command, {
      timeout: 10000,
      env: { ...process.env, CC_AGENT_ID: 'a', CC_CORE_URL: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, CC_TOKEN: 't' },
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    /** @type {any} */ (p.stdin).end('{"x":1}');
  });
  assert.equal(out, '');
  assert.deepEqual(got, { event: 'Stop', body: '{"x":1}' });
});
