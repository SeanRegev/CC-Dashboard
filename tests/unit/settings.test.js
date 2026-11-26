// @ts-check
'use strict';
// Settings storage + validation (main/settings.js) and the renderer's notification policy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { validateSettings, loadSettings, saveSettings, shutdownCore, DEFAULTS, DEFAULT_FONT } = require('../../packages/app/src/main/settings.js');

const RENDERER = path.join(__dirname, '..', '..', 'packages', 'app', 'src', 'renderer');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-settings-'));

test('defaults: dark, 13px, the terminal font, all notifications, sound on', () => {
  assert.deepEqual(validateSettings({}), { theme: 'dark', terminalFontSize: 13, terminalFontFamily: DEFAULT_FONT, notifications: 'all', sound: true });
  assert.deepEqual(validateSettings(null), { ...DEFAULTS });
  assert.deepEqual(validateSettings('x'), { ...DEFAULTS });
  assert.deepEqual(validateSettings([1]), { ...DEFAULTS });
});

test('the default font is the one terminal.js uses', async () => {
  const t = await import(pathToFileURL(path.join(RENDERER, 'terminal.js')).href);
  assert.equal(DEFAULT_FONT, t.TERMINAL_FONT);
});

test('valid values are kept, unknown keys are dropped', () => {
  const s = validateSettings({ theme: 'light', terminalFontSize: 18, terminalFontFamily: 'Fira Code', notifications: 'needs_you', sound: false, evil: 1, __proto__: { x: 1 } });
  assert.deepEqual(s, { theme: 'light', terminalFontSize: 18, terminalFontFamily: 'Fira Code', notifications: 'needs_you', sound: false });
});

test('wrong types and unknown enum values fall back to the default', () => {
  const s = validateSettings({ theme: 'purple', terminalFontSize: '18', terminalFontFamily: 5, notifications: true, sound: 'yes' });
  assert.deepEqual(s, { ...DEFAULTS });
  assert.equal(validateSettings({ terminalFontSize: NaN }).terminalFontSize, 13);
  assert.equal(validateSettings({ terminalFontSize: Infinity }).terminalFontSize, 13);
});

test('font size is clamped to 10..24 and rounded; a blank family resets to the default', () => {
  assert.equal(validateSettings({ terminalFontSize: 3 }).terminalFontSize, 10);
  assert.equal(validateSettings({ terminalFontSize: 99 }).terminalFontSize, 24);
  assert.equal(validateSettings({ terminalFontSize: 14.6 }).terminalFontSize, 15);
  assert.equal(validateSettings({ terminalFontFamily: '   ' }).terminalFontFamily, DEFAULT_FONT);
  assert.equal(validateSettings({ terminalFontFamily: ` Consolas ` }).terminalFontFamily, 'Consolas');
  assert.equal(validateSettings({ terminalFontFamily: 'x'.repeat(1000) }).terminalFontFamily.length, 300);
});

test('a patch keeps the previous value where it is invalid or missing', () => {
  const base = validateSettings({ theme: 'light', terminalFontSize: 20 });
  assert.deepEqual(validateSettings({ theme: 'nope' }, base), base);
  assert.equal(validateSettings({ sound: false }, base).theme, 'light');
  assert.equal(validateSettings({ sound: false }, base).sound, false);
});

test('save is atomic JSON in ui-settings.json; load merges defaults and survives garbage', () => {
  const home = tmp();
  assert.deepEqual(loadSettings(home), { ...DEFAULTS });
  saveSettings(home, validateSettings({ theme: 'system', terminalFontSize: 16 }));
  assert.deepEqual(fs.readdirSync(home), ['ui-settings.json'], 'no temp file left behind');
  const back = loadSettings(home);
  assert.equal(back.theme, 'system');
  assert.equal(back.terminalFontSize, 16);
  assert.equal(back.notifications, 'all');
  fs.writeFileSync(path.join(home, 'ui-settings.json'), '{ not json');
  assert.deepEqual(loadSettings(home), { ...DEFAULTS });
  fs.writeFileSync(path.join(home, 'ui-settings.json'), JSON.stringify({ theme: 'light', junk: 1, terminalFontSize: 'big' }));
  assert.deepEqual(loadSettings(home), { ...DEFAULTS, theme: 'light' });
  fs.rmSync(home, { recursive: true, force: true });
});

test('notification policy: all / needs_you / off', async () => {
  const { notificationAllowed } = await import(pathToFileURL(path.join(RENDERER, 'views', 'settings.js')).href);
  const needs = { title: 'api needs you', body: 'x' };
  const done = { title: 'api is done (1m2s)', body: 'x' };
  assert.equal(notificationAllowed({ notifications: 'all' }, done), true);
  assert.equal(notificationAllowed({ notifications: 'off' }, needs), false);
  assert.equal(notificationAllowed({ notifications: 'needs_you' }, needs), true);
  assert.equal(notificationAllowed({ notifications: 'needs_you' }, done), false);
  assert.equal(notificationAllowed({ notifications: 'needs_you' }, { kind: 'needs_you', title: 'x' }), true);
  assert.equal(notificationAllowed({ notifications: 'needs_you' }, { kind: 'done', title: 'a needs you' }), false);
});

test('shutdownCore: sends core.shutdown over the WebSocket; false when no core runs', async () => {
  const home = tmp();
  assert.equal(await shutdownCore(home), false);
  const { WebSocketServer } = require('ws');
  const token = 'tok';
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/rpc' });
  /** @type {any[]} */
  const got = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      got.push(m);
      ws.send(JSON.stringify({ id: m.id, result: true }));
      setTimeout(() => ws.close(), 20);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {any} */ (server.address()).port;
  fs.writeFileSync(path.join(home, 'core.json'), JSON.stringify({ port, token, pid: process.pid }));
  assert.equal(await shutdownCore(home, { waitMs: 2000 }), true);
  assert.equal(got.length, 1);
  assert.equal(got[0].method, 'core.shutdown');
  wss.close();
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});
