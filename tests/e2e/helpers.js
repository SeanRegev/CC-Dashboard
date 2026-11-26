// @ts-check
'use strict';
// End-to-end harness: starts a real core and the real Electron app against a temp CC_HOME, with
// tests/fake-claude.js standing in for `claude`. Never touches the user's ~/.cc-dashboard.
//
//   const h = require('./helpers');
//   const ccHome = h.makeCcHome();
//   const core = await h.startCore({ ccHome });           // waits for <ccHome>/core.json + /health
//   const rpc = await h.connectRpc(core.info);            // JSON-RPC over WebSocket (protocol.js)
//   const { app, page } = await h.launchApp({ ccHome });  // Playwright ElectronApplication + first window
//   await h.screenshot(page, 'smoke');                    // -> test-results/smoke.png
//   await h.closeApp(app); await core.stop(); h.removeCcHome(ccHome);
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const APP_MAIN = path.join(REPO, 'packages', 'app', 'src', 'main', 'main.js');
const CORE_ENTRY = path.join(REPO, 'packages', 'core', 'src', 'index.js');
const FAKE_CLAUDE = path.join(REPO, 'tests', 'fake-claude.js');
const RESULTS_DIR = path.join(REPO, 'test-results');

/** Reason the e2e suite can't run on this checkout yet, or '' if it can. */
function missingPieces() {
  const missing = [];
  if (!fs.existsSync(APP_MAIN)) missing.push(path.relative(REPO, APP_MAIN));
  if (!fs.existsSync(CORE_ENTRY)) missing.push(path.relative(REPO, CORE_ENTRY));
  return missing.length ? `e2e skipped: ${missing.join(' and ')} not in this checkout yet` : '';
}

/**
 * Playwright's Electron driver. Resolution order: playwright-core (devDependency, used in CI),
 * playwright, then the copy preinstalled on the dev container.
 * @returns {import('playwright-core')['_electron']}
 */
function loadElectronDriver() {
  const candidates = ['playwright-core', 'playwright', '/opt/node-tools/node_modules/playwright'];
  const errors = [];
  for (const id of candidates) {
    try { return require(id)._electron; } catch (e) { errors.push(`${id}: ${e instanceof Error ? e.message.split('\n')[0] : e}`); }
  }
  throw new Error(`Playwright not found (npm ci installs playwright-core). Tried:\n  ${errors.join('\n  ')}`);
}

/** A fresh temp CC_HOME. */
function makeCcHome(prefix = 'cc-e2e-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeCcHome(ccHome) {
  try { fs.rmSync(ccHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { /* Windows file locks */ }
}

/** The CC_CLAUDE command line: `node <repo>/tests/fake-claude.js` (path quoted only if it has spaces). */
function fakeClaudeCommand() {
  return `node ${/\s/.test(FAKE_CLAUDE) ? `"${FAKE_CLAUDE}"` : FAKE_CLAUDE}`;
}

/**
 * Environment shared by the core and the app in tests.
 * @param {{ ccHome: string, env?: Record<string, string> }} opts
 * @returns {Record<string, string>}
 */
function testEnv({ ccHome, env = {} }) {
  /** @type {Record<string, string>} */
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  // Inherited from a parent Electron/Node would make the app start as plain Node.
  delete base.ELECTRON_RUN_AS_NODE;
  /** @type {Record<string, string|undefined>} */
  const out = {
    ...base,
    CC_HOME: ccHome,
    CC_CLAUDE: fakeClaudeCommand(),
    CC_DISABLE_GPU: '1',
    // Never the real ~/.claude: the core lists outside sessions and reads transcripts from this folder.
    CLAUDE_CONFIG_DIR: path.join(ccHome, 'claude-config'),
    ...env,
  };
  // `env: { NAME: undefined }` removes a variable (the README screenshot scripts use the real Claude login).
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return /** @type {Record<string, string>} */ (out);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === 'EPERM'; }
}

/** Reads <ccHome>/core.json, or null if missing/partial. */
function readCoreJson(ccHome) {
  try { return JSON.parse(fs.readFileSync(path.join(ccHome, 'core.json'), 'utf8')); } catch (_) { return null; }
}

/** GET /health?token=… → parsed JSON (rejects on non-200). */
function health(info) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: info.port, path: `/health?token=${encodeURIComponent(info.token)}`, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`/health -> HTTP ${res.statusCode}: ${body}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('/health timed out')));
    req.on('error', reject);
  });
}

/**
 * Waits for core.json (port, token, live pid) and a healthy /health.
 * @param {string} ccHome
 * @param {{ timeoutMs?: number, proc?: import('child_process').ChildProcess, logs?: () => string }} [opts]
 */
async function waitForCoreJson(ccHome, { timeoutMs = 20000, proc, logs = () => '' } = {}) {
  const until = Date.now() + timeoutMs;
  let lastErr = 'core.json not written';
  while (Date.now() < until) {
    if (proc && proc.exitCode !== null) {
      throw new Error(`core exited with code ${proc.exitCode} before it was ready.\n--- core output ---\n${logs()}`);
    }
    const info = readCoreJson(ccHome);
    if (info && info.port && info.token && info.pid && pidAlive(info.pid)) {
      try { await health(info); return info; } catch (e) { lastErr = String(e); }
    }
    await sleep(100);
  }
  throw new Error(`core not ready after ${timeoutMs} ms (${lastErr}) in ${ccHome}.\n--- core output ---\n${logs()}`);
}

/** Kills a process and its children (node-pty / ConPTY trees on Windows). */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch (_) { /* gone */ }
  }
}

/**
 * Starts a real core: `node packages/core/src/index.js` with the test env. Output goes to
 * test-results/<name>-core.log and is included in errors.
 * @param {{ ccHome: string, env?: Record<string,string>, name?: string, timeoutMs?: number }} opts
 */
async function startCore({ ccHome, env = {}, name = 'core', timeoutMs = 20000 }) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const logFile = path.join(RESULTS_DIR, `${name}-core.log`);
  let output = '';
  const proc = spawn(process.execPath, [CORE_ENTRY], {
    cwd: REPO, env: testEnv({ ccHome, env }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const onData = (d) => { output += d; fs.appendFileSync(logFile, d); };
  /** @type {NodeJS.ReadableStream} */ (proc.stdout).on('data', onData);
  /** @type {NodeJS.ReadableStream} */ (proc.stderr).on('data', onData);
  const logs = () => output.slice(-8000);
  let info;
  try {
    info = await waitForCoreJson(ccHome, { timeoutMs, proc, logs });
  } catch (e) {
    killTree(proc.pid);
    throw e;
  }
  return {
    proc, info, ccHome, logs, logFile,
    /** Stops the core (and any core the app may have started in the same CC_HOME). */
    async stop() {
      const other = readCoreJson(ccHome);
      if (other && other.pid && other.pid !== proc.pid) killTree(other.pid);
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once('exit', r));
        killTree(proc.pid);
        await Promise.race([exited, sleep(5000)]);
        if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill('SIGKILL'); } catch (_) { /* gone */ } }
      }
    },
  };
}

/**
 * JSON-RPC client for the core (see packages/shared/protocol.js).
 * @param {{ port: number, token: string }} info
 */
async function connectRpc(info) {
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/rpc?token=${encodeURIComponent(info.token)}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let nextId = 1;
  /** @type {Map<number, {resolve: Function, reject: Function, method: string}>} */
  const pending = new Map();
  /** @type {Array<{event: string, data: any}>} */
  const events = [];
  /** @type {Array<() => void>} */
  let waiters = [];
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch (_) { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = /** @type {any} */ (pending.get(msg.id));
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(`${p.method}: ${msg.error.code}: ${msg.error.message}`), { code: msg.error.code }));
      else p.resolve(msg.result);
    } else if (msg.event) {
      events.push(msg);
      const w = waiters; waiters = []; w.forEach((f) => f());
    }
  });
  ws.on('close', () => { for (const p of pending.values()) p.reject(new Error(`${p.method}: connection closed`)); pending.clear(); });
  return {
    ws,
    events,
    /** @param {string} method @param {object} [params] */
    call(method, params = {}, timeoutMs = 15000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: no response in ${timeoutMs} ms`)); }, timeoutMs);
        pending.set(id, {
          method,
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    /** Resolves with the first event (already received or future) matching name + predicate. */
    async waitForEvent(name, pred = () => true, timeoutMs = 15000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const hit = events.find((e) => e.event === name && pred(e.data));
        if (hit) return hit.data;
        const left = until - Date.now();
        if (left <= 0) throw new Error(`no ${name} event in ${timeoutMs} ms; got: ${events.map((e) => e.event).join(', ')}`);
        await Promise.race([new Promise((r) => waiters.push(() => r(undefined))), sleep(Math.min(left, 250))]);
      }
    },
    close() { try { ws.close(); } catch (_) { /* closed */ } },
  };
}

/**
 * Launches the Electron app with Playwright and waits for its first window.
 * @param {{ ccHome: string, env?: Record<string,string>, timeoutMs?: number }} opts
 */
async function launchApp({ ccHome, env = {}, timeoutMs = 30000 }) {
  const electron = loadElectronDriver();
  const args = [];
  // CI Linux runners can't use Chromium's SUID sandbox from node_modules (and AppArmor blocks
  // user namespaces on Ubuntu 24.04).
  if (process.platform === 'linux') args.push('--no-sandbox');
  args.push(REPO);
  const app = await electron.launch({
    args,
    cwd: REPO,
    env: testEnv({ ccHome, env }),
    timeout: timeoutMs,
  });
  const page = await app.firstWindow({ timeout: timeoutMs });
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function closeApp(app) {
  if (!app) return;
  try {
    await Promise.race([app.close(), sleep(10000).then(() => { throw new Error('close timed out'); })]);
  } catch (_) {
    try { killTree(app.process().pid); } catch (__) { /* gone */ }
  }
}

/** Visible text of the sidebar (data-testid="sidebar" preferred), falling back to the whole body. */
async function sidebarText(page) {
  return page.evaluate(() => {
    // Try in priority order: one combined selector returns the first match in DOM order,
    // which picked an empty <nav> in the top bar before the real sidebar.
    const pick = ['[data-testid="sidebar"]', '#sidebar', '.sidebar', 'aside', 'nav']
      .map((s) => document.querySelector(s)).find(Boolean) || document.body;
    const e = /** @type {HTMLElement} */ (pick);
    return e.innerText || e.textContent || '';
  });
}

/** Saves a PNG to test-results/<name>.png and returns its path. */
async function screenshot(page, name) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${name.replace(/[^\w.-]+/g, '_')}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** Polls an async/sync condition until truthy. */
async function waitUntil(fn, what, timeoutMs = 15000, describe = async () => '') {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}. ${await describe()}`);
}

module.exports = {
  REPO, APP_MAIN, CORE_ENTRY, FAKE_CLAUDE, RESULTS_DIR,
  missingPieces, loadElectronDriver, makeCcHome, removeCcHome, fakeClaudeCommand, testEnv,
  readCoreJson, waitForCoreJson, health, startCore, connectRpc, killTree,
  launchApp, closeApp, sidebarText, screenshot, waitUntil, sleep,
};
