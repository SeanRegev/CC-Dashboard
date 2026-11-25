// @ts-check
'use strict';
/**
 * Launch the Electron app and drive its window over the Chrome DevTools Protocol.
 * Dependency-free (uses `ws`, already a dependency), so e2e tests and screenshots run anywhere
 * Electron runs, Windows included. Dev/test tooling only.
 */
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP_DIR = path.join(__dirname, '..', '..', '..', '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = /** @type {net.AddressInfo} */ (srv.address()).port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

/** @param {number} port */
function listTargets(port) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 1000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve([]); } });
    }).on('error', () => resolve([])).on('timeout', function () { this.destroy(); });
  });
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{env?: NodeJS.ProcessEnv, size?: string, args?: string[], timeoutMs?: number}} [o]
 */
async function launchApp(o = {}) {
  const electron = /** @type {string} */ (/** @type {unknown} */ (require('electron')));
  const port = await freePort();
  const env = { ...process.env, CC_DISABLE_GPU: '1', ...(o.env || {}) };
  if (o.size) env.CC_WINDOW_SIZE = o.size;
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--no-sandbox', `--remote-debugging-port=${port}`, ...(o.args || []), APP_DIR];
  const proc = spawn(electron, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });

  const deadline = Date.now() + (o.timeoutMs || 30000);
  /** @type {any} */
  let target = null;
  while (Date.now() < deadline && !target) {
    if (proc.exitCode !== null) throw new Error(`electron exited early (${proc.exitCode}):\n${log}`);
    const list = /** @type {any[]} */ (await listTargets(port));
    target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    if (!target) await sleep(200);
  }
  if (!target) { proc.kill(); throw new Error(`no app window over CDP:\n${log}`); }

  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let nextId = 1;
  /** @type {Map<number, {resolve:(v:any)=>void, reject:(e:any)=>void}>} */
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id && pending.has(msg.id)) {
      const p = /** @type {any} */ (pending.get(msg.id));
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
  });
  /** @param {string} method @param {any} [params] @returns {Promise<any>} */
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  /** Evaluate an expression (or an async function body via `(async () => …)()`) in the page. @param {string} expr */
  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
    return r.result.value;
  }

  /** Poll until `expr` is truthy. @param {string} expr @param {number} [timeoutMs] */
  async function waitFor(expr, timeoutMs = 10000) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      try { last = await evaluate(expr); if (last) return last; } catch (e) { last = e; }
      await sleep(100);
    }
    throw new Error(`timed out waiting for: ${expr} (last: ${last})`);
  }

  /** @param {string} selector */
  async function click(selector) {
    const ok = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    if (!ok) throw new Error(`no element ${selector}`);
  }

  /** Type text into whatever has focus (like an IME commit). @param {string} text */
  const insertText = (text) => send('Input.insertText', { text });

  /**
   * A real key press through the browser input pipeline.
   * @param {string} key e.g. 'Enter', 'c', 'Tab', '\\'
   * @param {{ctrl?:boolean, shift?:boolean, alt?:boolean, meta?:boolean, code?:string, keyCode?:number}} [mods]
   */
  async function press(key, mods = {}) {
    const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);
    const named = /** @type {Record<string, [string, number, string?]>} */ ({
      Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], '\\': ['Backslash', 220, '\\'],
    });
    let code = mods.code;
    let keyCode = mods.keyCode;
    /** @type {string|undefined} */
    let text;
    if (named[key]) { code = code || named[key][0]; keyCode = keyCode || named[key][1]; text = named[key][2]; }
    else if (/^[a-z]$/i.test(key)) { code = code || `Key${key.toUpperCase()}`; keyCode = keyCode || key.toUpperCase().charCodeAt(0); text = key; }
    else if (/^[0-9]$/.test(key)) { code = code || `Digit${key}`; keyCode = keyCode || key.charCodeAt(0); text = key; }
    if (modifiers & 2 || modifiers & 4) text = undefined;
    const base = { modifiers, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /** @param {string} file */
  async function screenshot(file) {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  async function close() {
    try { ws.close(); } catch { /* ignore */ }
    if (proc.exitCode === null) {
      proc.kill();
      await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]);
      if (proc.exitCode === null) try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }

  return { proc, send, evaluate, waitFor, click, insertText, press, screenshot, close, log: () => log };
}

module.exports = { launchApp, freePort, sleep, APP_DIR };
