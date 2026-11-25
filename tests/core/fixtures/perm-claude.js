#!/usr/bin/env node
'use strict';
// Shows a permission prompt and fires PermissionRequest. Any key closes the prompt (like Esc in
// real Claude) and redraws the screen WITHOUT firing a hook, so only the screen shows it was answered.
const { loadSettings, fire } = require('./hooks');

const settings = loadSettings(process.argv.slice(2));
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('PERM CLAUDE READY\r\n');
fire(settings, 'SessionStart', { source: 'startup' });
fire(settings, 'UserPromptSubmit', { prompt: 'run the tests' });
process.stdout.write('Bash command\r\n  npm test\r\nDo you want to proceed?\r\n > 1. Yes\r\n   2. No\r\n Esc to cancel\r\n');
fire(settings, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
process.stdin.once('data', () => {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H> Interrupted. What should Claude do instead?\r\n');
  process.stdin.resume();
});
setInterval(() => {}, 1 << 30);
