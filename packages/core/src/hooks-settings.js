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
 *
 * (v4) It also registers the status-line relay (<home>/cc-statusline.{cmd,sh} -> statusline-relay.js),
 * which forwards Claude's status-line JSON to the core and prints the user's own status line.
 * Claude runs status-line commands like hooks: through Git Bash on Windows when it finds one, else
 * PowerShell; /bin/sh elsewhere. The command text is written for the shell Claude will use.
 * The user's display options (padding, refreshInterval, ...) can differ per project, so an agent
 * whose status line has any gets its own copy of the settings (hooks-settings-<hash>.json).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { HOOK_EVENTS } = require('../../shared/protocol');
const { writeFileAtomic } = require('./store');

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);
const HOOK_SCRIPT = path.join(__dirname, 'hook.js');
const STATUSLINE_SCRIPT = path.join(__dirname, 'statusline-relay.js');

/** Forward slashes work in both bash (Git Bash on Windows) and cmd.exe, backslashes don't. */
function slashes(p) { return p.replace(/\\/g, '/'); }

/** @param {NodeJS.Platform} [platform] */
function launcherName(platform = process.platform) {
  return platform === 'win32' ? 'cc-hook.cmd' : 'cc-hook.sh';
}

/** @param {NodeJS.Platform} [platform] */
function statusLauncherName(platform = process.platform) {
  return platform === 'win32' ? 'cc-statusline.cmd' : 'cc-statusline.sh';
}

/**
 * Text of a launcher (hook or status line): runs `script` with ELECTRON_RUN_AS_NODE=1.
 * @param {string} execPath @param {string} script @param {NodeJS.Platform} [platform]
 */
function launcherText(execPath, script, platform = process.platform) {
  if (platform === 'win32') {
    return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" "${script}" %*\r\n`;
  }
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${q(execPath)} ${q(script)} "$@"\n`;
}

/**
 * The statusLine command line, for the shell Claude will run it with.
 * @param {string} launcher @param {'bash'|'powershell'} [shell]
 */
function statusLineCommand(launcher, shell = 'bash') {
  const p = slashes(launcher);
  // PowerShell reads a bare quoted string as a value to print, not a command: call it with &.
  return shell === 'powershell' ? `& '${p.replace(/'/g, "''")}'` : `"${p}"`;
}

/**
 * @param {string} launcher absolute path of the hook launcher
 * @param {{statusLauncher?: string, shell?: 'bash'|'powershell', display?: Record<string, any>}} [opts]
 *   statusLauncher: register the status-line relay. display: the user's statusLine options other than
 *   type and command (padding, refreshInterval, hideVimModeIndicator, ...), kept as they are
 */
function buildSettings(launcher, opts = {}) {
  /** @type {Record<string, any[]>} */
  const hooks = {};
  for (const event of HOOK_EVENTS) {
    /** @type {any} */
    const entry = { hooks: [{ type: 'command', command: `"${slashes(launcher)}" ${event}`, timeout: 10 }] };
    if (TOOL_EVENTS.has(event)) entry.matcher = '';
    hooks[event] = [entry];
  }
  /** @type {any} */
  const settings = { hooks };
  if (opts.statusLauncher) {
    settings.statusLine = { ...(opts.display || {}), type: 'command', command: statusLineCommand(opts.statusLauncher, opts.shell) };
  }
  return settings;
}

/** The user's statusLine options that are about showing it, not running it. @param {any} sl */
function displayOptions(sl) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!sl || typeof sl !== 'object' || Array.isArray(sl)) return out;
  for (const [k, v] of Object.entries(sl)) if (k !== 'type' && k !== 'command' && v !== undefined) out[k] = v;
  return out;
}

function writeIfChanged(file, text, mode) {
  let old = '';
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
  if (old !== text) writeFileAtomic(file, text, { mode });
  else if (mode !== undefined && process.platform !== 'win32') try { fs.chmodSync(file, mode); } catch { /* ignore */ }
}

/**
 * Write <home>/cc-hook.{cmd,sh}, <home>/cc-statusline.{cmd,sh} and the settings file if they
 * changed. With display options, or a shell other than bash, the settings get a file of their own
 * (hooks-settings-<hash>.json) so agents with different status-line options don't share one.
 * @param {string} home
 * @param {{execPath?: string, shell?: 'bash'|'powershell', display?: Record<string, any>}} [opts]
 * @returns {string} the settings file path
 */
function ensureSettings(home, opts = {}) {
  const execPath = opts.execPath || process.execPath;
  const launcher = path.join(home, launcherName());
  writeIfChanged(launcher, launcherText(execPath, HOOK_SCRIPT), 0o755);
  const statusLauncher = path.join(home, statusLauncherName());
  writeIfChanged(statusLauncher, launcherText(execPath, STATUSLINE_SCRIPT), 0o755);
  const shell = opts.shell || 'bash';
  const display = opts.display || {};
  const variant = shell !== 'bash' || Object.keys(display).length > 0;
  const name = variant
    ? `hooks-settings-${crypto.createHash('sha1').update(JSON.stringify([shell, display])).digest('hex').slice(0, 10)}.json`
    : 'hooks-settings.json';
  const file = path.join(home, name);
  writeIfChanged(file, JSON.stringify(buildSettings(launcher, { statusLauncher, shell, display }), null, 2) + '\n');
  return file;
}

module.exports = {
  buildSettings, ensureSettings, launcherText, launcherName, statusLauncherName, statusLineCommand, displayOptions,
  HOOK_SCRIPT, STATUSLINE_SCRIPT, TOOL_EVENTS,
};
