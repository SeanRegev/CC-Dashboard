// @ts-check
'use strict';
/**
 * The settings file passed to every agent with `claude --settings <file>`. It registers hook.js
 * for every event in HOOK_EVENTS. The user's own Claude settings are never touched.
 */
const fs = require('fs');
const path = require('path');
const { HOOK_EVENTS } = require('../../shared/protocol');
const { writeFileAtomic } = require('./store');

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);
const HOOK_SCRIPT = path.join(__dirname, 'hook.js');

/** Forward slashes work in both bash (Git Bash on Windows) and cmd.exe, backslashes don't. */
function slashes(p) { return p.replace(/\\/g, '/'); }

/**
 * @param {string} [execPath] the Node (or Electron-as-Node) that runs hook.js
 * @param {string} [script]
 */
function buildSettings(execPath = process.execPath, script = HOOK_SCRIPT) {
  /** @type {Record<string, any[]>} */
  const hooks = {};
  for (const event of HOOK_EVENTS) {
    /** @type {any} */
    const entry = { hooks: [{ type: 'command', command: `"${slashes(execPath)}" "${slashes(script)}" ${event}`, timeout: 10 }] };
    if (TOOL_EVENTS.has(event)) entry.matcher = '';
    hooks[event] = [entry];
  }
  return { hooks };
}

/** Write <home>/hooks-settings.json if it changed. Returns its path. @param {string} home */
function ensureSettings(home) {
  const file = path.join(home, 'hooks-settings.json');
  const text = JSON.stringify(buildSettings(), null, 2) + '\n';
  let old = '';
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
  if (old !== text) writeFileAtomic(file, text);
  return file;
}

module.exports = { buildSettings, ensureSettings, HOOK_SCRIPT, TOOL_EVENTS };
