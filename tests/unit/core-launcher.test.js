// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../../packages/app/src/main/core-launcher.js');
const { startMockCore } = require('../../packages/app/src/renderer/dev/mock-core.js');

const MOCK = path.join(__dirname, '..', '..', 'packages', 'app', 'src', 'renderer', 'dev', 'mock-core.js');
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launch-'));

test('readCoreJson: missing, malformed and valid', () => {
  const home = tmpHome();
  assert.equal(L.readCoreJson(home), null);
  fs.writeFileSync(path.join(home, 'core.json'), '{nope');
  assert.equal(L.readCoreJson(home), null);
  fs.writeFileSync(path.join(home, 'core.json'), JSON.stringify({ port: '1', token: 'x' }));
  assert.equal(L.readCoreJson(home), null);
  fs.writeFileSync(path.join(home, 'core.json'), JSON.stringify({ port: 1234, token: 'x', pid: 1, version: '1' }));
  assert.deepEqual(L.readCoreJson(home), { port: 1234, token: 'x', pid: 1, version: '1' });
});

test('isPidAlive', () => {
  assert.equal(L.isPidAlive(process.pid), true);
  assert.equal(L.isPidAlive(undefined), true);
  assert.equal(L.isPidAlive(2 ** 22 + 12345), false);
});

test('findCore: live core found; stale core.json ignored', async (t) => {
  const home = tmpHome();
  const mock = await startMockCore({ home, static: true });
  t.after(() => mock.close());
  const found = await L.findCore(home);
  assert.ok(found);
  assert.equal(found.port, mock.port);
  const stale = tmpHome();
  fs.writeFileSync(path.join(stale, 'core.json'), JSON.stringify({ port: 1, token: 'dead', pid: process.pid }));
  assert.equal(await L.findCore(stale), null);
});

test('coreCommand: packaged uses Electron as Node and the unpacked entry; dev uses node / CC_CORE_NODE', () => {
  const appRoot = path.join('C:', 'app', 'resources', 'app.asar');
  const packaged = L.coreCommand({ isPackaged: true, execPath: path.join('C:', 'app', 'CC-Dashboard.exe'), appRoot, resourcesPath: path.join('C:', 'app', 'resources'), env: { CC_HOME: 'h' } });
  assert.equal(packaged.command, path.join('C:', 'app', 'CC-Dashboard.exe'));
  assert.deepEqual(packaged.args, [path.join('C:', 'app', 'resources', 'app.asar.unpacked', 'packages', 'core', 'src', 'index.js')]);
  assert.equal(packaged.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(packaged.env.CC_HOME, 'h');
  assert.ok(!packaged.args[0].includes(`app.asar${path.sep}`));

  const dev = L.coreCommand({ isPackaged: false, execPath: 'electron', appRoot: path.join('repo'), env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(dev.command, process.platform === 'win32' ? 'node.exe' : 'node');
  assert.deepEqual(dev.args, [path.join('repo', 'packages', 'core', 'src', 'index.js')]);
  assert.equal(dev.env.ELECTRON_RUN_AS_NODE, undefined);

  const custom = L.coreCommand({ isPackaged: false, execPath: 'electron', appRoot: 'repo', env: { CC_CORE_NODE: 'my-node', CC_CORE_ENTRY: 'entry.js' } });
  assert.equal(custom.command, 'my-node');
  assert.deepEqual(custom.args, ['entry.js']);
  assert.equal(custom.env.CC_CORE_ENTRY, undefined);
});

test('ensureCore starts a detached core when none is running, then reuses it', async (t) => {
  const home = tmpHome();
  const env = { ...process.env, CC_HOME: home, CC_CORE_NODE: process.execPath, CC_CORE_ENTRY: MOCK, MOCK_STATIC: '1' };
  const info = await L.ensureCore({ home, isPackaged: false, execPath: process.execPath, appRoot: 'unused', env, timeoutMs: 15000 });
  t.after(() => { try { process.kill(/** @type {number} */ (info.pid)); } catch { /* gone */ } });
  assert.ok(info.port > 0);
  assert.notEqual(info.pid, process.pid);
  assert.ok(await L.checkHealth(info));
  const again = await L.ensureCore({ home, isPackaged: false, execPath: process.execPath, appRoot: 'unused', env });
  assert.equal(again.pid, info.pid);
});

test('ensureCore fails clearly when the core cannot start', async () => {
  const home = tmpHome();
  const env = { ...process.env, CC_CORE_NODE: process.execPath, CC_CORE_ENTRY: path.join(home, 'missing.js') };
  await assert.rejects(L.ensureCore({ home, isPackaged: false, execPath: process.execPath, appRoot: 'x', env, timeoutMs: 1500 }), /did not start/);
});
