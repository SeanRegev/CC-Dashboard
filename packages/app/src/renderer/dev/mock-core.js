#!/usr/bin/env node
// @ts-check
/**
 * A tiny stand-in for cc-core, for developing and screenshotting the app without real Claude.
 * Implements enough of packages/shared/protocol.js: hello, spaces.*, agents.* (attach/replay,
 * input echo, resize, stop/resume/remove, create), status changes and notify events.
 *
 *   CC_HOME=<dir> node packages/app/src/renderer/dev/mock-core.js
 *
 * Writes <CC_HOME>/core.json like the real core. Env:
 *   MOCK_STATIC=1   no timed status changes (deterministic screenshots/tests)
 *   MOCK_PORT=<n>   listen on a fixed port (default: any free port)
 *   MOCK_EMPTY=1    start with no spaces and no agents
 *   MOCK_MANY=<n>   add a space "big-project" with n agents (in-process: `startMockCore({ many: n })`)
 *
 * Also usable in-process: `const mock = await startMockCore({ static: true })`.
 * Dev-only extra endpoint (not part of the protocol): GET /mock/log?token=… → { inputs, calls, presses }.
 * agents.approve / agents.deny honour promptId and choice like the real core (stale id → prompt_changed);
 * the key each answer pressed is recorded in `presses` ({ id, key }). Tests can change a prompt without
 * telling the app by assigning mock.state.agents.get(id).status.prompt.
 */
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { PROTOCOL_VERSION, ERRORS, ROLES, homeDir } = require('../../../../shared/protocol.js');
const { libraryMethods } = require('./mock-library.js');
const { dashboardMethods } = require('./mock-dashboards.js');
const { activityMethods } = require('./mock-activity.js');
const { usageMethods } = require('./mock-usage.js');

const roleOf = (/** @type {string} */ id) => ({ ...(ROLES.find((r) => r.id === id) || ROLES[1]) });
/** Seeded roles: the oldest agent of each space is Main. */
const SEED_ROLES = /** @type {Record<string, string>} */ ({
  'refactor-auth': 'main', 'fix-flaky-tests': 'tests', 'docs-pass': 'docs', 'api-client': 'worker', 'old-spike': 'research',
  'landing-copy': 'main', 'perf-audit': 'reviewer', 'etl-retry': 'main',
});

const VERSION = 'mock-0.1.0';

// ---- fake terminal content ----
const ESC = '\x1b[';
const c = {
  reset: `${ESC}0m`, dim: `${ESC}2m`, bold: `${ESC}1m`,
  coral: `${ESC}38;2;232;128;95m`, green: `${ESC}38;2;134;207;134m`, amber: `${ESC}38;2;240;180;76m`,
  lav: `${ESC}38;2;183;172;242m`, muted: `${ESC}38;2;150;142;135m`, red: `${ESC}38;2;235;110;100m`,
  blue: `${ESC}38;2;125;167;240m`,
};
const NL = '\r\n';
const PROMPT = `${c.muted}>${c.reset} `;

/** @param {string} s */
const visibleLength = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

/** @param {string} name @param {string} cwd */
function banner(name, cwd) {
  const w = 52;
  const line = (/** @type {string} */ s) => `${c.coral}│${c.reset} ${s}${' '.repeat(Math.max(0, w - 3 - visibleLength(s)))}${c.coral}│${c.reset}`;
  const shortCwd = cwd.length > 44 ? '…' + cwd.slice(-43) : cwd;
  return [
    `${c.coral}╭${'─'.repeat(w - 2)}╮${c.reset}`,
    line(`${c.bold}mock claude${c.reset} ${c.muted}(dev session)${c.reset}`),
    line(`${c.muted}agent ${name}${c.reset}`),
    line(`${c.muted}${shortCwd}${c.reset}`),
    `${c.coral}╰${'─'.repeat(w - 2)}╯${c.reset}`,
    '',
  ].join(NL);
}

/** @param {string} title @param {string[]} body */
function toolBlock(title, body) {
  return [`${c.green}●${c.reset} ${c.bold}${title}${c.reset}`, ...body.map((b, i) => `  ${c.muted}${i === 0 ? '⎿' : ' '}${c.reset}  ${b}`), ''].join(NL);
}

/** @type {Record<string, (a:any) => string>} */
const SCRIPTS = {
  'refactor-auth': (a) => [
    banner(a.name, a.cwd),
    `${PROMPT}${c.bold}Refactor the auth middleware to use the new token service${c.reset}`, '',
    `${c.lav}●${c.reset} I'll start by reading the current middleware and its tests.`, '',
    toolBlock('Read(src/middleware/auth.js)', ['Read 142 lines']),
    toolBlock('Read(src/services/token.js)', ['Read 88 lines']),
    toolBlock('Edit(src/middleware/auth.js)', [`Updated with ${c.green}24 additions${c.reset} and ${c.red}31 removals${c.reset}`]),
    `${c.lav}●${c.reset} The middleware now delegates verification to ${c.bold}TokenService${c.reset}.`,
    `  I need a new dependency for JWT parsing.`, '',
    `${c.amber}╭──────────────────────────────────────────────────╮${c.reset}`,
    `${c.amber}│${c.reset} ${c.bold}Bash command${c.reset}                                     ${c.amber}│${c.reset}`,
    `${c.amber}│${c.reset}   npm install jsonwebtoken@9                     ${c.amber}│${c.reset}`,
    `${c.amber}│${c.reset}                                                  ${c.amber}│${c.reset}`,
    `${c.amber}│${c.reset} Do you want to proceed?                          ${c.amber}│${c.reset}`,
    `${c.amber}│${c.reset} ${c.bold}❯ 1. Yes${c.reset}                                         ${c.amber}│${c.reset}`,
    `${c.amber}│${c.reset}   2. Yes, and don't ask again for npm install    ${c.amber}│${c.reset}`,
    `${c.amber}│${c.reset}   3. No, and tell Claude what to do differently  ${c.amber}│${c.reset}`,
    `${c.amber}╰──────────────────────────────────────────────────╯${c.reset}`, '',
  ].join(NL),
  'fix-flaky-tests': (a) => [
    banner(a.name, a.cwd),
    `${PROMPT}${c.bold}The checkout tests fail about 1 in 5 runs. Find out why and fix it.${c.reset}`, '',
    toolBlock('Bash(npm test -- --grep checkout)', [`${c.green}✓${c.reset} 18 passing (2.4s)`, `${c.red}✗${c.reset} 1 failing: applies coupon after cart update`]),
    toolBlock('Read(tests/checkout.test.js)', ['Read 210 lines']),
    `${c.lav}●${c.reset} The test awaits ${c.bold}updateCart()${c.reset} but not the debounced recalculation,`,
    `  so the coupon assertion races the 50 ms timer. Using fake timers instead.`, '',
    toolBlock('Edit(tests/checkout.test.js)', [`Updated with ${c.green}6 additions${c.reset} and ${c.red}2 removals${c.reset}`]),
    toolBlock('Bash(npm test -- --repeat 20)', [`${c.muted}running 20 iterations…${c.reset}`]),
    `${c.coral}✻${c.reset} ${c.muted}Running tests… (esc to interrupt)${c.reset}`, '',
  ].join(NL),
  'docs-pass': (a) => [
    banner(a.name, a.cwd),
    `${PROMPT}${c.bold}Update the README for the new CLI flags${c.reset}`, '',
    toolBlock('Read(README.md)', ['Read 96 lines']),
    toolBlock('Edit(README.md)', [`Updated with ${c.green}18 additions${c.reset} and ${c.red}5 removals${c.reset}`]),
    `${c.lav}●${c.reset} README now documents ${c.bold}--watch${c.reset}, ${c.bold}--json${c.reset} and ${c.bold}--profile${c.reset}, with examples.`, '',
    PROMPT,
  ].join(NL),
};

/** @param {any} a @param {any} s */
function genericReplay(a, s) {
  const lines = [banner(a.name, a.cwd)];
  if (a.prompt) lines.push(`${PROMPT}${c.bold}${a.prompt}${c.reset}`, '');
  if (s.state === 'working') lines.push(toolBlock(`${s.tool || 'Read'}(${s.detail || 'src/index.js'})`, ['…']), `${c.coral}✻${c.reset} ${c.muted}Working… (esc to interrupt)${c.reset}`, '');
  else if (s.state === 'starting') lines.push(`${c.blue}…${c.reset} ${c.muted}starting${c.reset}`);
  else if (s.state === 'stopped') lines.push(`${c.muted}[session stopped]${c.reset}`, '');
  else if (s.state === 'needs_you') lines.push(`${c.amber}?${c.reset} ${s.message || 'Waiting for your input'}`, '', PROMPT);
  else lines.push(`${c.lav}●${c.reset} Done.`, '', PROMPT);
  return lines.join(NL);
}

// ---- state ----

/** @param {string} s */
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

/**
 * @param {{static?:boolean, empty?:boolean, now?:number, many?:number}} opts
 */
function seed(opts) {
  const now = opts.now || Date.now();
  const base = path.join(os.homedir(), 'code');
  /** @type {any[]} */
  const spaces = opts.empty ? [] : [
    { id: 'cc-dashboard', name: 'cc-dashboard', path: path.join(base, 'cc-dashboard'), createdAt: now - 86400e3 * 9 },
    { id: 'storefront', name: 'storefront', path: path.join(base, 'storefront'), createdAt: now - 86400e3 * 30 },
    { id: 'data-pipeline', name: 'data-pipeline', path: path.join(base, 'data-pipeline'), createdAt: now - 86400e3 * 3 },
  ];
  /** @type {Array<[string,string,string,any,string?,string?]>} spaceId, name, model, status, prompt, mode */
  const defs = opts.empty ? [] : [
    ['cc-dashboard', 'refactor-auth', 'claude-opus-4-1-20250805', { state: 'needs_you', tool: 'Bash', detail: 'npm install jsonwebtoken@9', message: 'Allow Bash: npm install jsonwebtoken@9', permission: true,
      prompt: { id: 'p-refactor-auth-1', tool: 'Bash', detail: 'npm install jsonwebtoken@9', question: 'Do you want to proceed?', options: [
        { key: '1', label: 'Yes', kind: 'allow' }, { key: '2', label: "Yes, and don't ask again for: npm install *", kind: 'allow_always' }, { key: '3', label: 'No', kind: 'deny' }] },
      needsSince: now - 4 * 60e3, updatedAt: now - 4 * 60e3, lastPrompt: 'Refactor the auth middleware' }, 'Refactor the auth middleware to use the new token service'],
    ['cc-dashboard', 'fix-flaky-tests', 'claude-sonnet-4-5-20250929', { state: 'working', tool: 'Bash', detail: 'npm test -- --repeat 20', updatedAt: now - 20e3, lastPrompt: 'Fix flaky checkout tests' }, 'The checkout tests fail about 1 in 5 runs. Find out why and fix it.'],
    ['cc-dashboard', 'docs-pass', 'claude-haiku-4-5-20251001', { state: 'idle', updatedAt: now - 12 * 60e3, lastPrompt: 'Update the README for the new CLI flags' }, 'Update the README for the new CLI flags', 'acceptEdits'],
    ['cc-dashboard', 'api-client', '', { state: 'starting', updatedAt: now - 5e3 }, 'Generate a typed client for the v2 API'],
    ['cc-dashboard', 'old-spike', 'claude-sonnet-4-5-20250929', { state: 'stopped', updatedAt: now - 26 * 3600e3, lastPrompt: 'Spike: websocket transport' }, 'Spike: websocket transport', 'plan'],
    ['storefront', 'landing-copy', 'claude-sonnet-4-5-20250929', { state: 'working', tool: 'Edit', detail: 'pages/index.tsx', updatedAt: now - 45e3 }, 'Tighten the landing page copy'],
    ['storefront', 'perf-audit', 'claude-opus-4-1-20250805', { state: 'idle', updatedAt: now - 3 * 3600e3, lastPrompt: 'Audit bundle size' }, 'Audit bundle size'],
    ['data-pipeline', 'etl-retry', 'claude-sonnet-4-5-20250929', { state: 'needs_you', message: 'Which retry policy: exponential or fixed?', needsSince: now - 90e3, updatedAt: now - 90e3 }, 'Add retries to the nightly ETL job'],
  ];
  if (opts.many && opts.many > 0) {
    // `many: N`: one more space, "big-project", with N agents in a mix of states (the first is Main)
    spaces.push({ id: 'big-project', name: 'big-project', path: path.join(base, 'big-project'), createdAt: now - 86400e3 });
    const mix = [{ state: 'working', tool: 'Bash', detail: 'npm test' }, { state: 'idle' }, { state: 'needs_you', message: 'Which option?', needsSince: now - 30e3 }, { state: 'starting' }, { state: 'stopped' }];
    for (let i = 1; i <= opts.many; i++) {
      const name = `agent-${String(i).padStart(2, '0')}`;
      if (i === 1) SEED_ROLES[name] = 'main';
      defs.push(['big-project', name, 'claude-sonnet-4-5-20250929', { ...mix[(i - 1) % mix.length], updatedAt: now - i * 20e3, lastPrompt: `Task ${i}` }, `Task ${i}`]);
    }
  }
  // v4: live agents report through the status line (exact window and %, cost); stopped ones keep the
  // transcript estimate. Opus and Sonnet sessions here have the 1M window, Haiku 200k.
  const usageFor = (/** @type {string} */ name, /** @type {string} */ model, /** @type {string} */ state) => {
    const h = [...name].reduce((x, ch) => (x * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const pct = 8 + (h % 80);
    const contextWindow = /haiku/.test(model) ? 200_000 : 1_000_000;
    const live = state !== 'stopped' && state !== 'exited';
    return {
      total: 4000 + (h % 180000), context: Math.round(contextWindow * pct / 100), contextPct: pct, model: model || 'claude-sonnet-4-5-20250929',
      contextWindow, source: live ? 'statusline' : 'transcript', ...(live ? { costUsd: Math.round((h % 900) + 20) / 100 } : {}),
    };
  };
  /** @type {Map<string, {agent:any, status:any, running:boolean, screen:string, line:string}>} */
  const agents = new Map();
  defs.forEach(([spaceId, name, model, st, prompt, mode], i) => {
    const space = spaces.find((s) => s.id === spaceId);
    const agent = { id: name, spaceId, name, cwd: space.path, sessionId: crypto.randomUUID(), model, effort: '', mode: mode || '', prompt: prompt || '', role: roleOf(SEED_ROLES[name] || 'worker'), createdAt: now - (defs.length - i) * 3600e3 };
    const status = {
      agentId: name, counts: { tools: 3 + i, turns: 1 + (i % 3), errors: 0, subagents: 0 }, files: [], history: [[st.updatedAt, st.state]],
      usage: usageFor(name, model, st.state), ...st,
    };
    const script = SCRIPTS[name];
    agents.set(name, { agent, status, running: !['stopped', 'exited'].includes(st.state), screen: script ? script(agent) : genericReplay(agent, status), line: '' });
  });
  return { spaces, agents };
}

/**
 * Start the mock core.
 * @param {{static?:boolean, empty?:boolean, many?:number, port?:number, home?:string, writeCoreJson?:boolean, tickMs?:number, usage?:'normal'|'high'|'none'}} [opts]
 *   usage (v4): which account limits to seed (mock-usage.js)
 */
async function startMockCore(opts = {}) {
  const home = opts.home || homeDir();
  const token = crypto.randomBytes(16).toString('hex');
  const state = seed(opts);
  /** @type {string[]} */
  const inputs = [];
  /** @type {Array<{method:string, params:any}>} */
  const calls = [];
  /** @type {Array<{id:string, key:string}>} keys pressed by agents.approve / agents.deny */
  const presses = [];
  /** @type {Set<import('ws').WebSocket>} */
  const sockets = new Set();
  /** @type {Map<import('ws').WebSocket, Set<string>>} */
  const attachments = new Map();

  const authed = (/** @type {http.IncomingMessage} */ req) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    return u.searchParams.get('token') === token || req.headers['x-cc-token'] === token;
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (!authed(req)) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: ERRORS.UNAUTHORIZED })); return; }
    if (req.method === 'GET' && u.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, version: VERSION })); return; }
    if (req.method === 'GET' && u.pathname === '/mock/log') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ inputs, calls, presses })); return; }
    res.writeHead(404); res.end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname !== '/rpc' || !authed(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  /** @param {string} event @param {any} data */
  function broadcast(event, data) {
    const msg = JSON.stringify({ event, data });
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(msg);
  }
  /** @param {string} id @param {string} data */
  function output(id, data) {
    const e = state.agents.get(id);
    if (!e) return;
    e.screen += data;
    if (e.screen.length > 200000) e.screen = e.screen.slice(-150000);
    const msg = JSON.stringify({ event: 'agent.output', data: { id, data } });
    for (const [ws, set] of attachments) if (set.has(id) && ws.readyState === ws.OPEN) ws.send(msg);
  }
  /** @param {string} id @param {any} patch */
  function setStatus(id, patch) {
    const e = state.agents.get(id);
    if (!e) return;
    const now = Date.now();
    const prev = e.status.state;
    const next = { ...e.status, ...patch, updatedAt: now };
    if (patch.state && patch.state !== prev) {
      next.history = [...e.status.history, [now, patch.state]].slice(-400);
      if (patch.state === 'needs_you') next.needsSince = now;
      else { delete next.needsSince; delete next.message; delete next.prompt; next.permission = false; }
    }
    e.status = next;
    broadcast('agent.status', next);
    if (patch.state === 'needs_you' && prev !== 'needs_you') {
      broadcast('notify', { title: `${e.agent.name} needs you`, body: next.message || 'Waiting for your input', agentId: id });
    }
  }
  const entry = (/** @type {any} */ e) => ({ agent: e.agent, status: e.status, running: e.running });
  /** @param {string} code @param {string} message */
  const fail = (code, message) => Object.assign(new Error(message), { code });
  /** @param {any} params */
  const need = (params) => {
    const e = state.agents.get(params && params.id);
    if (!e) throw fail(ERRORS.NOT_FOUND, `no agent ${params && params.id}`);
    return e;
  };

  /** @type {Record<string, (p:any, ws:import('ws').WebSocket) => any>} */
  const methods = {
    hello: () => ({ version: VERSION, protocol: PROTOCOL_VERSION }),
    'spaces.list': () => state.spaces,
    'spaces.add': (p) => {
      if (!p || !p.path) throw fail(ERRORS.BAD_REQUEST, 'path required');
      const name = p.name || path.basename(p.path) || p.path;
      let id = slug(name);
      for (let i = 2; state.spaces.some((s) => s.id === id); i++) id = `${slug(name)}-${i}`;
      const space = { id, name, path: p.path, createdAt: Date.now() };
      state.spaces.push(space);
      broadcast('space.changed', { spaces: state.spaces });
      return space;
    },
    'spaces.remove': (p) => {
      state.spaces = state.spaces.filter((s) => s.id !== p.id);
      broadcast('space.changed', { spaces: state.spaces });
      return true;
    },
    'agents.list': () => [...state.agents.values()].map(entry),
    'agents.create': (p) => {
      const space = state.spaces.find((s) => s.id === (p && p.spaceId));
      if (!space) throw fail(ERRORS.NOT_FOUND, 'no such space');
      if (!p.name) throw fail(ERRORS.BAD_REQUEST, 'name required');
      let id = slug(p.name);
      for (let i = 2; state.agents.has(id); i++) id = `${slug(p.name)}-${i}`;
      const now = Date.now();
      const hasMain = [...state.agents.values()].some((x) => x.agent.spaceId === space.id && x.agent.role.id === 'main');
      const role = p.role && p.role.id ? { ...roleOf(p.role.id), ...(p.role.id === 'custom' ? { id: 'custom', label: p.role.label || 'Custom', emoji: p.role.emoji || '' } : {}) } : roleOf(hasMain ? 'worker' : 'main');
      if (role.id === 'main') demoteMain(space.id);
      const agent = { id, spaceId: space.id, name: p.name, cwd: space.path, sessionId: crypto.randomUUID(), model: p.model || '', effort: p.effort || '', mode: p.mode || '', prompt: p.prompt || '', role, createdAt: now };
      const status = { agentId: id, state: 'starting', counts: { tools: 0, turns: 0, errors: 0, subagents: 0 }, files: [], history: [[now, 'starting']], usage: { total: 0, context: 0, contextPct: 0, model: p.model || '' }, updatedAt: now };
      const e = { agent, status, running: true, screen: banner(agent.name, agent.cwd) + NL, line: '' };
      state.agents.set(id, e);
      broadcast('agent.created', entry(e));
      setTimeout(() => {
        if (!state.agents.has(id)) return;
        if (agent.prompt) {
          output(id, `${PROMPT}${c.bold}${agent.prompt}${c.reset}${NL}${NL}`);
          setStatus(id, { state: 'working', tool: 'Read', detail: 'package.json', lastPrompt: agent.prompt, usage: { ...status.usage, total: 2400, context: 9000, contextPct: 4.5 } });
          setTimeout(() => {
            if (!state.agents.has(id)) return;
            output(id, toolBlock('Read(package.json)', ['Read 40 lines']) + `${c.lav}●${c.reset} Looked around. What next?${NL}${NL}${PROMPT}`);
            setStatus(id, { state: 'idle', tool: '', detail: '' });
          }, 2500);
        } else {
          output(id, PROMPT);
          setStatus(id, { state: 'idle' });
        }
      }, 700);
      return agent;
    },
    'agents.stop': (p) => {
      const e = need(p);
      e.running = false;
      output(e.agent.id, `${NL}${c.muted}[session stopped]${c.reset}${NL}`);
      setStatus(e.agent.id, { state: 'stopped', tool: '', detail: '' });
      broadcast('agent.exit', { id: e.agent.id, code: 0 });
      return true;
    },
    'agents.resume': (p) => {
      const e = need(p);
      e.running = true;
      output(e.agent.id, `${c.muted}[resumed ${e.agent.sessionId.slice(0, 8)}]${c.reset}${NL}${PROMPT}`);
      setStatus(e.agent.id, { state: 'idle' });
      return true;
    },
    'agents.remove': (p) => {
      const e = need(p);
      state.agents.delete(e.agent.id);
      for (const set of attachments.values()) set.delete(e.agent.id);
      broadcast('agent.removed', { id: e.agent.id });
      return true;
    },
    'agents.input': (p) => {
      const e = need(p);
      if (!e.running) throw fail(ERRORS.NOT_RUNNING, 'agent is not running');
      const data = String(p.data || '');
      inputs.push(data);
      typeInto(e, data);
      return true;
    },
    'agents.send': (p) => {
      const e = need(p);
      if (!e.running) throw fail(ERRORS.NOT_RUNNING, 'agent is not running');
      inputs.push(String(p.text) + '\r');
      typeInto(e, String(p.text) + '\r');
      return true;
    },
    'agents.resize': (p) => { need(p); return true; },
    'agents.attach': (p, ws) => {
      const e = need(p);
      let set = attachments.get(ws);
      if (!set) attachments.set(ws, (set = new Set()));
      set.add(e.agent.id);
      return { replay: e.screen };
    },
    'agents.detach': (p, ws) => {
      const set = attachments.get(ws);
      if (set) set.delete(p && p.id);
      return true;
    },
    'agents.approve': (p) => {
      const e = need(p);
      const choice = p.choice === undefined || p.choice === null ? 'allow' : p.choice;
      if (choice !== 'allow' && choice !== 'allow_always') throw fail(ERRORS.BAD_REQUEST, 'choice must be allow or allow_always');
      const pr = checkPrompt(e, p);
      let key = '1';
      if (pr) {
        const opts = pr.options.filter((/** @type {any} */ o) => o.kind === choice);
        if (opts.length !== 1) throw fail(ERRORS.BAD_REQUEST, `this prompt has no ${choice} option`);
        key = opts[0].key;
      } else if (choice !== 'allow') {
        throw fail(ERRORS.BAD_REQUEST, `choice ${choice} needs promptId`);
      }
      presses.push({ id: e.agent.id, key });
      output(e.agent.id, `${NL}${c.green}✓${c.reset} approved (${key})${NL}`);
      setStatus(e.agent.id, { state: 'working', permission: false });
      return true;
    },
    'agents.deny': (p) => {
      const e = need(p);
      checkPrompt(e, p);
      presses.push({ id: e.agent.id, key: '\x1b' });
      output(e.agent.id, `${NL}${c.red}✗${c.reset} denied${NL}${PROMPT}`);
      setStatus(e.agent.id, { state: 'idle', permission: false });
      return true;
    },
    'agents.update': (p) => {
      const e = need(p);
      if (p.name !== undefined) e.agent.name = String(p.name).trim() || e.agent.name;
      if (p.role && p.role.id) {
        if (p.role.id === 'main' && e.agent.role.id !== 'main') demoteMain(e.agent.spaceId);
        e.agent.role = p.role.id === 'custom' ? { id: 'custom', label: p.role.label || 'Custom', emoji: p.role.emoji || '' } : { ...roleOf(p.role.id), ...(p.role.label ? { label: p.role.label } : {}), ...(p.role.emoji !== undefined ? { emoji: p.role.emoji } : {}) };
      }
      broadcast('agent.updated', { agent: e.agent });
      return e.agent;
    },
    'agents.restart': (p) => {
      const e = need(p);
      e.running = true;
      output(e.agent.id, `${NL}${c.muted}[restarted ${e.agent.sessionId.slice(0, 8)}]${c.reset}${NL}${PROMPT}`);
      setStatus(e.agent.id, { state: 'idle' });
      return true;
    },
    'core.shutdown': () => {
      for (const e of state.agents.values()) if (e.running) { e.running = false; setStatus(e.agent.id, { state: 'stopped' }); }
      return true;
    },
    ...libraryMethods({ broadcast, fail, ERRORS, home }),
    ...dashboardMethods({ broadcast, fail, ERRORS, home, attachments, emitOutput: dashboardOutput }),
  };
  // v3: subagents, activity log, outside sessions (mock-activity.js)
  const activity = activityMethods({
    broadcast, fail, ERRORS, state, setStatus, base: path.join(os.homedir(), 'code'), static: !!opts.static,
    addSpace: (p, name) => methods['spaces.add']({ path: p, name }),
    createAgent: (spec) => {
      let id = slug(spec.name);
      for (let i = 2; state.agents.has(id); i++) id = `${slug(spec.name)}-${i}`;
      const now = Date.now();
      const hasMain = [...state.agents.values()].some((x) => x.agent.spaceId === spec.spaceId && x.agent.role.id === 'main');
      const agent = { id, spaceId: spec.spaceId, name: spec.name, cwd: spec.cwd, sessionId: spec.sessionId, model: '', effort: '', mode: '', prompt: spec.prompt || '', role: roleOf(hasMain ? 'worker' : 'main'), createdAt: now };
      const status = { agentId: id, state: 'idle', lastPrompt: spec.prompt || '', counts: { tools: 0, turns: 1, errors: 0, subagents: 0 }, files: [], history: [[now, 'idle']], usage: { total: 0, context: 0, contextPct: 0, model: '' }, updatedAt: now };
      const e = { agent, status, running: true, screen: banner(agent.name, agent.cwd) + `${c.muted}[resumed ${spec.sessionId.slice(0, 8)}, taken over]${c.reset}${NL}${PROMPT}`, line: '' };
      state.agents.set(id, e);
      broadcast('agent.created', entry(e));
      return agent;
    },
  });
  Object.assign(methods, activity.methods);
  // v4: account limits and cost totals (mock-usage.js)
  const usage = usageMethods({ broadcast, state, usage: opts.usage });
  Object.assign(methods, usage.methods);

  /**
   * Like the real core: a permission prompt must be waiting, and with promptId it must be the one
   * "on screen" (status.prompt). Returns that prompt, or null for a v1 call.
   * @param {any} e @param {any} p
   */
  function checkPrompt(e, p) {
    if (!e.running) throw fail(ERRORS.NOT_RUNNING, 'agent is not running');
    if (e.status.state !== 'needs_you' || !e.status.permission) throw fail(ERRORS.NO_PERMISSION_PENDING, 'no permission prompt');
    if (p.promptId === undefined || p.promptId === null) return null;
    if (typeof p.promptId !== 'string' || !p.promptId) throw fail(ERRORS.BAD_REQUEST, 'promptId must be a non-empty string');
    const pr = e.status.prompt;
    if (!pr || pr.id !== p.promptId) throw fail(ERRORS.PROMPT_CHANGED, 'the prompt on screen is not the one you answered');
    return pr;
  }

  /** Make the current Main of a space a Worker (one Main per space). @param {string} spaceId */
  function demoteMain(spaceId) {
    for (const x of state.agents.values()) {
      if (x.agent.spaceId === spaceId && x.agent.role.id === 'main') {
        x.agent.role = roleOf('worker');
        broadcast('agent.updated', { agent: x.agent });
      }
    }
  }

  /** dashboard.output to clients attached to a dashboard. @param {string} id @param {string} data */
  function dashboardOutput(id, data) {
    const msg = JSON.stringify({ event: 'dashboard.output', data: { id, data } });
    for (const [ws, set] of attachments) if (set.has(`dash:${id}`) && ws.readyState === ws.OPEN) ws.send(msg);
  }

  /** Echo typed keys like a line editor; Enter answers "GOT: <line>". @param {any} e @param {string} data */
  function typeInto(e, data) {
    const id = e.agent.id;
    let out = '';
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const line = e.line;
        e.line = '';
        out += `${NL}${c.lav}●${c.reset} GOT: ${line}${NL}${NL}${PROMPT}`;
        if (line.trim()) setTimeout(() => setStatus(id, { state: 'working', tool: '', detail: '', lastPrompt: line }), 0);
        if (line.trim()) setTimeout(() => state.agents.has(id) && setStatus(id, { state: 'idle' }), 900);
      } else if (ch === '\x7f' || ch === '\b') {
        if (e.line.length) { e.line = e.line.slice(0, -1); out += '\b \b'; }
      } else if (ch === '\x03') {
        e.line = '';
        out += `^C${NL}${PROMPT}`;
      } else if (ch >= ' ') {
        e.line += ch;
        out += ch;
      }
    }
    if (out) output(id, out);
  }

  wss.on('connection', (ws) => {
    sockets.add(ws);
    attachments.set(ws, new Set());
    ws.on('close', () => { sockets.delete(ws); attachments.delete(ws); });
    ws.on('message', async (raw) => {
      /** @type {any} */
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg.id !== 'number') return;
      calls.push({ method: msg.method, params: msg.params });
      const fn = methods[msg.method];
      try {
        if (!fn) throw fail(ERRORS.BAD_REQUEST, `unknown method ${msg.method}`);
        const result = await fn(msg.params || {}, ws);
        ws.send(JSON.stringify({ id: msg.id, result }));
      } catch (err) {
        const er = /** @type {any} */ (err);
        ws.send(JSON.stringify({ id: msg.id, error: { code: er.code || ERRORS.INTERNAL, message: er.message } }));
      }
    });
  });

  // Timed life: statuses change, working agents print a little.
  /** @type {any[]} */
  const timers = [];
  if (!opts.static) {
    const tools = [['Read', 'src/server.js'], ['Grep', 'TODO'], ['Edit', 'src/cart.js'], ['Bash', 'npm test'], ['Write', 'docs/notes.md']];
    let tick = 0;
    timers.push(setInterval(() => {
      tick++;
      for (const e of state.agents.values()) {
        if (e.status.state !== 'working') continue;
        const [tool, detail] = tools[(tick + e.agent.name.length) % tools.length];
        const u = e.status.usage;
        const pct = Math.min(96, (u.contextPct || 0) + 0.7);
        output(e.agent.id, toolBlock(`${tool}(${detail})`, [`${c.muted}ok${c.reset}`]));
        setStatus(e.agent.id, { tool, detail, usage: { ...u, total: u.total + 850, context: Math.round((u.contextWindow || 200_000) * pct / 100), contextPct: pct } });
      }
      // every few ticks, landing-copy asks for something, then gets going again
      const lc = state.agents.get('landing-copy');
      if (lc && tick % 4 === 0) {
        if (lc.status.state === 'working') setStatus('landing-copy', { state: 'needs_you', message: 'Pick a headline: A or B?' });
        else if (lc.status.state === 'needs_you') setStatus('landing-copy', { state: 'working', tool: 'Edit', detail: 'pages/index.tsx' });
      }
      activity.step();
      usage.step();
    }, opts.tickMs || 4000));
  }

  await new Promise((resolve) => server.listen(opts.port || 0, '127.0.0.1', () => resolve(undefined)));
  const addr = /** @type {import('net').AddressInfo} */ (server.address());
  const port = addr.port;
  const coreJson = path.join(home, 'core.json');
  if (opts.writeCoreJson !== false) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(coreJson, JSON.stringify({ port, token, pid: process.pid, version: VERSION }, null, 2), { mode: 0o600 });
  }

  return {
    port, token, home, inputs, calls, presses, state, activity, usage,
    setStatus, output, broadcast,
    /** Close every client socket (simulates a core restart for reconnect tests). */
    dropClients() { for (const ws of sockets) ws.terminate(); },
    async close() {
      for (const t of timers) clearInterval(t);
      for (const ws of sockets) ws.terminate();
      await new Promise((resolve) => { wss.close(); server.close(() => resolve(undefined)); });
      if (opts.writeCoreJson !== false) {
        try {
          const cur = JSON.parse(fs.readFileSync(coreJson, 'utf8'));
          if (cur.port === port && cur.token === token) fs.unlinkSync(coreJson);
        } catch { /* already gone */ }
      }
    },
  };
}

module.exports = { startMockCore, VERSION };

if (require.main === module) {
  startMockCore({
    static: process.env.MOCK_STATIC === '1',
    empty: process.env.MOCK_EMPTY === '1',
    many: Number(process.env.MOCK_MANY) || 0,
    port: process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : 0,
    usage: /** @type {any} */ (process.env.MOCK_USAGE || undefined),
  }).then((mock) => {
    console.log(`mock core on 127.0.0.1:${mock.port} (core.json in ${mock.home})`);
    const quit = () => mock.close().then(() => process.exit(0));
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
  });
}
