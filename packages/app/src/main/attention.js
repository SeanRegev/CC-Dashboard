// @ts-check
'use strict';
/**
 * Getting the user's attention: native notifications (click → focus the window and open the agent),
 * and (Approvals track, M2) the taskbar count and window flash when an agent starts needing you.
 * Owner: the Approvals track. IPC: cc:notify (existing), cc:setAttention { count } (stub).
 */

/** @param {{ipcMain: Electron.IpcMain, Notification: typeof Electron.Notification, getWindow: () => Electron.BrowserWindow|null, focusWindow: () => void}} deps */
function register(deps) {
  const { ipcMain, Notification, getWindow, focusWindow } = deps;
  /** Keep shown notifications referenced, or they can be garbage-collected before a click. */
  const live = new Set();

  ipcMain.handle('cc:notify', (_e, /** @type {any} */ msg) => {
    if (!Notification.isSupported()) return false;
    const title = String((msg && msg.title) || 'CC-Dashboard').slice(0, 200);
    const body = String((msg && msg.body) || '').slice(0, 500);
    const agentId = msg && typeof msg.agentId === 'string' ? msg.agentId : null;
    const n = new Notification({ title, body, silent: false });
    live.add(n);
    n.on('click', () => {
      focusWindow();
      const win = getWindow();
      if (agentId && win) win.webContents.send('cc:select-agent', agentId);
      live.delete(n);
    });
    n.on('close', () => live.delete(n));
    n.show();
    return true;
  });

  // Approvals track: taskbar overlay count + flashFrame when count goes up and the window is not focused.
  ipcMain.handle('cc:setAttention', (_e, /** @type {any} */ _msg) => false);
}

module.exports = { register };
