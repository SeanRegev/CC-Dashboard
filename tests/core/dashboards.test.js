'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startCore, tempHome, rmrf, waitFor, FIXTURES } = require('./helpers');
const { findLocalUrl, isLocalUrl, readPluginDashboards } = require('../../packages/core/src/dashboards');

const DASH = path.join(FIXTURES, 'fake-dashboard.js');
const PLUGIN_CLAUDE = path.join(FIXTURES, 'fake-plugin-claude.js');
const cmd = (mode) => `"${process.execPath}" "${DASH}" ${mode}`;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** A core with no codeburn on PATH. */
async function core(opts = {}) {
  const home = opts.home || tempHome();
  const c = await startCore({ home, env: { CC_CODEBURN: cmd('term'), ...(opts.env || {}) }, claude: opts.claude });
  c.dash = (id) => c.client.call('dashboards.list').then((l) => l.find((d) => d.id === id));
  return c;
}

test('findLocalUrl / isLocalUrl', () => {
  assert.equal(findLocalUrl('\x1b[36mListening on http://127.0.0.1:4545/ \x1b[0m'), 'http://127.0.0.1:4545/');
  assert.equal(findLocalUrl('open http://localhost:3000.'), 'http://localhost:3000');
  assert.equal(findLocalUrl('see https://example.com and nothing local'), null);
  assert.equal(isLocalUrl('http://localhost:1/x'), true);
  assert.equal(isLocalUrl('http://example.com'), false);
  assert.equal(isLocalUrl('file:///etc/passwd'), false);
  assert.equal(isLocalUrl('http://localhost.evil.com'), false);
});

test('builtin CodeBurn entries; availability follows PATH', async (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bin-'));
  t.after(() => rmrf(bin));
  const none = await startCore({ env: { PATH: bin, Path: bin, CC_CODEBURN: '' } });
  t.after(() => none.dispose());
  let list = await none.client.call('dashboards.list');
  const term = list.find((d) => d.id === 'codeburn-terminal');
  assert.equal(term.kind, 'terminal');
  assert.equal(term.source, 'builtin');
  assert.equal(term.available, false);
  assert.match(term.description, /npm i -g codeburn/);
  assert.equal(list.find((d) => d.id === 'codeburn-web').command, 'npx codeburn web');

  const shim = path.join(bin, process.platform === 'win32' ? 'codeburn.cmd' : 'codeburn');
  fs.writeFileSync(shim, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  const some = await startCore({ env: { PATH: bin, Path: bin, CC_CODEBURN: '' } });
  t.after(() => some.dispose());
  list = await some.client.call('dashboards.list');
  assert.equal(list.find((d) => d.id === 'codeburn-terminal').available, true);
  assert.equal(list.find((d) => d.id === 'codeburn-terminal').command, 'codeburn');
  assert.equal(list.find((d) => d.id === 'codeburn-web').command, 'codeburn web');
});

test('terminal dashboard: start, output, attach replay, input, exit', async (t) => {
  const c = await core();
  t.after(() => c.dispose());
  const out = c.collect('dashboard.output');
  const exits = c.collect('dashboard.exit');
  assert.deepEqual(await c.client.call('dashboards.start', { id: 'codeburn-terminal' }), {});
  await c.client.call('dashboards.attach', { id: 'codeburn-terminal' });
  await waitFor(() => c.client.call('dashboards.attach', { id: 'codeburn-terminal' }).then((r) => /DASH READY/.test(strip(r.replay))), { what: 'replay' });
  // a second start while running is a no-op
  await c.client.call('dashboards.start', { id: 'codeburn-terminal' });
  await c.client.call('dashboards.input', { id: 'codeburn-terminal', data: 'hello\r' });
  await waitFor(() => out.some((o) => o.id === 'codeburn-terminal' && /ECHO: hello/.test(o.data)) || null, { what: 'echo output' });
  const r = await c.client.call('dashboards.attach', { id: 'codeburn-terminal' });
  assert.match(strip(r.replay), /ECHO: hello/);
  await c.client.call('dashboards.resize', { id: 'codeburn-terminal', cols: 100, rows: 30 });
  await c.client.call('dashboards.input', { id: 'codeburn-terminal', data: 'q\r' });
  const ex = await waitFor(() => exits[0], { what: 'dashboard.exit' });
  assert.deepEqual(ex, { id: 'codeburn-terminal', code: 3 });
  await assert.rejects(c.client.call('dashboards.input', { id: 'codeburn-terminal', data: 'x' }), /not running/);
  // replay is kept after exit, and it can be started again
  assert.match(strip((await c.client.call('dashboards.attach', { id: 'codeburn-terminal' })).replay), /ECHO: hello/);
  await c.client.call('dashboards.start', { id: 'codeburn-terminal' });
  await c.client.call('dashboards.input', { id: 'codeburn-terminal', data: 'again\r' });
  await waitFor(() => c.client.call('dashboards.attach', { id: 'codeburn-terminal' }).then((x) => /ECHO: again/.test(x.replay)), { what: 'restart output' });
});

test('stop ends a terminal dashboard; unknown ids are not_found', async (t) => {
  const c = await core();
  t.after(() => c.dispose());
  const exits = c.collect('dashboard.exit');
  await c.client.call('dashboards.start', { id: 'codeburn-terminal' });
  assert.equal(await c.client.call('dashboards.stop', { id: 'codeburn-terminal' }), true);
  await waitFor(() => exits.length, { what: 'exit after stop' });
  await assert.rejects(c.client.call('dashboards.start', { id: 'nope' }), /no dashboard/);
  await assert.rejects(c.client.call('dashboards.attach', { id: 'nope' }), /no dashboard/);
});

test('web dashboard: resolves with the printed URL, stop ends the process', async (t) => {
  const c = await core({ env: { CC_CODEBURN: cmd('web'), FAKE_DASH_PORT: '4747', FAKE_DASH_DELAY: '150' } });
  t.after(() => c.dispose());
  // builtin web command is "<codeburn> web": CC_CODEBURN ends in "web" and the mode arg is then "web web"
  const exits = c.collect('dashboard.exit');
  const r = await c.client.call('dashboards.start', { id: 'codeburn-web' });
  assert.equal(r.url, 'http://127.0.0.1:4747/');
  assert.deepEqual(await c.client.call('dashboards.start', { id: 'codeburn-web' }), { url: 'http://127.0.0.1:4747/' });
  await c.client.call('dashboards.stop', { id: 'codeburn-web' });
  await waitFor(() => exits.length, { what: 'web exit' });
});

test('web dashboard: times out without a URL, and reports an early exit', async (t) => {
  const c = await core({ env: { CC_DASHBOARD_URL_TIMEOUT_MS: '400' } });
  t.after(() => c.dispose());
  const silent = await c.client.call('dashboards.add', { name: 'Silent', kind: 'web', command: cmd('silent') });
  await assert.rejects(c.client.call('dashboards.start', { id: silent.id }), /did not print a local address/);
  const crash = await c.client.call('dashboards.add', { name: 'Crash', kind: 'web', command: cmd('crash') });
  await assert.rejects(c.client.call('dashboards.start', { id: crash.id }), /boom/);
  const missing = await c.client.call('dashboards.add', { name: 'Missing', kind: 'terminal', command: 'definitely-not-a-program-xyz' });
  await assert.rejects(c.client.call('dashboards.start', { id: missing.id }), /not found/);
});

test('user entries: validation, persisted across a core restart, removable', async (t) => {
  const home = tempHome();
  t.after(() => rmrf(home));
  let c = await core({ home });
  await assert.rejects(c.client.call('dashboards.add', { name: '', kind: 'url', url: 'http://x.test' }), /name/);
  await assert.rejects(c.client.call('dashboards.add', { name: 'x', kind: 'terminal' }), /command/);
  await assert.rejects(c.client.call('dashboards.add', { name: 'x', kind: 'url', url: 'javascript:alert(1)' }), /address/);
  await assert.rejects(c.client.call('dashboards.add', { name: 'x', kind: 'page' }), /kind/);
  const changed = c.collect('dashboards.changed');
  const a = await c.client.call('dashboards.add', { name: 'Grafana', kind: 'url', url: 'https://grafana.example.com' });
  const b = await c.client.call('dashboards.add', { name: 'Mine', kind: 'terminal', command: cmd('term') });
  assert.equal(a.source, 'user');
  assert.equal(a.trusted, true);
  await waitFor(() => changed.length >= 2, { what: 'dashboards.changed' });
  assert.ok(changed[1].dashboards.some((d) => d.id === b.id));
  assert.ok(fs.existsSync(path.join(home, 'dashboards.json')));
  await c.stop();

  c = await core({ home });
  t.after(() => c.dispose());
  let list = await c.client.call('dashboards.list');
  assert.deepEqual(list.filter((d) => d.source === 'user').map((d) => d.name), ['Grafana', 'Mine']);
  assert.equal(list.find((d) => d.id === b.id).command, cmd('term'));
  assert.equal(await c.client.call('dashboards.remove', { id: a.id }), true);
  await assert.rejects(c.client.call('dashboards.remove', { id: 'codeburn-terminal' }), /your own/);
  await assert.rejects(c.client.call('dashboards.remove', { id: 'zzz' }), /no dashboard/);
  list = await c.client.call('dashboards.list');
  assert.deepEqual(list.filter((d) => d.source === 'user').map((d) => d.name), ['Mine']);
  // start of a url entry just returns it
  assert.deepEqual(await c.client.call('dashboards.start', { id: 'codeburn-terminal' }), {});
});

/** A plugin folder with the given manifest and files. */
function fakePlugin(root, name, manifest, files = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  if (manifest) fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, ...manifest }));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}

test('readPluginDashboards: manifest field, dashboard/index.html, homepage, escapes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-plug-'));
  t.after(() => rmrf(root));
  const page = fakePlugin(root, 'pg', { dashboard: 'ui/dash.html' }, { 'ui/dash.html': '<h1>x</h1>' });
  const [p] = readPluginDashboards('pg@m', 'pg', page);
  assert.equal(p.kind, 'page');
  assert.equal(p.file, path.join(page, 'ui', 'dash.html'));
  assert.equal(p.id, 'plugin:pg@m');

  const web = fakePlugin(root, 'wb', { dashboard: 'http://localhost:9000/' });
  assert.deepEqual(readPluginDashboards('wb@m', 'wb', web).map((d) => [d.kind, d.url, d.command]), [['web', 'http://localhost:9000/', undefined]]);

  const idx = fakePlugin(root, 'ix', {}, { 'dashboard/index.html': '<p/>' });
  assert.equal(readPluginDashboards('ix@m', 'ix', idx)[0].kind, 'page');

  const home = fakePlugin(root, 'hp', { homepage: 'https://example.com/hp' });
  const [h] = readPluginDashboards('hp@m', 'hp', home);
  assert.deepEqual([h.kind, h.url], ['url', 'https://example.com/hp']);

  const cmdp = fakePlugin(root, 'cm', { dashboard: { name: 'Stats', command: 'stats --live' } });
  const [cm] = readPluginDashboards('cm@m', 'cm', cmdp);
  assert.deepEqual([cm.kind, cm.command, cm.trusted, cm.name], ['terminal', 'stats --live', false, 'Stats']);

  // a path that escapes the plugin folder, a remote "dashboard" URL and a missing file are ignored
  fs.writeFileSync(path.join(root, 'outside.html'), 'x');
  assert.deepEqual(readPluginDashboards('e1', 'e1', fakePlugin(root, 'e1', { dashboard: '../outside.html' })), []);
  assert.deepEqual(readPluginDashboards('e2', 'e2', fakePlugin(root, 'e2', { dashboard: 'https://evil.example/' })), []);
  assert.deepEqual(readPluginDashboards('e3', 'e3', fakePlugin(root, 'e3', { dashboard: 'missing.html' })), []);
  assert.deepEqual(readPluginDashboards('e4', 'e4', fakePlugin(root, 'e4', null)), []);
});

test('plugin dashboards are found through `claude plugin list --json`; commands need trust (remembered)', async (t) => {
  const home = tempHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-plug-'));
  t.after(() => { rmrf(home); rmrf(root); });
  const pg = fakePlugin(root, 'pager', { dashboard: 'd.html' }, { 'd.html': '<h1>hi</h1>' });
  const st = fakePlugin(root, 'stats', { dashboard: { name: 'Stats', command: cmd('term') } });
  const off = fakePlugin(root, 'off', { dashboard: 'd.html' }, { 'd.html': 'x' });
  const listFile = path.join(root, 'plugins.json');
  fs.writeFileSync(listFile, JSON.stringify([
    { id: 'pager@m', installPath: pg, enabled: true },
    { id: 'stats@m', installPath: st },
    { id: 'off@m', installPath: off, enabled: false },
    { id: 'gone@m', installPath: path.join(root, 'nope') },
  ]));
  const claude = `"${process.execPath}" "${PLUGIN_CLAUDE}"`;
  let c = await core({ home, claude, env: { CC_FAKE_PLUGINS: listFile } });
  let list = await c.client.call('dashboards.list');
  const plugins = list.filter((d) => d.source === 'plugin');
  assert.deepEqual(plugins.map((d) => d.id).sort(), ['plugin:pager@m', 'plugin:stats@m']);
  const pager = plugins.find((d) => d.id === 'plugin:pager@m');
  assert.equal(pager.kind, 'page');
  assert.equal(pager.trusted, true);
  const stats = plugins.find((d) => d.id === 'plugin:stats@m');
  assert.equal(stats.trusted, false);
  assert.equal(stats.pluginId, 'stats@m');

  await assert.rejects(c.client.call('dashboards.start', { id: stats.id }), (e) => e.code === 'not_allowed');
  const t1 = await c.client.call('dashboards.trust', { id: stats.id });
  assert.equal(t1.trusted, true);
  await c.client.call('dashboards.start', { id: stats.id });
  await waitFor(() => c.client.call('dashboards.attach', { id: stats.id }).then((r) => /DASH READY/.test(r.replay)), { what: 'plugin output' });
  await c.stop();

  c = await core({ home, claude, env: { CC_FAKE_PLUGINS: listFile } });
  t.after(() => c.dispose());
  list = await c.client.call('dashboards.list');
  assert.equal(list.find((d) => d.id === stats.id).trusted, true, 'trust is remembered');
  // a changed command asks again
  fs.writeFileSync(path.join(st, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'stats', dashboard: { name: 'Stats', command: cmd('crash') } }));
  list = await c.client.call('dashboards.list', { refresh: true });
  assert.equal(list.find((d) => d.id === stats.id).trusted, false);
});

test('listing works when claude is missing', async (t) => {
  const c = await core({ claude: 'definitely-not-claude-xyz' });
  t.after(() => c.dispose());
  const list = await c.client.call('dashboards.list');
  assert.ok(list.some((d) => d.id === 'codeburn-terminal'));
});

test('core shutdown stops running dashboards', async (t) => {
  const c = await core({ env: { CC_CODEBURN: cmd('web'), FAKE_DASH_PORT: '4748' } });
  await c.client.call('dashboards.start', { id: 'codeburn-web' });
  await c.client.call('dashboards.start', { id: 'codeburn-terminal' });
  const r = await c.stop();
  assert.ok(r);
});

test('childSpawn: a Windows command line keeps its program path quoted as argv0, POSIX args pass through', () => {
  const { childSpawn } = require('../../packages/core/src/dashboards');
  const win = childSpawn({ file: 'C:\\Program Files\\nodejs\\node.exe', args: '"C:\\Users\\Ann Lee\\codeburn.js" web' });
  assert.deepEqual(win, { file: 'C:\\Program Files\\nodejs\\node.exe', args: ['"C:\\Users\\Ann Lee\\codeburn.js" web'], verbatim: true, argv0: '"C:\\Program Files\\nodejs\\node.exe"' });
  const posix = childSpawn({ file: '/usr/bin/codeburn', args: ['web', '--port', '1'] });
  assert.deepEqual(posix, { file: '/usr/bin/codeburn', args: ['web', '--port', '1'], verbatim: false, argv0: undefined });
});
