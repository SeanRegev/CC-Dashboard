// @ts-check
'use strict';
/**
 * HTTP + WebSocket server on 127.0.0.1. Every request must carry the token.
 *   WS   /rpc?token=...            JSON-RPC (packages/shared/protocol.js)
 *   GET  /health                   -> { ok: true, version }
 *   POST /hook?agent=<id>          hook payload from hook.js, header x-cc-event
 */
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');
const { ERRORS, METHODS } = require('../../shared/protocol');
const { RpcError } = require('./core');

const MAX_HOOK_BODY = 32 * 1024 * 1024; // PostToolUse can carry a whole file
const MAX_WS_MESSAGE = 8 * 1024 * 1024;

/** @param {string} a @param {string} b */
function tokenOk(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * RPC method name -> Core method name, or a function (core, params) => result.
 * null: handled per client below (subscriptions).
 * @type {Record<string, string|null|((core: any, params: any) => any)>}
 */
const HANDLERS = {
  hello: 'hello',
  'spaces.list': 'spacesList',
  'spaces.add': 'spacesAdd',
  'spaces.remove': 'spacesRemove',
  'agents.list': 'agentsList',
  'agents.create': 'agentsCreate',
  'agents.stop': 'agentsStop',
  'agents.resume': 'agentsResume',
  'agents.remove': 'agentsRemove',
  'agents.input': 'agentsInput',
  'agents.send': 'agentsSend',
  'agents.resize': 'agentsResize',
  'agents.attach': 'agentsAttach',
  'agents.detach': null, // handled per client
  'agents.approve': 'agentsApprove',
  'agents.deny': 'agentsDeny',
  'agents.update': 'agentsUpdate',
  'agents.restart': 'agentsRestart',
  'core.shutdown': 'coreShutdown',
  'library.list': (core, p) => core.library.list(p),
  'library.available': (core, p) => core.library.available(p),
  'library.pluginAction': (core, p) => core.library.pluginAction(p),
  'library.configure': (core, p) => core.library.configure(p),
  'library.marketplace': (core, p) => core.library.marketplace(p),
  'library.skillRead': (core, p) => core.library.skillRead(p),
  'library.skillWrite': (core, p) => core.library.skillWrite(p),
  'dashboards.list': (core, p) => core.dashboards.list(p),
  'dashboards.add': (core, p) => core.dashboards.add(p),
  'dashboards.remove': (core, p) => core.dashboards.remove(p),
  'dashboards.trust': (core, p) => core.dashboards.trust(p),
  'dashboards.start': (core, p) => core.dashboards.start(p),
  'dashboards.stop': (core, p) => core.dashboards.stop(p),
  'dashboards.attach': null, // handled per client
  'dashboards.detach': null, // handled per client
  'dashboards.input': (core, p) => core.dashboards.input(p),
  'dashboards.resize': (core, p) => core.dashboards.resize(p),
  // v3: an outside session's id starts with "ext:" (ExternalSession.id)
  'subagents.list': (core, p) => (isExternalId(p.agentId) ? core.external.subagentsList(p) : core.activity.subagentsList(needAgent(core, p))),
  'activity.list': (core, p) => (isExternalId(p.agentId) ? core.external.activityList(p) : core.activity.list(needAgent(core, p))),
  'external.list': (core, p) => core.external.list(p),
  'external.takeOver': (core, p) => core.external.takeOver(p),
};

/** @param {any} id */
function isExternalId(id) { return typeof id === 'string' && id.startsWith('ext:'); }

/** Unknown agent ids answer not_found, like every agents.* method. @param {any} core @param {any} p */
function needAgent(core, p) {
  core.getAgent(p.agentId);
  return p;
}
for (const m of METHODS) if (!(m in HANDLERS)) throw new Error(`server is missing protocol method ${m}`);

/**
 * @param {import('./core').Core} core
 * @param {{token: string, log?: (msg: string) => void}} opts
 */
function createServer(core, opts) {
  const token = opts.token;
  const log = opts.log || (() => {});
  /** @type {Set<{ws: import('ws').WebSocket, attached: Set<string>}>} */
  const clients = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const given = url.searchParams.get('token') || String(req.headers['x-cc-token'] || '');
    const reply = (code, body) => {
      const text = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    if (!tokenOk(given, token)) {
      req.resume();
      return reply(401, { ok: false, error: ERRORS.UNAUTHORIZED });
    }
    if (req.method === 'GET' && url.pathname === '/health') return reply(200, { ok: true, version: core.version });
    if (req.method === 'POST' && url.pathname === '/hook') {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_HOOK_BODY) tooBig = true;
        else chunks.push(c);
      });
      req.on('end', () => {
        const agentId = url.searchParams.get('agent') || '';
        const event = String(req.headers['x-cc-event'] || '');
        let payload = {};
        if (!tooBig) {
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { payload = {}; }
        }
        let found = false;
        try { found = core.handleHook(agentId, event, payload); } catch (e) { log(`hook ${event} failed: ${/** @type {Error} */ (e).stack}`); }
        reply(found ? 200 : 404, { ok: found });
      });
      req.on('error', () => { /* client went away */ });
      return undefined;
    }
    req.resume();
    return reply(404, { ok: false, error: ERRORS.NOT_FOUND });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const given = url.searchParams.get('token') || String(req.headers['x-cc-token'] || '');
    if (url.pathname !== '/rpc' || !tokenOk(given, token)) {
      socket.write(`HTTP/1.1 ${url.pathname !== '/rpc' ? '404 Not Found' : '401 Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onClient(ws));
  });

  /** @param {import('ws').WebSocket} ws */
  function onClient(ws) {
    const client = { ws, attached: new Set() };
    clients.add(client);
    ws.on('close', () => clients.delete(client));
    ws.on('error', () => clients.delete(client));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch {
        return send(ws, { id: null, error: { code: ERRORS.BAD_REQUEST, message: 'invalid JSON' } });
      }
      const id = msg && msg.id !== undefined ? msg.id : null;
      const method = msg && msg.method;
      if (typeof method !== 'string' || !(method in HANDLERS)) {
        return send(ws, { id, error: { code: ERRORS.BAD_REQUEST, message: `unknown method ${method}` } });
      }
      try {
        const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
        let result;
        if (method === 'agents.detach') {
          core.getAgent(params.id);
          client.attached.delete(params.id);
          result = true;
        } else if (method === 'dashboards.attach') {
          result = core.dashboards.attach(params);
          client.attached.add(`dash:${params.id}`); // same tick as the replay, like agents.attach
        } else if (method === 'dashboards.detach') {
          client.attached.delete(`dash:${params.id}`);
          result = true;
        } else {
          const h = HANDLERS[method];
          result = typeof h === 'function' ? h(core, params) : core[/** @type {string} */ (h)](params);
          // Subscribe in the same tick as taking the replay, so no output is lost or doubled.
          if (method === 'agents.attach') client.attached.add(params.id);
        }
        // Async handlers (library, dashboards) answer when they are done.
        if (result && typeof result.then === 'function') {
          return result.then((r) => send(ws, { id, result: r }), (e) => sendError(id, e));
        }
        return send(ws, { id, result });
      } catch (e) {
        return sendError(id, e);
      }

      /** @param {any} reqId @param {any} e */
      function sendError(reqId, e) {
        const err = /** @type {any} */ (e);
        if (!(err instanceof RpcError)) log(`${method} failed: ${err && err.stack}`);
        return send(ws, { id: reqId, error: { code: err instanceof RpcError ? err.code : ERRORS.INTERNAL, message: String(err && err.message || err) } });
      }
    });
  }

  function send(ws, obj) {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch { /* closing */ }
  }

  core.on('broadcast', (event, data) => {
    if (event === 'agent.removed') for (const c of clients) c.attached.delete(data.id);
    const text = JSON.stringify({ event, data });
    for (const c of clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(text);
  });
  core.on('dashboard-output', (id, data) => {
    let text = '';
    for (const c of clients) {
      if (!c.attached.has(`dash:${id}`) || c.ws.readyState !== c.ws.OPEN) continue;
      text = text || JSON.stringify({ event: 'dashboard.output', data: { id, data } });
      c.ws.send(text);
    }
  });
  core.on('output', (id, data) => {
    let text = '';
    for (const c of clients) {
      if (!c.attached.has(id) || c.ws.readyState !== c.ws.OPEN) continue;
      text = text || JSON.stringify({ event: 'agent.output', data: { id, data } });
      c.ws.send(text);
    }
  });

  /** @returns {Promise<number>} the port */
  function listen(port = 0) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
  }

  function close() {
    for (const c of clients) try { c.ws.terminate(); } catch { /* ignore */ }
    wss.close();
    return new Promise((resolve) => server.close(() => resolve(undefined)));
  }

  return { server, listen, close, clients };
}

module.exports = { createServer, tokenOk, HANDLERS };
