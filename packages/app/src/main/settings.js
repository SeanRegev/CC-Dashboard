// @ts-check
'use strict';
/**
 * App settings (theme, terminal font, notifications), saved as JSON in <CC_HOME>/ui-settings.json, and the
 * "Quit and stop all agents" action. Owner: the Settings track (M2).
 * IPC: cc:getSettings → object, cc:setSettings { patch } → object (and 'cc:settings' pushed to the window),
 *      cc:quitAll → stops the core (core.shutdown over RPC) and quits the app.  Groundwork: in-memory stub.
 */

/** @param {{ipcMain: Electron.IpcMain, app: Electron.App, getWindow: () => Electron.BrowserWindow|null, home: string}} deps */
function register(deps) {
  const { ipcMain, getWindow } = deps;
  /** @type {Record<string, any>} */
  let settings = {};
  ipcMain.handle('cc:getSettings', () => settings);
  ipcMain.handle('cc:setSettings', (_e, /** @type {any} */ msg) => {
    const patch = msg && typeof msg.patch === 'object' && msg.patch ? msg.patch : {};
    settings = { ...settings, ...patch };
    const win = getWindow();
    if (win) win.webContents.send('cc:settings', settings);
    return settings;
  });
  ipcMain.handle('cc:quitAll', () => false);
}

module.exports = { register };
