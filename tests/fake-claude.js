#!/usr/bin/env node
// Stand-in for `claude` in tests. Run with CC_CLAUDE="node tests/fake-claude.js".
// It reads --settings like Claude does and fires the hooks registered there, so the core's
// status logic is exercised end to end without spending real Claude usage.
//
// Behaviour:
//   - prints "FAKE CLAUDE READY"
//   - fires SessionStart
//   - if a prompt (last non-flag argument) was given: UserPromptSubmit, PreToolUse(Bash), PostToolUse(Edit)
//       - prompt contains "permission": prints a permission dialog, then PermissionRequest + Notification
//       - otherwise: Stop
//   - every line typed afterwards: prints "GOT: <line>", fires UserPromptSubmit + Stop
//   - a line "/exit" fires SessionEnd and exits
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2);
const flagWithValue = new Set(['--settings', '--session-id', '--resume', '--model', '--effort', '--permission-mode']);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
let prompt = '';
for (let i = 0; i < args.length; i++) {
  if (flagWithValue.has(args[i])) { i++; continue; }
  if (!args[i].startsWith('-')) prompt = args[i];
}
const settings = get('--settings') ? JSON.parse(fs.readFileSync(get('--settings'), 'utf8')) : { hooks: {} };
const sessionId = get('--session-id') || get('--resume') || 'fake-session';
const home = process.env.CC_HOME || path.join(require('os').tmpdir(), 'cc-fake');
fs.mkdirSync(home, { recursive: true });
const transcript = path.join(home, `transcript-${sessionId}.jsonl`);

function fire(event, payload = {}) {
  const body = JSON.stringify({ ...payload, session_id: sessionId, transcript_path: transcript, cwd: process.cwd(), hook_event_name: event });
  for (const entry of (settings.hooks && settings.hooks[event]) || []) {
    for (const h of entry.hooks || []) {
      try { execSync(h.command, { input: body, stdio: ['pipe', 'ignore', 'ignore'], shell: true, timeout: 10000 }); } catch (e) { /* hooks never break claude */ }
    }
  }
}

fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: {
  id: 'm-' + sessionId, model: 'fake-model', usage: { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } }) + '\n');

process.stdout.write('FAKE CLAUDE READY\r\n');
fire('SessionStart', { source: get('--resume') ? 'resume' : 'startup' });
if (prompt) {
  fire('UserPromptSubmit', { prompt });
  fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  fire('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(process.cwd(), 'app.js') }, tool_response: {} });
  if (prompt.includes('permission')) {
    process.stdout.write('Do you want to proceed?\r\n > 1. Yes\r\n   2. No\r\n Esc to cancel\r\n');
    setTimeout(() => {
      fire('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
      fire('Notification', { message: 'Claude needs your permission to use Bash' });
    }, 200);
  } else {
    fire('Stop');
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (text === '/exit') { fire('SessionEnd', { reason: 'exit' }); process.exit(0); }
  process.stdout.write(`GOT: ${text}\r\n`);
  fire('UserPromptSubmit', { prompt: text });
  fire('Stop');
});
