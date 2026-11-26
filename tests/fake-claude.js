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
//
// Subagents (M3): a prompt (or typed line) with "subagents:<n>" fires the hook sequence real Claude
// Code 2.1 fires when it hands work to n subagents (tests/fixtures/hooks/subagent-background.jsonl),
// and writes each one's meta.json next to the transcript (<CC_HOME>/<sessionId>/subagents/):
//   - default (foreground): PreToolUse(Agent) x n, SubagentStart, Bash + Read inside each subagent,
//     SubagentStop, PostToolUse(Agent) with the agentId, Stop
//   - with "bg": PreToolUse(Agent) + PostToolUse(Agent, async_launched) + SubagentStart each, one tool
//     each, Stop (background_tasks lists them), a pause (CC_FAKE_SUBAGENT_MS, default 300 ms), then
//     per subagent: its tools, SubagentStop, and a <task-notification> turn (UserPromptSubmit + Stop)
//   - with "nopre": no PreToolUse / PostToolUse(Agent): titles come only from meta.json, which is
//     written after SubagentStart (like real Claude, where it can lag behind)
// Titles: "Count files here", "Find token call sites", "Plan the retry fix", "Subagent task 4", ...
'use strict';
const crypto = require('crypto');
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
if (prompt && /subagents:\d/.test(prompt) && !/layout:/.test(prompt)) {
  setImmediate(() => runSubagents(prompt)); // after the constants below are set
} else if (prompt && !/layout:/.test(prompt)) {
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
  if (/subagents:\d/.test(text)) { runSubagents(text); return; }
  fire('UserPromptSubmit', { prompt: text });
  fire('Stop');
}

const SUB_TITLES = ['Count files here', 'Find token call sites', 'Plan the retry fix'];
const SUB_TYPES = ['general-purpose', 'Explore', 'Plan'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let subRun = 0;

/** The hooks real Claude fires when it starts subagents (see the header). @param {string} text */
async function runSubagents(text) {
  const n = Math.max(1, Math.min(9, Number(/subagents:(\d+)/.exec(text)[1])));
  const bg = /\bbg\b/.test(text);
  const noPre = /\bnopre\b/.test(text);
  const pause = Number(process.env.CC_FAKE_SUBAGENT_MS || 300);
  const run = ++subRun;
  const subs = [];
  for (let i = 0; i < n; i++) {
    const id = 'a' + crypto.createHash('sha1').update(`${sessionId}:${run}:${i}`).digest('hex').slice(0, 16);
    subs.push({ id, title: SUB_TITLES[i] || `Subagent task ${i + 1}`, type: SUB_TYPES[i % SUB_TYPES.length], toolUseId: `toolu_fake_${run}_${i}` });
  }
  const subDir = path.join(path.dirname(transcript), sessionId, 'subagents');
  const meta = (s, finished) => {
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, `agent-${s.id}.meta.json`), JSON.stringify({
      agentType: s.type, isBuiltIn: true, description: s.title, toolUseId: s.toolUseId, spawnDepth: 1,
      requestShape: bg ? 'background' : 'foreground', model: 'fake-model', finished,
    }));
  };
  const agentInput = (s) => ({ description: s.title, prompt: `Do this: ${s.title}`, subagent_type: s.type });
  const inSub = (s, event, extra) => fire(event, { agent_id: s.id, agent_type: s.type, ...extra });
  const ls = (s) => ({ tool_name: 'Bash', tool_input: { command: 'ls', description: 'List files' }, tool_use_id: `toolu_ls_${s.id}` });
  const read = (s) => ({ tool_name: 'Read', tool_input: { file_path: path.join(process.cwd(), 'a.txt') }, tool_use_id: `toolu_read_${s.id}` });
  const startSub = (s) => {
    if (!noPre) meta(s, false);
    fire('SubagentStart', { agent_id: s.id, agent_type: s.type });
    if (noPre) meta(s, false);
  };
  const finishSub = (s, stillRunning) => {
    inSub(s, 'PostToolUse', { ...ls(s), tool_response: { stdout: 'a.txt', stderr: '', interrupted: false }, duration_ms: 40 });
    inSub(s, 'PreToolUse', read(s));
    inSub(s, 'PostToolUse', { ...read(s), tool_response: { type: 'text', file: { content: 'hello\n' } }, duration_ms: 5 });
    meta(s, true);
    fs.writeFileSync(path.join(subDir, `agent-${s.id}.jsonl`), JSON.stringify({ type: 'assistant', isSidechain: true, agentId: s.id }) + '\n');
    inSub(s, 'SubagentStop', {
      agent_transcript_path: path.join(subDir, `agent-${s.id}.jsonl`), last_assistant_message: `Done: ${s.title}. Found a.txt.`,
      background_tasks: bg ? stillRunning.map(task) : [],
    });
  };
  const task = (s) => ({ id: s.id, type: 'subagent', status: 'running', description: s.title, agent_type: s.type });

  fire('UserPromptSubmit', { prompt: text });
  if (bg) {
    for (const s of subs) {
      if (!noPre) {
        fire('PreToolUse', { tool_name: 'Agent', tool_input: agentInput(s), tool_use_id: s.toolUseId });
        fire('PostToolUse', { tool_name: 'Agent', tool_input: agentInput(s), tool_use_id: s.toolUseId, duration_ms: 15,
          tool_response: { isAsync: true, status: 'async_launched', agentId: s.id, description: s.title } });
      }
      startSub(s);
    }
    for (const s of subs) inSub(s, 'PreToolUse', ls(s));
    fire('Stop', { last_assistant_message: `${n} subagent${n === 1 ? ' is' : 's are'} running in the background.`, background_tasks: subs.map(task) });
    process.stdout.write(`SUBAGENTS RUNNING: ${n}\r\n`);
    await sleep(pause);
    const left = [...subs];
    for (const s of subs) {
      finishSub(s, left);
      left.shift();
      fire('UserPromptSubmit', { prompt: `<task-notification>\n<task-id>${s.id}</task-id>\n<tool-use-id>${s.toolUseId}</tool-use-id>\n`
        + `<status>completed</status>\n<summary>Agent "${s.title}" finished</summary>\n<result>Done: ${s.title}</result>\n</task-notification>` });
      fire('Stop', { last_assistant_message: `${s.title}: done.`, background_tasks: left.map(task) });
    }
  } else {
    if (!noPre) for (const s of subs) fire('PreToolUse', { tool_name: 'Agent', tool_input: agentInput(s), tool_use_id: s.toolUseId });
    for (const s of subs) startSub(s);
    for (const s of subs) { inSub(s, 'PreToolUse', ls(s)); finishSub(s, []); }
    if (!noPre) {
      for (const s of subs) {
        fire('PostToolUse', { tool_name: 'Agent', tool_input: agentInput(s), tool_use_id: s.toolUseId, duration_ms: 900,
          tool_response: { status: 'completed', agentId: s.id, totalToolUseCount: 2 } });
      }
    }
    fire('Stop', { last_assistant_message: 'All subagents are done.', background_tasks: [] });
  }
  process.stdout.write(`SUBAGENTS DONE: ${n}\r\n`);
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
