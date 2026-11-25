// @ts-check
/**
 * Browser WebSocket client for the cc-core protocol (packages/shared/protocol.js).
 *
 *   const client = new CoreClient({ getConnection: () => window.cc.getConnection() });
 *   client.on('agent.status', (s) => …);
 *   client.onReattach((id, replay) => …);   // after a reconnect, for each attached terminal
 *   await client.start();
 *   const agents = await client.call('agents.list');
 *
 * - Requests made while disconnected wait for the next connection (or reject after `callTimeout`).
 * - Reconnects with exponential backoff; asks `getConnection()` again each time, so a core that
 *   restarted on another port/token is found.
 * - Agents attached with `attach()` are re-attached after every reconnect.
 * Works with any WHATWG WebSocket (browser, Electron renderer, Node 22's global WebSocket).
 */
import { backoffDelay } from './logic.js';

/** @typedef {'idle'|'connecting'|'open'|'closed'} ConnState */

export class RpcError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export class CoreClient {
  /**
   * @param {{
   *   getConnection: () => Promise<{port:number, token:string} | null>,
   *   WebSocketImpl?: typeof WebSocket,
   *   clientName?: string,
   *   callTimeout?: number,
   *   connectTimeout?: number,
   *   backoff?: {base?:number, max?:number, jitter?:number},
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.WS = opts.WebSocketImpl || globalThis.WebSocket;
    /** @type {WebSocket|null} */
    this.ws = null;
    /** @type {ConnState} */
    this.state = 'idle';
    this.nextId = 1;
    /** @type {Map<number, {resolve:(v:any)=>void, reject:(e:any)=>void, timer:any}>} */
    this.pending = new Map();
    /** @type {Array<{msg:string, id:number}>} */
    this.queue = [];
    /** @type {Map<string, Set<(data:any)=>void>>} */
    this.handlers = new Map();
    /** @type {Set<string>} agent ids attached by this window */
    this.attached = new Set();
    this.attempt = 0;
    this.connectedOnce = false;
    this.stopped = false;
    /** @type {any} */
    this.retryTimer = null;
    /** @type {any} */
    this.hello = null;
    this.socketOpen = false;
  }

  /** Connect; resolves after the first successful hello (keeps retrying until then). */
  start() {
    this.stopped = false;
    return new Promise((resolve) => {
      const off = this.onInternal('ready', () => { off(); resolve(this.hello); });
      this.connect();
    });
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.ws) try { this.ws.close(); } catch { /* ignore */ }
    this.setState('closed');
    this.failPending('disconnected', 'client closed');
  }

  /**
   * Subscribe to a core event (agent.status, agent.output, …) or a client event:
   * 'connection' (ConnState), 'ready' (hello result), 'reconnected'.
   * @param {string} event @param {(data:any)=>void} fn @returns {() => void} unsubscribe
   */
  on(event, fn) { return this.onInternal(event, fn); }

  /** @param {(id:string, replay:string) => void} fn */
  onReattach(fn) { return this.onInternal('reattach', (/** @type {any} */ d) => fn(d.id, d.replay)); }

  /**
   * @param {string} method @param {any} [params]
   * @returns {Promise<any>}
   */
  call(method, params = {}) {
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = this.opts.callTimeout ?? 15000;
      const timer = timeout > 0 ? setTimeout(() => {
        this.pending.delete(id);
        this.queue = this.queue.filter((q) => q.id !== id);
        reject(new RpcError('timeout', `${method} timed out`));
      }, timeout) : null;
      this.pending.set(id, { resolve, reject, timer });
      if (this.socketOpen && this.ws) this.ws.send(msg);
      else this.queue.push({ msg, id });
    });
  }

  /** Attach to an agent's terminal and remember it for reconnects. @param {string} id */
  async attach(id) {
    this.attached.add(id);
    try {
      return await this.call('agents.attach', { id });
    } catch (e) {
      this.attached.delete(id);
      throw e;
    }
  }

  /** @param {string} id */
  async detach(id) {
    this.attached.delete(id);
    if (!this.socketOpen) return true;
    return this.call('agents.detach', { id }).catch(() => false);
  }

  /**
   * Fire-and-forget request (keystrokes, resizes): never rejects, dropped while disconnected.
   * @param {string} method @param {any} params
   */
  send(method, params) {
    if (!this.socketOpen || !this.ws) return;
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
  }

  // ---- internals ----

  /** @param {string} event @param {(data:any)=>void} fn */
  onInternal(event, fn) {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn);
    return () => { set && set.delete(fn); };
  }

  /** @param {string} event @param {any} data */
  emit(event, data) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(data); } catch (e) { console.error(`handler for ${event} failed`, e); }
    }
  }

  /** @param {ConnState} s */
  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('connection', s);
  }

  /** @param {string} code @param {string} message */
  failPending(code, message) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError(code, message));
      this.pending.delete(id);
    }
    this.queue = [];
  }

  async connect() {
    if (this.stopped) return;
    this.setState('connecting');
    /** @type {{port:number, token:string}|null} */
    let conn = null;
    try { conn = await this.opts.getConnection(); } catch { conn = null; }
    if (this.stopped) return;
    if (!conn || !conn.port) return this.scheduleRetry();

    const url = `ws://127.0.0.1:${conn.port}/rpc?token=${encodeURIComponent(conn.token)}`;
    /** @type {WebSocket} */
    let ws;
    try { ws = new this.WS(url); } catch { return this.scheduleRetry(); }
    this.ws = ws;
    let opened = false;

    ws.onopen = async () => {
      opened = true;
      this.socketOpen = true; // requests go straight out now; 'connection' = open fires after hello
      // hello first, then anything that was queued while we were away.
      const helloId = this.nextId++;
      const helloP = new Promise((resolve, reject) => {
        this.pending.set(helloId, { resolve, reject, timer: null });
      });
      ws.send(JSON.stringify({ id: helloId, method: 'hello', params: { clientName: this.opts.clientName || 'cc-dashboard-app' } }));
      const queued = this.queue;
      this.queue = [];
      for (const q of queued) ws.send(q.msg);
      try {
        this.hello = await helloP;
      } catch {
        this.hello = null;
      }
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setState('open');
      const wasReconnect = this.connectedOnce;
      this.connectedOnce = true;
      this.emit('ready', this.hello);
      if (wasReconnect) {
        for (const id of [...this.attached]) {
          this.call('agents.attach', { id })
            .then((r) => this.emit('reattach', { id, replay: (r && r.replay) || '' }))
            .catch(() => { this.attached.delete(id); this.emit('reattach-failed', { id }); });
        }
        this.emit('reconnected', this.hello);
      }
    };

    ws.onmessage = (ev) => {
      /** @type {any} */
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (msg && typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new RpcError(msg.error.code || 'internal', msg.error.message || 'error'));
        else p.resolve(msg.result);
      } else if (msg && typeof msg.event === 'string') {
        this.emit(msg.event, msg.data);
      }
    };

    let lostOnce = false;
    const lost = () => {
      if (lostOnce) return;
      lostOnce = true;
      clearTimeout(openTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      this.socketOpen = false;
      // Requests in flight are lost with the socket; reject them so callers are not stuck.
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new RpcError('disconnected', 'connection to core lost'));
        this.pending.delete(id);
      }
      if (this.stopped) return this.setState('closed');
      if (!opened) this.attempt++;
      this.scheduleRetry();
    };
    // Some WebSocket implementations report a refused connection with 'error' only, never 'close'.
    const abandon = () => {
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
      try { ws.close(); } catch { /* ignore */ }
      lost();
    };
    const openTimer = setTimeout(() => { if (!opened) abandon(); }, this.opts.connectTimeout ?? 5000);
    ws.onclose = lost;
    ws.onerror = () => { if (!opened) abandon(); /* else onclose follows */ };
  }

  scheduleRetry() {
    if (this.stopped) return;
    this.setState('connecting');
    const delay = backoffDelay(this.attempt, this.opts.backoff);
    this.attempt++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}
