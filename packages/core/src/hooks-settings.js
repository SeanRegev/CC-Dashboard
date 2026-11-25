// @ts-check
'use strict';
/**
 * The settings file passed to every agent with `claude --settings <file>`. It registers a small
 * launcher for every event in HOOK_EVENTS. The user's own Claude settings are never touched.
 *
 * The launcher (<home>/cc-hook.cmd on Windows, <home>/cc-hook.sh elsewhere) runs hook.js with
 * ELECTRON_RUN_AS_NODE=1, because in the installed app process.execPath is Electron. That
 * variable is set only for the hook, never for claude itself (it would break Electron apps
 * Claude launches). With plain node (development, tests) it is harmless.
 */
const fs = require('fs');
const path = require('path');
const { HOOK_EVENTS } = require('../../shared/protocol');
const { writeFileAtomic } = require('./store');

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);
const HOOK_SCRIPT = path.join(__dirname, 'hook.js');

/** Forward slashes work in both bash (Git Bash on Windows) and cmd.exe, backslashes don't. */
function slashes(p) { return p.replace(/\\/g, '/'); }

/** @param {NodeJS.Platform} [platform] */
function launcherName(platform = process.platform) {
  return platform === 'win32' ? 'cc-hook.cmd' : 'cc-hook.sh';
}

/**
 * Text of the hook launcher.
 * @param {string} execPath @param {string} script @param {NodeJS.Platform} [platform]
 */
function launcherText(execPath, script, platform = process.platform) {
  if (platform === 'win32') {
    return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" "${script}" %*\r\n`;
  }
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${q(execPath)} ${q(script)} "$@"\n`;
}

/** @param {string} launcher absolute path of the launcher */
function buildSettings(launcher) {
  /** @type {Record<string, any[]>} */
  const hooks = {};
  for (const event of HOOK_EVENTS) {
    /** @type {any} */
    const entry = { hooks: [{ type: 'command', command: `"${slashes(launcher)}" ${event}`, timeout: 10 }] };
    if (TOOL_EVENTS.has(event)) entry.matcher = '';
    hooks[event] = [entry];
  }
  return { hooks };
}

function writeIfChanged(file, text, mode) {
  let old = '';
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
  if (old !== text) writeFileAtomic(file, text, { mode });
  else if (mode !== undefined && process.platform !== 'win32') try { fs.chmodSync(file, mode); } catch { /* ignore */ }
}

/**
 * Write <home>/cc-hook.{cmd,sh} and <home>/hooks-settings.json if they changed.
 * @param {string} home @param {{execPath?: string}} [opts]
 * @returns {string} the settings file path
 */
function ensureSettings(home, opts = {}) {
  const launcher = path.join(home, launcherName());
  writeIfChanged(launcher, launcherText(opts.execPath || process.execPath, HOOK_SCRIPT), 0o755);
  const file = path.join(home, 'hooks-settings.json');
  writeIfChanged(file, JSON.stringify(buildSettings(launcher), null, 2) + '\n');
  return file;
}

module.exports = { buildSettings, ensureSettings, launcherText, launcherName, HOOK_SCRIPT, TOOL_EVENTS };
