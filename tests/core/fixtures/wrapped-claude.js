#!/usr/bin/env node
'use strict';
// tests/fake-claude.js plus two test aids:
//   - appends its argv (JSON) to $CC_HOME/argv.log, so tests can check --resume / --session-id
//   - appends the core-related env vars it got to $CC_HOME/env.log
//   - a typed line "size" prints "SIZE <cols>x<rows>" (the terminal size it sees)
const fs = require('fs');
const path = require('path');

fs.appendFileSync(path.join(process.env.CC_HOME || '.', 'argv.log'), JSON.stringify(process.argv.slice(2)) + '\n');
const pick = (k) => (k in process.env ? process.env[k] : null);
fs.appendFileSync(path.join(process.env.CC_HOME || '.', 'env.log'), JSON.stringify({
  CC_AGENT_ID: pick('CC_AGENT_ID'), CC_CORE_URL: pick('CC_CORE_URL'), CC_TOKEN: pick('CC_TOKEN'),
  ELECTRON_RUN_AS_NODE: pick('ELECTRON_RUN_AS_NODE'), CLAUDECODE: pick('CLAUDECODE'),
}) + '\n');
/**
 * The terminal size right now. process.stdout.getWindowSize() is a cached value that Node refreshes
 * on a resize signal; on Windows that signal only comes with raw-mode console input (as a real TUI
 * like claude reads it), and this fake reads lines. So ask the console handle directly.
 */
function termSize() {
  if (!process.stdout.isTTY) return [0, 0];
  const handle = /** @type {any} */ (process.stdout)._handle;
  const out = [0, 0];
  if (handle && typeof handle.getWindowSize === 'function' && handle.getWindowSize(out) === 0) return out;
  return process.stdout.getWindowSize();
}

// Input arrives in arbitrary chunks (ConPTY on Windows can split a typed line), so buffer lines.
let pending = '';
process.stdin.on('data', (d) => {
  pending += String(d);
  const lines = pending.split(/\r\n|\r|\n/);
  pending = lines.pop() || '';
  for (const line of lines) {
    if (line.trim() !== 'size') continue;
    const [cols, rows] = termSize();
    process.stdout.write(`SIZE ${cols}x${rows}\r\n`);
  }
});
require('../../fake-claude.js');
