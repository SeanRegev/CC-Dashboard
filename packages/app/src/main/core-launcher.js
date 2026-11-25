// @ts-check
'use strict';
/**
 * Finds a running cc-core, or starts one detached, and returns { port, token }.
 * No Electron imports here, so it is unit-tested with plain Node (tests/unit/core-launcher.test.js).
 *
 * Discovery (docs/ARCHITECTURE.md): the core writes <homeDir>/core.json = { port, token, pid, version }.
 * A core counts as alive when GET /health with the token answers { ok: true }.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

/**
 * @typedef {{port:number, token:string, pid?:number, version?:string}} CoreInfo
 */

/** @param {string} home @returns {CoreInfo|null} */
function readCoreJson(home) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(home, 'core.json'), 'utf8'));
    if (!info || typeof info.port !== 'number' || typeof info.token !== 'string') return null;
    return info;
  } catch {
    return null;
  }
}

/** @param {number|undefined} pid */
function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return true; // unknown: let /health decide
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: exists but belongs to someone else
    return /** @type {any} */ (e).code === 'EPERM';
  }
}

/**
 * GET /health. Resolves the parsed body when it says ok, else null. Never rejects.
 * @param {CoreInfo} info @param {number} [timeoutMs]
 * @returns {Promise<{ok:boolean, version?:string}|null>}
 */
function checkHealth(info, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1', port: info.port, path: `/health?token=${encodeURIComponent(info.token)}`,
      headers: { 'x-cc-token': info.token }, timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const j = JSON.parse(body);
          resolve(j && j.ok ? j : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/**
 * The live core described by core.json, or null.
 * @param {string} home
 * @returns {Promise<CoreInfo|null>}
 */
async function findCore(home) {
  const info = readCoreJson(home);
  if (!info) return null;
  if (!isPidAlive(info.pid)) return null;
  return (await checkHealth(info)) ? info : null;
}

/**
 * How to start the core.
 * - Installed app: Electron's own binary as Node (ELECTRON_RUN_AS_NODE=1).
 * - Development: system `node`, or CC_CORE_NODE.
 * Entry: installed → <resourcesPath>/app.asar.unpacked/packages/core/src/index.js (never inside app.asar:
 * node-pty is native and must be unpacked); development → <appRoot>/packages/core/src/index.js.
 * CC_CORE_ENTRY overrides the entry (development and tests).
 * @param {{isPackaged:boolean, execPath:string, appRoot:string, resourcesPath?:string, env?:NodeJS.ProcessEnv}} o
 * @returns {{command:string, args:string[], env:NodeJS.ProcessEnv}}
 */
function coreCommand(o) {
  const env = { ...(o.env || process.env) };
  const coreRel = ['packages', 'core', 'src', 'index.js'];
  const defaultEntry = o.isPackaged
    ? path.join(o.resourcesPath || path.dirname(o.appRoot), 'app.asar.unpacked', ...coreRel)
    : path.join(o.appRoot, ...coreRel);
  const entry = env.CC_CORE_ENTRY || defaultEntry;
  delete env.CC_CORE_ENTRY;
  if (o.isPackaged) {
    env.ELECTRON_RUN_AS_NODE = '1';
    return { command: o.execPath, args: [entry], env };
  }
  delete env.ELECTRON_RUN_AS_NODE;
  const command = env.CC_CORE_NODE || (process.platform === 'win32' ? 'node.exe' : 'node');
  return { command, args: [entry], env };
}

/**
 * Start the core detached, so it outlives the window (agents keep running when the app closes).
 * @param {{command:string, args:string[], env:NodeJS.ProcessEnv, logFile?:string}} cmd
 * @returns {number|undefined} pid
 */
function spawnCore(cmd) {
  /** @type {any} */
  let out = 'ignore';
  if (cmd.logFile) {
    try {
      fs.mkdirSync(path.dirname(cmd.logFile), { recursive: true });
      out = fs.openSync(cmd.logFile, 'a');
    } catch { out = 'ignore'; }
  }
  const child = spawn(cmd.command, cmd.args, {
    detached: true,
    stdio: ['ignore', out, out],
    env: cmd.env,
    windowsHide: true,
  });
  child.on('error', () => { /* reported as a timeout by waitForCore */ });
  child.unref();
  if (typeof out === 'number') try { fs.closeSync(out); } catch { /* ignore */ }
  return child.pid;
}

/**
 * Poll core.json + /health until a live core shows up.
 * @param {string} home @param {{timeoutMs?:number, intervalMs?:number}} [o]
 * @returns {Promise<CoreInfo|null>}
 */
async function waitForCore(home, o = {}) {
  const deadline = Date.now() + (o.timeoutMs ?? 20000);
  const interval = o.intervalMs ?? 150;
  while (Date.now() < deadline) {
    const info = await findCore(home);
    if (info) return info;
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

/**
 * Find the core or start it.
 * @param {{home:string, isPackaged:boolean, execPath:string, appRoot:string, resourcesPath?:string, env?:NodeJS.ProcessEnv, timeoutMs?:number}} o
 * @returns {Promise<CoreInfo>}
 */
async function ensureCore(o) {
  const running = await findCore(o.home);
  if (running) return running;
  const cmd = coreCommand(o);
  spawnCore({ ...cmd, logFile: path.join(o.home, 'core.log') });
  const info = await waitForCore(o.home, { timeoutMs: o.timeoutMs });
  if (!info) throw new Error(`cc-core did not start (${cmd.command} ${cmd.args.join(' ')}); see ${path.join(o.home, 'core.log')}`);
  return info;
}

module.exports = { readCoreJson, isPidAlive, checkHealth, findCore, coreCommand, spawnCore, waitForCore, ensureCore };
