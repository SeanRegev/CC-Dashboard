// @ts-check
'use strict';
/**
 * App settings (theme, terminal font, notifications), saved as JSON in <CC_HOME>/ui-settings.json, and the
 * "Quit and stop all agents" action. Owner: the Settings track (M2).
 * IPC: cc:getSettings → object, cc:setSettings { patch } → object (and 'cc:settings' pushed to the window),
 *      cc:quitAll → stops the core (core.shutdown over RPC), waits briefly for it to exit, then quits the app.
 */
const fs = require('fs');
const path = require('path');
const { readCoreJson, isPidAlive } = require('./core-launcher.js');

/** Same string as TERMINAL_FONT in renderer/terminal.js (a unit test keeps them equal). */
const DEFAULT_FONT = '"Cascadia Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace';

const THEMES = Object.freeze(['dark', 'light', 'system']);
const NOTIFICATIONS = Object.freeze(['all', 'needs_you', 'off']);

const DEFAULTS = Object.freeze({
  theme: 'dark',
  terminalFontSize: 13,
  terminalFontFamily: DEFAULT_FONT,
  notifications: 'all',
  sound: true,
});

/**
 * Validate settings: unknown keys are dropped, wrong types fall back to the default (or to `base`
 * when given, so a bad patch value keeps the value that was set before).
 * @param {any} input
 * @param {Record<string, any>} [base]
 * @returns {{theme:'dark'|'light'|'system', terminalFontSize:number, terminalFontFamily:string, notifications:'all'|'needs_you'|'off', sound:boolean}}
 */
function validateSettings(input, base = DEFAULTS) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const fb = { ...DEFAULTS, ...base };
  const theme = THEMES.includes(src.theme) ? src.theme : fb.theme;
  let size = fb.terminalFontSize;
  if (typeof src.terminalFontSize === 'number' && Number.isFinite(src.terminalFontSize)) {
    size = Math.min(24, Math.max(10, Math.round(src.terminalFontSize)));
  }
  let family = fb.terminalFontFamily;
  if (typeof src.terminalFontFamily === 'string') {
    const f = src.terminalFontFamily.trim().slice(0, 300);
    family = f || DEFAULTS.terminalFontFamily;
  }
  const notifications = NOTIFICATIONS.includes(src.notifications) ? src.notifications : fb.notifications;
  const sound = typeof src.sound === 'boolean' ? src.sound : fb.sound;
  return { theme, terminalFontSize: size, terminalFontFamily: family, notifications, sound };
}

/** @param {string} home */
function settingsFile(home) { return path.join(home, 'ui-settings.json'); }

/** @param {string} home */
function loadSettings(home) {
  try {
    return validateSettings(JSON.parse(fs.readFileSync(settingsFile(home), 'utf8')));
  } catch {
    return validateSettings({});
  }
}

/** Atomic write: temp file, then rename. @param {string} home @param {object} settings */
function saveSettings(home, settings) {
  const file = settingsFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Ask the core to stop every agent and exit (core.shutdown over its WebSocket), then wait until it is gone:
 * the socket closes or its pid is dead, at most `waitMs`. Resolves true when a core was asked, false when none runs.
 * @param {string} home @param {{waitMs?: number}} [o]
 */
async function shutdownCore(home, o = {}) {
  const info = readCoreJson(home);
  if (!info || !isPidAlive(info.pid)) return false;
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/rpc?token=${encodeURIComponent(info.token)}`);
  const closed = new Promise((resolve) => { ws.once('close', () => resolve(true)); ws.once('error', () => resolve(true)); });
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  } catch { return false; }
  const answered = new Promise((resolve) => {
    ws.on('message', (raw) => {
      try { if (JSON.parse(String(raw)).id === 1) resolve(true); } catch { /* event */ }
    });
  });
  ws.send(JSON.stringify({ id: 1, method: 'core.shutdown', params: {} }));
  const deadline = Date.now() + (o.waitMs ?? 4000);
  const left = () => Math.max(0, deadline - Date.now());
  await Promise.race([answered, closed, new Promise((r) => setTimeout(r, left()))]);
  // the core exits right after answering: wait for the socket to close or the process to go
  const gone = new Promise((resolve) => {
    const t = setInterval(() => { if (!isPidAlive(info.pid)) { clearInterval(t); resolve(true); } }, 100);
    setTimeout(() => { clearInterval(t); resolve(false); }, left());
  });
  await Promise.race([closed, gone]);
  try { ws.terminate(); } catch { /* closed */ }
  return true;
}

/**
 * Window background and the Windows/Linux window-button overlay follow the theme.
 * @param {Electron.BrowserWindow|null} win @param {{theme: string}} settings
 */
function applyChrome(win, settings) {
  if (!win || win.isDestroyed()) return;
  try {
    const { nativeTheme } = require('electron');
    const light = settings.theme === 'light' || (settings.theme === 'system' && !nativeTheme.shouldUseDarkColors);
    const bg = light ? '#ECE7E2' : '#141312';
    win.setBackgroundColor(bg);
    if (process.platform !== 'darwin' && typeof win.setTitleBarOverlay === 'function') {
      win.setTitleBarOverlay({ color: bg, symbolColor: light ? '#5C554F' : '#B5AEA7', height: 44 });
    }
  } catch { /* no overlay on this platform */ }
}

/** @param {{ipcMain: Electron.IpcMain, app: Electron.App, getWindow: () => Electron.BrowserWindow|null, home: string}} deps */
function register(deps) {
  const { ipcMain, app, getWindow, home } = deps;
  let settings = loadSettings(home);
  ipcMain.handle('cc:getSettings', () => { applyChrome(getWindow(), settings); return settings; });
  ipcMain.handle('cc:setSettings', (_e, /** @type {any} */ msg) => {
    const patch = msg && typeof msg.patch === 'object' && msg.patch ? msg.patch : {};
    settings = validateSettings(patch, settings);
    try { saveSettings(home, settings); } catch (e) { console.error('settings not saved:', String(e && /** @type {any} */ (e).message)); }
    const win = getWindow();
    applyChrome(win, settings);
    if (win && !win.isDestroyed()) win.webContents.send('cc:settings', settings);
    return settings;
  });
  ipcMain.handle('cc:quitAll', async () => {
    let asked = false;
    try { asked = await shutdownCore(home); } catch (e) { console.error('core.shutdown failed:', String(e && /** @type {any} */ (e).message)); }
    setTimeout(() => app.quit(), 50);
    return asked;
  });
}

module.exports = { register, validateSettings, loadSettings, saveSettings, shutdownCore, DEFAULTS, DEFAULT_FONT };
