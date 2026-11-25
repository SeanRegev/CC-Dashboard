// @ts-check
'use strict';
/**
 * A small Node client for the core, used by tests and by the app's main process.
 *
 *   const { connect } = require('packages/core/src/client');
 *   const c = await connect({ clientName: 'app' });      // finds the core via <home>/core.json
 *   const agents = await c.call('agents.list');
 *   const off = c.on('agent.status', (s) => ...);
 *   c.close();
 *
 * `findCore()` / `startCore()` help the app find a running core or start one detached.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { homeDir } = require('../../shared/protocol');

/** @param {string} [home] */
function readCoreInfo(home = homeDir()) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(home, 'core.json'), 'utf8'));
    return info && info.port && info.token ? info : null;
  } catch {
    return null;
  }
}

/** @param {{port:number, token:string}} info @returns {Promise<boolean>} */
function ping(info, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: info.port, path: '/health', headers: { 'x-cc-token': info.token }, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** core.json of a core that answers, or null. @param {string} [home] */
async function findCore(home = homeDir()) {
  const info = readCoreInfo(home);
  return info && (await ping(info)) ? info : null;
}

/**
 * Start the core detached (it outlives the caller) and wait for it to answer.
 * @param {{home?: string, execPath?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number}} [opts]
 *   execPath: Node to run it with. From Electron's main process pass process.execPath and
 *   env { ...process.env, ELECTRON_RUN_AS_NODE: '1' }.
 */
async function startCore(opts = {}) {
  const home = opts.home || homeDir();
  const found = await findCore(home);
  if (found) return found;
  const env = { ...(opts.env || process.env), CC_HOME: home };
  const child = spawn(opts.execPath || process.execPath, [path.join(__dirname, 'index.js')], {
    detached: true, stdio: 'ignore', env, windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + (opts.timeoutMs || 15000);
  while (Date.now() < deadline) {
    const info = await findCore(home);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('cc-core did not start in time');
}

class CoreClient {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    /** @type {Map<number, {resolve:Function, reject:Function, timer:NodeJS.Timeout}>} */
    this.pending = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map();
    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('close', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('connection closed'), { code: 'closed' })); }
      this.pending.clear();
      this.emit('close', null);
    });
    ws.on('error', () => { /* 'close' follows */ });
  }

  onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg && typeof msg.event === 'string') return this.emit(msg.event, msg.data);
    const p = this.pending.get(msg && msg.id);
    if (!p) return undefined;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message || msg.error.code), { code: msg.error.code }));
    else p.resolve(msg.result);
    return undefined;
  }

  emit(event, data) {
    for (const fn of [...(this.handlers.get(event) || []), ...(this.handlers.get('*') || [])]) {
      try { fn(data, event); } catch { /* a handler's bug is its own */ }
    }
  }

  /**
   * @param {string} method @param {any} [params] @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  call(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) return reject(Object.assign(new Error('not connected'), { code: 'closed' }));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`${method} timed out`), { code: 'timeout' })); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
      return undefined;
    });
  }

  /** Listen to a core event ('*' for all). Returns an unsubscribe function. @param {string} event @param {Function} fn */
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    /** @type {Set<Function>} */ (this.handlers.get(event)).add(fn);
    return () => this.handlers.get(event)?.delete(fn);
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/**
 * @param {{home?: string, port?: number, token?: string, clientName?: string}} [opts]
 * @returns {Promise<CoreClient>}
 */
function connect(opts = {}) {
  const info = opts.port && opts.token ? { port: opts.port, token: opts.token } : readCoreInfo(opts.home);
  if (!info) return Promise.reject(new Error('cc-core is not running (no core.json)'));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/rpc?token=${encodeURIComponent(info.token)}`);
    const fail = (e) => reject(e);
    ws.once('error', fail);
    ws.once('unexpected-response', (_req, res) => {
      ws.off('error', fail);
      ws.on('error', () => { /* we are rejecting already */ });
      try { res.resume(); ws.terminate(); } catch { /* ignore */ }
      reject(Object.assign(new Error(`core refused the connection (${res.statusCode})`), { code: res.statusCode === 401 ? 'unauthorized' : 'refused', status: res.statusCode }));
    });
    ws.once('open', async () => {
      ws.off('error', fail);
      const client = new CoreClient(ws);
      if (opts.clientName) {
        try { await client.call('hello', { clientName: opts.clientName }); } catch (e) { client.close(); return reject(e); }
      }
      resolve(client);
      return undefined;
    });
  });
}

module.exports = { connect, CoreClient, readCoreInfo, findCore, startCore, ping };
