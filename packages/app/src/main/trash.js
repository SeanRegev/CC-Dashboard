// @ts-check
'use strict';
/**
 * Deleting a skill: its folder goes to the system trash (Recycle Bin), never rm -rf. Only folders the core
 * reported as skills (a SKILL.md inside, under a skills/ directory) may be trashed.
 * Owner: the Library track (M2). IPC: cc:trashSkill { path } (path of SKILL.md) → true (stub: false).
 */

/** @param {{ipcMain: Electron.IpcMain, shell: Electron.Shell}} deps */
function register(deps) {
  const { ipcMain } = deps;
  ipcMain.handle('cc:trashSkill', (_e, /** @type {any} */ _msg) => false);
}

module.exports = { register };
