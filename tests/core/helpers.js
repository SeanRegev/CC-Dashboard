'use strict';
// Shared helpers for the core tests: a fresh CC_HOME per test, start/stop a real core process,
// connect a client, and poll for conditions (never fixed sleeps).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connect } = require('../../packages/core/src/client');

const REPO = path.resolve(__dirname, '..', '..');
const CORE = path.join(REPO, 'packages', 'core', 'src', 'index.js');
const FAKE = path.join(REPO, 'tests', 'fake-claude.js');
const FIXTURES = path.join(__dirname, 'fixtures');

/** CC_CLAUDE value that runs a script with this Node. Paths are quoted (spaces on Windows). */
function claudeCmd(script = FAKE) {
  return `"${process.execPath}" "${script}"`;
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-core-test-'));
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows may hold files briefly */ }
}

/**
 * Poll until fn() returns something truthy.
 * @template T @param {() => T|Promise<T>} fn @returns {Promise<T>}
 */
async function waitFor(fn, { timeout = 10000, interval = 25, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Start a core process. Resolves once core.json names this process and a client is connected.
 * @param {{home?: string, env?: Record<string,string>, claude?: string}} [opts]
 */
async function startCore(opts = {}) {
  const home = opts.home || tempHome();
  const env = {
    ...process.env,
    CC_HOME: home,
    CC_CLAUDE: opts.claude || claudeCmd(),
    CC_TICK_MS: '50',
    ...(opts.env || {}),
  };
  delete env.CLAUDECODE;
  const proc = spawn(process.execPath, [CORE], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  const info = await waitFor(() => {
    if (proc.exitCode !== null) throw new Error(`core exited early: ${output}`);
    const i = readJson(path.join(home, 'core.json'));
    return i && i.pid === proc.pid ? i : null;
  }, { what: 'core.json', timeout: 15000 });
  const client = await connect({ home, clientName: 'test' });
  const core = {
    home, proc, info, client, exited, env,
    output: () => output,
    /** Events of one kind seen by this client, as they arrive. */
    collect(event) {
      const seen = [];
      client.on(event, (d) => seen.push(d));
      return seen;
    },
    async status(id) {
      const list = await client.call('agents.list');
      const row = list.find((r) => r.agent.id === id);
      return row && { ...row.status, running: row.running };
    },
    /** Poll agents.list until pred(status) holds. */
    waitStatus(id, pred, what = 'status', timeout = 10000) {
      return waitFor(async () => {
        const s = await core.status(id);
        return s && pred(s) ? s : null;
      }, { what: `${id} ${what}`, timeout });
    },
    async replay(id) {
      return (await client.call('agents.attach', { id })).replay;
    },
    /** A space for the test, in its own folder under home. */
    async space(name = 'proj') {
      const dir = path.join(home, name);
      fs.mkdirSync(dir, { recursive: true });
      return client.call('spaces.add', { path: dir });
    },
    async stop(signal = 'SIGTERM') {
      client.close();
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      return exited;
    },
    async dispose() {
      await core.stop();
      if (!opts.home) rmrf(home);
    },
  };
  return core;
}

/** POST a hook event to the core directly (as hook.js would). */
async function postHook(core, agentId, event, payload = {}, token = core.info.token) {
  const res = await fetch(`http://127.0.0.1:${core.info.port}/hook?agent=${encodeURIComponent(agentId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cc-event': event, 'x-cc-token': token },
    body: JSON.stringify(payload),
  });
  return res.status;
}

/** Lines of argv logged by fixtures/wrapped-claude.js. */
function argvLog(home) {
  try {
    return fs.readFileSync(path.join(home, 'argv.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

module.exports = { REPO, CORE, FAKE, FIXTURES, claudeCmd, tempHome, rmrf, waitFor, readJson, startCore, postHook, argvLog };
