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
//
// Real permission prompt layouts (tests/fixtures/prompts/<name>.txt): a prompt containing
// "layout:<name>[,<name>…]" (e.g. "layout:bash-4opt,edit") switches stdin to raw keys and, after
// UserPromptSubmit + PreToolUse, fires PermissionRequest and draws the first layout. Every key chunk
// received is appended (JSON, one per line) to <CC_HOME>/keys-<sessionId>.log. While a prompt is shown:
//   - a digit that is one of its options: clears it, prints "CHOSE: <n>", fires PostToolUse + Stop
//   - Escape: clears it, prints "DENIED" (no hook, like real Claude)
//   - "~": the prompt changes to the next layout (PermissionRequest fires again)
//   - "!": the same prompt is asked again (PermissionRequest fires again, same text)
// With "nohook" in the prompt too, a "needs your permission" Notification stands in for
// PermissionRequest (older Claude Code).
// Without a prompt, typed lines (ending in Enter) behave as above.
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
if (prompt && !/layout:/.test(prompt)) {
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

function onLine(line) {
  const text = line.trim();
  if (text === '/exit') { fire('SessionEnd', { reason: 'exit' }); process.exit(0); }
  process.stdout.write(`GOT: ${text}\r\n`);
  fire('UserPromptSubmit', { prompt: text });
  fire('Stop');
}

const layoutMatch = /layout:([\w,-]+)/.exec(prompt);
if (layoutMatch) {
  runLayouts(layoutMatch[1].split(',').filter(Boolean));
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', onLine);
}

/** The tool call each fixture shows, for the PermissionRequest hook. */
function toolFor(name) {
  if (name.startsWith('edit')) return { tool_name: 'Edit', tool_input: { file_path: path.join(process.cwd(), 'src', 'app.js') } };
  if (name.startsWith('create')) return { tool_name: 'Write', tool_input: { file_path: path.join(process.cwd(), 'notes', 'todo.md') } };
  if (name.startsWith('fetch')) return { tool_name: 'WebFetch', tool_input: { url: 'https://docs.example.com/api/v2' } };
  if (name.startsWith('mcp')) return { tool_name: 'mcp__github__create_issue', tool_input: { title: 'Login fails on Safari' } };
  return { tool_name: 'Bash', tool_input: { command: 'npm test' } };
}

function runLayouts(names) {
  const keysLog = path.join(home, `keys-${sessionId}.log`);
  const fixtures = path.join(__dirname, 'fixtures', 'prompts');
  let index = 0;
  let shown = false;
  let options = 0;
  let line = '';
  const draw = () => {
    const text = fs.readFileSync(path.join(fixtures, `${names[index]}.txt`), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
    options = text.split(/\r?\n/).filter((l) => /^[\s│]*(?:❯\s*)?\d+\.\s/.test(l)).length;
    process.stdout.write(`\x1b[2J\x1b[HFAKE CLAUDE READY\r\n${text.split(/\r?\n/).join('\r\n')}\r\n`);
    shown = true;
  };
  const ask = () => {
    if (/nohook/.test(prompt)) fire('Notification', { message: `Claude needs your permission to use ${toolFor(names[index]).tool_name}` });
    else fire('PermissionRequest', toolFor(names[index]));
    draw();
  };
  const close = (msg) => {
    shown = false;
    process.stdout.write(`\x1b[2J\x1b[HFAKE CLAUDE READY\r\n${msg}\r\n`);
  };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', (buf) => {
    const data = buf.toString('utf8');
    fs.appendFileSync(keysLog, JSON.stringify(data) + '\n');
    if (!shown) {
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') { const l = line; line = ''; onLine(l); } else if (ch >= ' ') line += ch;
      }
      return;
    }
    if (data === '\x1b') { close('DENIED'); return; }
    if (data === '~') { index = (index + 1) % names.length; ask(); return; }
    if (data === '!') { ask(); return; }
    if (/^[1-9]$/.test(data) && Number(data) <= options) {
      close(`CHOSE: ${data}`);
      const t = toolFor(names[index]);
      fire('PostToolUse', { ...t, tool_response: {} });
      fire('Stop');
    }
  });
  fire('UserPromptSubmit', { prompt });
  fire('PreToolUse', toolFor(names[0]));
  setTimeout(ask, 100);
}
