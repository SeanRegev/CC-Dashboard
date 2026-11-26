// @ts-check
'use strict';
/**
 * Dashboard windows: a plugin's HTML page or a local web dashboard (e.g. `codeburn web`), in a locked-down
 * window: sandboxed, no preload, no Node, navigation pinned to that file / origin, other links → default browser.
 * Owner: the Dashboards track (M2). IPC: cc:openDashboard { title, url? , file? } (stub), cc:openExternal { url }.
 */

/** @param {{ipcMain: Electron.IpcMain, shell: Electron.Shell, BrowserWindow: typeof Electron.BrowserWindow, getWindow: () => Electron.BrowserWindow|null}} deps */
function register(deps) {
  const { ipcMain, shell } = deps;

  ipcMain.handle('cc:openDashboard', (_e, /** @type {any} */ _spec) => false);

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

module.exports = { register };
