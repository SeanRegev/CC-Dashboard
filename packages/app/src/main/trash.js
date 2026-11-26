// @ts-check
'use strict';
/**
 * Deleting a skill: its folder goes to the system trash (Recycle Bin), never rm -rf. Only folders the core
 * reported as skills (a SKILL.md inside, under a skills/ directory) may be trashed, and never a plugin's skills.
 * Owner: the Library track (M2). IPC: cc:trashSkill { path } (path of SKILL.md) → true.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Is this the SKILL.md of a user or project skill that may be trashed? Pure: the optional `exists` stands in for fs.
 * Rules: absolute, normalized, file name exactly SKILL.md, its folder's parent is named `skills`, the folder is
 * not inside <config dir>/plugins or any plugin install path, and the folder holding `skills/` is not a plugin root.
 * @param {string} p
 * @param {{configDir?: string, pluginPaths?: string[], exists?: (file: string) => boolean, platform?: NodeJS.Platform}} [opts]
 * @returns {boolean}
 */
function isTrashableSkillPath(p, opts = {}) {
  const platform = opts.platform || process.platform;
  const pp = platform === 'win32' ? path.win32 : path.posix;
  if (typeof p !== 'string' || !p || p.includes('\0') || !pp.isAbsolute(p)) return false;
  if (pp.normalize(p) !== p) return false; // no `..`, no doubled separators
  if (pp.basename(p) !== 'SKILL.md') return false;
  const folder = pp.dirname(p);
  const skillsDir = pp.dirname(folder);
  if (pp.basename(skillsDir) !== 'skills' || skillsDir === folder) return false;
  const fold = (/** @type {string} */ s) => (platform === 'win32' ? s.toLowerCase() : s);
  const inside = (/** @type {string} */ parent, /** @type {string} */ child) => {
    const rel = pp.relative(fold(pp.resolve(parent)), fold(pp.resolve(child)));
    return rel === '' || (!rel.startsWith('..') && !pp.isAbsolute(rel));
  };
  const configDir = opts.configDir || process.env.CLAUDE_CONFIG_DIR || pp.join(os.homedir(), '.claude');
  const forbidden = [pp.join(configDir, 'plugins'), ...(opts.pluginPaths || [])];
  if (forbidden.some((f) => f && pp.isAbsolute(f) && inside(f, folder))) return false;
  // `.../.claude/plugins/...` wherever .claude is (another profile, a copy)
  const parts = folder.split(/[\\/]+/);
  for (let i = 0; i + 1 < parts.length; i++) if (parts[i] === '.claude' && parts[i + 1] === 'plugins') return false;
  const exists = opts.exists || ((/** @type {string} */ f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  const root = pp.dirname(skillsDir);
  if (exists(pp.join(root, '.claude-plugin', 'plugin.json')) || exists(pp.join(root, 'plugin.json'))) return false;
  return exists(p);
}

/** @param {{ipcMain: Electron.IpcMain, shell: Electron.Shell}} deps */
function register(deps) {
  const { ipcMain, shell } = deps;
  ipcMain.handle('cc:trashSkill', async (_e, /** @type {any} */ msg) => {
    const file = msg && typeof msg.path === 'string' ? msg.path : '';
    if (!isTrashableSkillPath(file)) throw new Error('Not a skill folder that can be deleted here.');
    await shell.trashItem(path.dirname(file));
    return true;
  });
}

module.exports = { register, isTrashableSkillPath };
