#!/usr/bin/env node
// @ts-check
'use strict';
/**
 * cc-core entry: `node packages/core/src/index.js` (or Electron with ELECTRON_RUN_AS_NODE=1).
 *
 * Listens on 127.0.0.1 with a random free port and a random token, and writes
 * <home>/core.json = { port, token, pid, version } so the app can find it. If a live core
 * already owns that file, exits cleanly (code 0) without touching it.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { homeDir } = require('../../shared/protocol');
const { Core } = require('./core');
const { createServer } = require('./server');
const { writeFileAtomic, readJson } = require('./store');

const VERSION = (() => {
  // In the installed app this file is in app.asar.unpacked/, while package.json is inside app.asar.
  const own = path.join(__dirname, '..', '..', '..', 'package.json');
  for (const file of [own, own.replace(/app\.asar\.unpacked/, 'app.asar')]) {
    try { return require(file).version || '0.0.0'; } catch { /* try the next */ }
  }
  return '0.0.0';
})();

/** @param {number} pid */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {any} */ (e).code === 'EPERM'; // exists, but not ours to signal
  }
}

/** Does the core described by core.json answer /health? @param {any} info */
function healthy(info, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!info || !info.port || !info.token) return resolve(false);
    const req = http.get({ host: '127.0.0.1', port: info.port, path: '/health', headers: { 'x-cc-token': info.token }, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Is another live core using this home? @param {string} home */
async function otherCoreRunning(home) {
  const info = readJson(path.join(home, 'core.json'));
  return Boolean(info && info.pid !== process.pid && pidAlive(info.pid) && (await healthy(info)));
}

/**
 * Take <home>/core.lock so two cores starting at the same moment don't both serve.
 * @returns {Promise<boolean>} false if another core owns the home
 */
async function takeLock(home) {
  const lock = path.join(home, 'core.lock');
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'EEXIST') throw e;
    }
    let owner = 0;
    try { owner = Number(fs.readFileSync(lock, 'utf8').trim()); } catch { /* vanished */ }
    if (owner && owner !== process.pid && pidAlive(owner) && Date.now() < deadline) {
      if (await otherCoreRunning(home)) return false;
      await new Promise((r) => setTimeout(r, 100)); // it is still starting
      continue;
    }
    if (owner && owner !== process.pid && pidAlive(owner) && (await otherCoreRunning(home))) return false;
    try { fs.unlinkSync(lock); } catch { /* someone else removed it */ }
  }
}

function makeLogger(home) {
  const file = path.join(home, 'core.log');
  try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.old'); } catch { /* none yet */ }
  return (msg) => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    try { fs.appendFileSync(file, line); } catch { /* ignore */ }
    if (process.env.CC_CORE_VERBOSE) process.stderr.write(line);
  };
}

async function main() {
  const home = homeDir();
  fs.mkdirSync(home, { recursive: true });
  if (await otherCoreRunning(home)) {
    process.stdout.write('cc-core is already running\n');
    return 0;
  }
  if (!(await takeLock(home))) {
    process.stdout.write('cc-core is already running\n');
    return 0;
  }
  const log = makeLogger(home);
  const lockFile = path.join(home, 'core.lock');
  const infoFile = path.join(home, 'core.json');
  const token = crypto.randomBytes(24).toString('hex');
  const core = new Core({ home, version: VERSION });
  const srv = createServer(core, { token, log });
  const port = await srv.listen(0);
  core.setEndpoint(`http://127.0.0.1:${port}`, token);
  core.start();
  writeFileAtomic(infoFile, JSON.stringify({ port, token, pid: process.pid, version: VERSION }, null, 2) + '\n', { mode: 0o600 });
  log(`cc-core ${VERSION} listening on 127.0.0.1:${port} (pid ${process.pid})`);
  process.stdout.write(`cc-core ${VERSION} listening on 127.0.0.1:${port}\n`);

  let closing = false;
  const shutdown = (why) => {
    if (closing) return;
    closing = true;
    log(`shutting down (${why})`);
    core.shutdown();
    const info = readJson(infoFile);
    if (info && info.pid === process.pid) try { fs.unlinkSync(infoFile); } catch { /* ignore */ }
    try { if (fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lockFile); } catch { /* ignore */ }
    const t = setTimeout(() => process.exit(0), 1500);
    srv.close().then(() => { clearTimeout(t); process.exit(0); });
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(/** @type {NodeJS.Signals} */ (sig), () => shutdown(sig)); } catch { /* not on this platform */ }
  }
  // A long-lived service: log a bug, don't take every agent down with it.
  process.on('uncaughtException', (e) => log(`uncaught: ${e && e.stack}`));
  process.on('unhandledRejection', (e) => log(`unhandled: ${e && /** @type {any} */ (e).stack || e}`));
  return null;
}

if (require.main === module) {
  main().then((code) => { if (code !== null) process.exit(code); }, (e) => {
    process.stderr.write(`cc-core failed to start: ${e && e.stack}\n`);
    process.exit(1);
  });
}

module.exports = { main, pidAlive, healthy, VERSION };
