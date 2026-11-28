#!/usr/bin/env node
// @ts-check
'use strict';
/**
 * Claude Code runs this as the statusLine command of every agent the core starts (through
 * <home>/cc-statusline.{cmd,sh}), with a JSON snapshot of the session on stdin. Two jobs at once:
 *
 *   1. POST the snapshot to the core: ${CC_CORE_URL}/statusline?agent=${CC_AGENT_ID} (x-cc-token).
 *      Errors are ignored; a dead or hung core never delays the line.
 *   2. Print the line: the user's own status line (CC_STATUSLINE, resolved by the core when it
 *      launched the agent, see statusline.js `userStatusLineRun`), run with the same stdin the way
 *      Claude runs it, its stdout / stderr / exit code passed through unchanged. Without one, a
 *      short default: "Haiku 5.5 · ctx 10% · 5h 62%".
 *
 * CC_STATUSLINE is JSON: { command, shell } (run through that shell: a path, or true for the
 * platform shell) or { file, args } (exec form), plus timeoutMs. Prints nothing else, never throws.
 * No dependencies, so it starts fast.
 */
const http = require('http');
const { spawn, spawnSync } = require('child_process');

/** POST timeout, and the hard cap on the whole relay when there is no user command. */
const POST_TIMEOUT_MS = 2000;
/** Once the line is printed, how much longer the POST may take before we leave anyway. */
const POST_GRACE_MS = 300;
/** The user's command gets this long unless their settings give it a timeout. */
const USER_TIMEOUT_MS = 30_000;
/** How long to wait for Claude to close stdin (it writes the JSON and closes at once). */
const STDIN_TIMEOUT_MS = 1000;

const env = process.env;
let exitCode = 0;
let lineDone = false;
let postDone = false;
/** @type {NodeJS.Timeout|null} */ let graceTimer = null;

function finish() {
  if (!lineDone || !postDone) return;
  process.exit(exitCode);
}

function lineFinished() {
  if (lineDone) return;
  lineDone = true;
  if (!postDone) {
    graceTimer = setTimeout(() => { postDone = true; finish(); }, POST_GRACE_MS);
    graceTimer.unref();
  }
  finish();
}

function postFinished() {
  if (postDone) return;
  postDone = true;
  if (graceTimer) clearTimeout(graceTimer);
  finish();
}

/** @param {Buffer|string} data @param {() => void} [cb] */
function out(data, cb) {
  try {
    if (!data.length) { if (cb) cb(); return; }
    process.stdout.write(data, () => { if (cb) cb(); });
  } catch { if (cb) cb(); }
}

process.stdout.on('error', () => {}); // Claude went away: nothing to do about it
process.stderr.on('error', () => {});

readStdin((input) => {
  // Nested inside a user command that runs the relay again (it never should): no loops.
  const nested = env.CC_STATUSLINE_DEPTH === '1';
  post(input, nested);
  /** @type {any} */
  let run = null;
  if (!nested && env.CC_STATUSLINE) {
    try { run = JSON.parse(env.CC_STATUSLINE); } catch { run = null; }
  }
  if (run && typeof run === 'object' && (typeof run.command === 'string' || typeof run.file === 'string')) runUser(run, input);
  else out(defaultLine(input), lineFinished);
});

/** @param {(input: Buffer) => void} cb */
function readStdin(cb) {
  /** @type {Buffer[]} */
  const chunks = [];
  let called = false;
  const go = () => { if (!called) { called = true; cb(Buffer.concat(chunks)); } };
  if (process.stdin.isTTY) { go(); return; }
  const t = setTimeout(go, STDIN_TIMEOUT_MS);
  t.unref();
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => { clearTimeout(t); go(); });
  process.stdin.on('error', () => { clearTimeout(t); go(); });
}

/** @param {Buffer} body @param {boolean} skip */
function post(body, skip) {
  const agent = env.CC_AGENT_ID;
  const base = env.CC_CORE_URL;
  if (skip || !agent || !base) { postFinished(); return; }
  try {
    const url = new URL(`/statusline?agent=${encodeURIComponent(agent)}`, base);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length, 'x-cc-token': env.CC_TOKEN || '' },
      timeout: POST_TIMEOUT_MS,
    }, (res) => { res.resume(); res.on('end', postFinished); res.on('error', postFinished); });
    req.on('error', postFinished);
    req.on('timeout', () => { req.destroy(); postFinished(); });
    req.end(body);
    const cap = setTimeout(postFinished, POST_TIMEOUT_MS);
    cap.unref();
  } catch {
    postFinished();
  }
}

/**
 * Run the user's own status-line command with the same stdin; pass its output through as is.
 * @param {{command?: string, shell?: string|boolean, file?: string, args?: string[], timeoutMs?: number}} run
 * @param {Buffer} input
 */
function runUser(run, input) {
  const childEnv = { ...env, CC_STATUSLINE_DEPTH: '1' };
  // The launcher sets this for the relay only; the user's command must not inherit it (it would
  // turn any Electron app or VS Code CLI it runs into plain Node).
  delete childEnv.ELECTRON_RUN_AS_NODE;
  /** @type {import('child_process').ChildProcess} */
  let child;
  try {
    child = run.file
      // detached (POSIX): its own process group, so a timeout can end what it started too
      ? spawn(run.file, Array.isArray(run.args) ? run.args.map(String) : [], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
      : spawn(String(run.command), { shell: run.shell === undefined ? true : run.shell, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  } catch {
    exitCode = 1;
    lineFinished();
    return;
  }
  /** @type {Buffer[]} */
  const stdout = [];
  let ended = false;
  const timeoutMs = Number(run.timeoutMs) > 0 ? Number(run.timeoutMs) : USER_TIMEOUT_MS;
  const timer = setTimeout(() => {
    killTree(child);
    end(1);
  }, timeoutMs);
  timer.unref();
  /** @param {number} code */
  const end = (code) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    exitCode = code;
    out(Buffer.concat(stdout), lineFinished);
  };
  if (child.stdout) child.stdout.on('data', (d) => stdout.push(d));
  if (child.stderr) child.stderr.on('data', (d) => { try { process.stderr.write(d); } catch { /* ignore */ } });
  if (child.stdin) {
    child.stdin.on('error', () => {}); // the command did not read its stdin: fine
    child.stdin.end(input);
  }
  child.on('error', () => end(1));
  // 'close' (not 'exit'): all of its output has been read.
  child.on('close', (code, signal) => end(code === null ? (signal ? 1 : 0) : code));
}

/**
 * The line shown when the user has no status line of their own.
 * @param {Buffer} input @returns {string}
 */
function defaultLine(input) {
  /** @type {any} */
  let p = null;
  try { p = JSON.parse(input.toString('utf8')); } catch { return ''; }
  if (!p || typeof p !== 'object') return '';
  const parts = [];
  const m = p.model && typeof p.model === 'object' ? p.model : {};
  const name = typeof m.display_name === 'string' && m.display_name ? m.display_name : typeof m.id === 'string' ? m.id : '';
  if (name) parts.push(name);
  const cw = p.context_window && typeof p.context_window === 'object' ? p.context_window : {};
  if (typeof cw.used_percentage === 'number' && Number.isFinite(cw.used_percentage)) parts.push(`ctx ${Math.round(cw.used_percentage)}%`);
  const rl = p.rate_limits && typeof p.rate_limits === 'object' ? p.rate_limits : {};
  const five = rl.five_hour && typeof rl.five_hour === 'object' ? rl.five_hour.used_percentage : undefined;
  if (typeof five === 'number' && Number.isFinite(five)) parts.push(`5h ${Math.round(five)}%`);
  return parts.length ? parts.join(' · ') + '\n' : '';
}

/**
 * End the user's command and everything it started (a shell's grandchildren would otherwise linger):
 * taskkill /T on Windows, the process group elsewhere.
 * @param {import('child_process').ChildProcess} child
 */
function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 3000 });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* gone */ }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
}
