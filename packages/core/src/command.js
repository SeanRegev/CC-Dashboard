// @ts-check
'use strict';
/**
 * How to start `claude`: parse CC_CLAUDE, find the real executable on PATH, build argv,
 * and turn it into what node-pty needs on each platform. Never assumes bash.
 */
const fs = require('fs');
const path = require('path');

/**
 * Split a command line like a shell would, for CC_CLAUDE (e.g. `"C:\Program Files\nodejs\node.exe" fake.js`).
 * Double and single quotes group. On Windows backslashes are path separators, not escapes.
 * @param {string} line @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
function splitCommand(line, platform = process.platform) {
  const out = [];
  let cur = '';
  let has = false;
  /** @type {string|null} */
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && quote === '"' && platform !== 'win32' && (line[i + 1] === '"' || line[i + 1] === '\\')) { cur += line[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && platform !== 'win32' && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
    if (/\s/.test(c)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/**
 * Find an executable the way the OS would. On Windows tries PATHEXT (claude.exe, claude.cmd, ...).
 * @param {string} name @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, cwd?: string}} [opts]
 * @returns {string|null} absolute path
 */
function which(name, opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const isWin = platform === 'win32';
  const p = isWin ? path.win32 : path.posix;
  const pathVar = env.PATH || env.Path || env.path || '';
  const exts = isWin
    ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())]
    : [''];
  const hasDir = name.includes('/') || (isWin && name.includes('\\'));
  const dirs = hasDir ? [''] : pathVar.split(isWin ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    const base = dir ? p.join(dir.replace(/^"(.*)"$/, '$1'), name) : p.resolve(opts.cwd || process.cwd(), name);
    // On Windows an extension-less file (the npm `claude` bash shim) is not runnable: prefer .exe/.cmd.
    const candidates = isWin && !p.extname(base) ? exts.filter(Boolean).map((e) => base + e).concat(base) : exts.map((e) => base + e);
    for (const c of candidates) {
      if (isRunnable(c, isWin)) return c;
    }
  }
  return null;
}

function isRunnable(file, isWin) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (isWin) return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build Claude's arguments for an agent launch.
 * @param {{sessionId:string, model?:string, effort?:string, mode?:string}} agent
 * @param {{resume:boolean, settingsPath:string, prompt?:string}} opts
 */
function claudeArgs(agent, opts) {
  const args = opts.resume ? ['--resume', agent.sessionId] : ['--session-id', agent.sessionId];
  args.push('--settings', opts.settingsPath);
  if (agent.model) args.push('--model', agent.model);
  if (agent.effort) args.push('--effort', agent.effort);
  if (agent.mode) args.push('--permission-mode', agent.mode);
  if (opts.prompt) args.push(opts.prompt);
  return args;
}

/** Quote one argument for a Windows command line (MSVCRT / CommandLineToArgvW rules). */
function quoteWinArg(arg) {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let bs = 0;
  for (const c of arg) {
    if (c === '\\') { bs++; continue; }
    if (c === '"') { out += '\\'.repeat(bs * 2 + 1) + '"'; bs = 0; continue; }
    out += '\\'.repeat(bs) + c;
    bs = 0;
  }
  return out + '\\'.repeat(bs * 2) + '"';
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Escape an argument for `cmd.exe /d /s /c "..."` (same approach as cross-spawn). */
function escapeCmdArg(arg, doubleEscape) {
  let a = String(arg).replace(/\r?\n/g, ' '); // cmd.exe ends the command at a newline
  a = a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  a = `"${a}"`.replace(CMD_META, '^$1');
  if (doubleEscape) a = a.replace(CMD_META, '^$1');
  return a;
}

/**
 * Read an npm cmd-shim (claude.cmd) and return the JS file it runs, so we can run it with node
 * directly and skip cmd.exe quoting (which cannot carry newlines in a prompt).
 * @param {string} cmdFile @returns {string|null}
 */
function npmShimTarget(cmdFile) {
  let text;
  try { text = fs.readFileSync(cmdFile, 'utf8'); } catch { return null; }
  const m = text.match(/"%(?:~?dp0%?|dp0%)\\([^"]+?\.(?:c|m)?js)"/i);
  if (!m) return null;
  const target = path.join(path.dirname(cmdFile), ...m[1].split(/[\\/]/));
  return fs.existsSync(target) ? target : null;
}

/**
 * Work out what to hand to node-pty.
 * @param {string[]} base   the command (CC_CLAUDE split, or ['claude'])
 * @param {string[]} args   Claude's arguments
 * @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, cwd?: string}} [opts]
 * @returns {{file:string, args:string[]|string, display:string[]}}
 *   args is a ready-made command line string on Windows (node-pty passes it through verbatim).
 */
function spawnSpec(base, args, opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  if (!base.length) throw new Error('empty claude command');
  const [cmd, ...pre] = base;
  const resolved = which(cmd, { env, platform, cwd: opts.cwd });
  if (!resolved) throw new Error(`"${cmd}" was not found on PATH. Install Claude Code or set CC_CLAUDE.`);
  const all = [...pre, ...args];
  if (platform !== 'win32') return { file: resolved, args: all, display: [resolved, ...all] };

  const ext = path.win32.extname(resolved).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const js = npmShimTarget(resolved);
    const node = js && (fs.existsSync(path.win32.join(path.win32.dirname(resolved), 'node.exe'))
      ? path.win32.join(path.win32.dirname(resolved), 'node.exe') : which('node', { env, platform }));
    if (js && node) {
      const a = [js, ...all];
      return { file: node, args: a.map(quoteWinArg).join(' '), display: [node, ...a] };
    }
    const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    const isShim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved) || /\\npm\\[^\\]+\.cmd$/i.test(resolved);
    const line = [resolved.replace(CMD_META, '^$1'), ...all.map((a) => escapeCmdArg(a, isShim))].join(' ');
    return { file: comspec, args: `/d /s /c "${line}"`, display: [comspec, '/d', '/s', '/c', resolved, ...all] };
  }
  return { file: resolved, args: all.map(quoteWinArg).join(' '), display: [resolved, ...all] };
}

/** The base command: CC_CLAUDE (split) or `claude`. */
function baseCommand(env = process.env) {
  const v = (env.CC_CLAUDE || '').trim();
  return v ? splitCommand(v) : ['claude'];
}

module.exports = { splitCommand, which, claudeArgs, quoteWinArg, escapeCmdArg, npmShimTarget, spawnSpec, baseCommand };
