// @ts-check
'use strict';
/**
 * Electron main process: one window, native notifications, finds or starts cc-core.
 * Closing the window never stops agents: the core is a separate, detached process.
 *
 * Env:
 *   CC_HOME           where core.json lives (protocol.homeDir())
 *   CC_DISABLE_GPU=1  disable hardware acceleration (headless tests)
 *   CC_CORE_NODE      Node binary for the core in development (default: node on PATH)
 *   CC_CORE_ENTRY     core entry file override (development and tests)
 *   CC_WINDOW_SIZE    "1280x800": initial content size (screenshots)
 */
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, Notification, Menu, shell } = require('electron');
const { homeDir } = require('../../../shared/protocol.js');
const launcher = require('./core-launcher.js');

if (process.env.CC_DISABLE_GPU === '1') app.disableHardwareAcceleration();
// A custom CC_HOME (tests, side-by-side dev) gets its own Electron profile and single-instance lock.
if (process.env.CC_HOME) app.setPath('userData', path.join(homeDir(), 'electron-profile'));

const APP_ROOT = path.join(__dirname, '..', '..', '..', '..');
const BG = '#141312';

/** @type {BrowserWindow|null} */
let win = null;
/** @type {Promise<launcher.CoreInfo>|null} */
let corePromise = null;
/** Keep shown notifications referenced, or they can be garbage-collected before a click. */
const liveNotifications = new Set();

function ensureCore() {
  if (!corePromise) {
    corePromise = launcher.ensureCore({
      home: homeDir(),
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      appRoot: app.isPackaged ? app.getAppPath() : APP_ROOT,
      resourcesPath: process.resourcesPath,
    }).catch((e) => {
      corePromise = null;
      throw e;
    });
  }
  return corePromise;
}

/** The connection for the renderer. Re-checks health so a restarted core is picked up. */
async function getConnection() {
  let info = await ensureCore();
  if (!(await launcher.checkHealth(info))) {
    corePromise = null;
    info = await ensureCore();
  }
  return { port: info.port, token: info.token };
}

function parseSize() {
  const m = /^(\d+)x(\d+)$/.exec(process.env.CC_WINDOW_SIZE || '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1440, height: 900 };
}

function createWindow() {
  const size = parseSize();
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    ...size,
    useContentSize: true,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: BG,
    title: 'CC-Dashboard',
    autoHideMenuBar: true,
    // The renderer's top bar is the title bar; window buttons are drawn over its right end (Windows/Linux).
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 16 } } : { titleBarOverlay: { color: BG, symbolColor: '#B5AEA7', height: 44 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win && win.show());
  win.on('closed', () => { win = null; });

  // No navigation away from the app, no new windows; links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // F12 / Ctrl+Shift+I: devtools in development only.
  win.webContents.on('before-input-event', (e, input) => {
    if (app.isPackaged || input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      win && win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
}

function focusWindow() {
  if (!win) createWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

ipcMain.handle('cc:getConnection', () => getConnection());

ipcMain.handle('cc:pickFolder', async () => {
  const opts = /** @type {Electron.OpenDialogOptions} */ ({ title: 'Add a space', properties: ['openDirectory', 'createDirectory'] });
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle('cc:notify', (_e, /** @type {any} */ msg) => {
  if (!Notification.isSupported()) return false;
  const title = String((msg && msg.title) || 'CC-Dashboard').slice(0, 200);
  const body = String((msg && msg.body) || '').slice(0, 500);
  const agentId = msg && typeof msg.agentId === 'string' ? msg.agentId : null;
  const n = new Notification({ title, body, silent: false });
  liveNotifications.add(n);
  n.on('click', () => {
    focusWindow();
    if (agentId && win) win.webContents.send('cc:select-agent', agentId);
    liveNotifications.delete(n);
  });
  n.on('close', () => liveNotifications.delete(n));
  n.show();
  return true;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => focusWindow());
  if (process.platform === 'win32') app.setAppUserModelId('dev.cc-dashboard.app');

  app.whenReady().then(() => {
    // Windows/Linux: no menu, so Ctrl+W / Ctrl+R … reach the renderer's shortcuts and the terminal.
    // macOS keeps a minimal menu for Quit and the edit commands.
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]));
    } else {
      Menu.setApplicationMenu(null);
    }
    ensureCore().catch((e) => console.error(String(e && e.message)));
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });

  // Closing the window quits the app (not on macOS), but never the core: agents keep running.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
