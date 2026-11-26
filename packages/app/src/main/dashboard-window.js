// @ts-check
'use strict';
/**
 * Dashboard windows: a plugin's HTML page or a local web dashboard (e.g. `codeburn web`), in a locked-down
 * window: sandboxed, no preload, no Node, own in-memory session, navigation pinned to that file's folder /
 * that origin, other links → default browser. Owner: the Dashboards track (M2).
 * IPC: cc:openDashboard { title, url? , file? }, cc:openExternal { url }.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

/** @param {string} h */
const isLocalHost = (h) => h === 'localhost' || h === '127.0.0.1';

/**
 * Decide what a dashboard window may show. Pure (the file check is injectable for tests).
 * @param {{title?: string, url?: string, file?: string}} spec
 * @param {{exists?: (file: string) => boolean}} [deps]
 * @returns {{ok: true, kind: 'url'|'file', href: string, origin?: string, dir?: string, title: string} | {ok: false, error: string}}
 */
function resolveDashboardTarget(spec, deps = {}) {
  const exists = deps.exists || ((/** @type {string} */ f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  const title = spec && typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim().slice(0, 80) : 'Dashboard';
  const hasUrl = !!(spec && spec.url);
  const hasFile = !!(spec && spec.file);
  if (hasUrl === hasFile) return { ok: false, error: 'give either url or file' };
  if (hasUrl) {
    let u;
    try { u = new URL(String(spec.url)); } catch { return { ok: false, error: 'not a valid address' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'only http(s) addresses can be opened' };
    if (!isLocalHost(u.hostname)) return { ok: false, error: 'only localhost / 127.0.0.1 addresses can be opened here' };
    if (u.username || u.password) return { ok: false, error: 'addresses with a login are not allowed' };
    return { ok: true, kind: 'url', href: u.toString(), origin: u.origin, title };
  }
  const file = String(spec.file);
  if (!path.isAbsolute(file)) return { ok: false, error: 'the file must be an absolute path' };
  if (!/\.html?$/i.test(file)) return { ok: false, error: 'only .html files can be opened' };
  if (!exists(file)) return { ok: false, error: 'the file does not exist' };
  return { ok: true, kind: 'file', href: pathToFileURL(file).toString(), dir: path.dirname(file), title };
}

/**
 * May the window navigate to `to`? url target: same origin only. file target: a file: URL inside the page's folder.
 * @param {{kind: 'url'|'file', origin?: string, dir?: string}} target @param {string} to
 */
function isNavigationAllowed(target, to) {
  let u;
  try { u = new URL(to); } catch { return false; }
  if (target.kind === 'url') return u.origin === target.origin && u.origin !== 'null';
  if (u.protocol !== 'file:' || !target.dir) return false;
  let p;
  try { p = fileURLToPath(u); } catch { return false; }
  const rel = path.relative(target.dir, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** @param {any} _e */
const noop = (_e) => {};

/** @param {{ipcMain: Electron.IpcMain, shell: Electron.Shell, BrowserWindow: typeof Electron.BrowserWindow, getWindow: () => Electron.BrowserWindow|null}} deps */
function register(deps) {
  const { ipcMain, shell, BrowserWindow } = deps;
  /** @type {Map<string, Electron.BrowserWindow>} one window per page */
  const open = new Map();
  let partitionCount = 0;

  ipcMain.handle('cc:openDashboard', (_e, /** @type {any} */ spec) => {
    const target = resolveDashboardTarget(spec || {});
    if (!target.ok) return false;
    const existing = open.get(target.href);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return true;
    }
    let packaged = false;
    try { packaged = require('electron').app.isPackaged; } catch { /* not under electron */ }
    const win = new BrowserWindow({
      width: 1180, height: 780, minWidth: 480, minHeight: 320,
      title: target.title, backgroundColor: '#141312', autoHideMenuBar: true,
      show: false,
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        partition: `dashboard-${process.pid}-${++partitionCount}`, // no "persist:" = in memory, shared with nothing
        devTools: !packaged,
        webviewTag: false, spellcheck: false,
      },
    });
    win.setMenuBarVisibility(false);
    const ses = win.webContents.session;
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(noop);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (ev, url) => {
      if (isNavigationAllowed(target, url)) return;
      ev.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(noop);
    });
    win.webContents.on('will-redirect', (ev, url) => { if (!isNavigationAllowed(target, url)) ev.preventDefault(); });
    win.webContents.on('will-attach-webview', (ev) => ev.preventDefault());
    if (packaged) win.webContents.on('devtools-opened', () => win.webContents.closeDevTools());
    win.once('ready-to-show', () => win.show());
    win.on('page-title-updated', (ev) => ev.preventDefault()); // keep the dashboard's name
    win.on('closed', () => { open.delete(target.href); });
    open.set(target.href, win);
    win.loadURL(target.href).catch(() => { /* a failed load shows Chromium's error page */ win.show(); });
    return true;
  });

  /** Only web links go to the default browser; never file: or custom schemes. */
  ipcMain.handle('cc:openExternal', async (_e, /** @type {any} */ msg) => {
    const url = msg && typeof msg.url === 'string' ? msg.url : '';
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    await shell.openExternal(u.toString());
    return true;
  });
}

module.exports = { register, resolveDashboardTarget, isNavigationAllowed };
