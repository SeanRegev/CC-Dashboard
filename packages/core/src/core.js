// @ts-check
'use strict';
/**
 * The core's brain: spaces, agents, their terminals and their status.
 *
 * Every change to an agent's status goes through `update()`, and this process is the only
 * writer, so hook events, user actions (approve/deny/stop) and timers are applied one at a
 * time and can never overwrite each other. (The Python deck needed a file lock for this.)
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ERRORS, PROTOCOL_VERSION, ROLES } = require('../../shared/protocol');
const { newStatus, newRuntime, applyEvent, withState, restingStatus } = require('./status');
const { UsageReader } = require('./usage');
const { StateStore } = require('./store');
const { ensureSettings } = require('./hooks-settings');
const { AgentTerminal, Scrollback } = require('./terminal');
const { baseCommand, claudeArgs, spawnSpec } = require('./command');
const { Library } = require('./library');
const { Activity } = require('./activity');
const { External } = require('./external');
const { Dashboards } = require('./dashboards');
const { parsePrompt } = require('./prompt');

/**
 * @typedef {import('./types').AgentStatus} AgentStatus
 * @typedef {import('./types').Runtime} Runtime
 * @typedef {{id:string, name:string, path:string, createdAt:number}} Space
 * @typedef {{id:string, spaceId:string, name:string, cwd:string, sessionId:string, model?:string, effort?:string,
 *            mode?:string, prompt?:string, worktree?:string, branch?:string, taskId?:string, role:Role, createdAt:number}} Agent
 * @typedef {{id:string, label:string, emoji:string}} Role
 */

/**
 * A role as the core stores it. Built-in ids get their label and emoji filled in (a custom label
 * or emoji the user typed wins); 'custom' needs a label. Returns null for anything else.
 * @param {any} role @returns {Role|null}
 */
function normalizeRole(role) {
  if (!role || typeof role !== 'object' || typeof role.id !== 'string') return null;
  const clean = (/** @type {any} */ v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '');
  const builtin = ROLES.find((r) => r.id === role.id);
  if (builtin) return { id: builtin.id, label: clean(role.label, 24) || builtin.label, emoji: role.emoji === undefined ? builtin.emoji : clean(role.emoji, 8) };
  if (role.id !== 'custom') return null;
  const label = clean(role.label, 24);
  return label ? { id: 'custom', label, emoji: clean(role.emoji, 8) } : null;
}
const roleOf = (/** @type {string} */ id) => /** @type {Role} */ (normalizeRole({ id }));

/** Set by a running Claude Code session for the processes it starts; never meant for our agents. */
const PARENT_SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_SSE_PORT'];
const STUCK_MESSAGE = 'Claude is showing a screen that needs you. Open it to check.';
const PROMPT_MARKERS = ['Esc to cancel', 'Do you want'];
/** After terminal output, read the prompt this much later (output comes in bursts). */
const PROMPT_READ_MS = 40;
const APPROVE_CHOICES = ['allow', 'allow_always'];

const { RpcError } = require('./errors');

/** @param {string} text */
function slug(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function envNumber(env, name, fallback) {
  const v = Number(env[name]);
  return Number.isFinite(v) && v >= 0 && env[name] !== '' && env[name] !== undefined ? v : fallback;
}

/** Where real Claude Code keeps a session's transcript. */
function defaultTranscriptPath(cwd, sessionId, env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

class Core extends EventEmitter {
  /**
   * @param {{home:string, version:string, env?:NodeJS.ProcessEnv}} opts
   *   Timings can be tuned with env (tests): CC_STUCK_MS, CC_PROMPT_GONE_MS, CC_LONG_TURN_MS, CC_TICK_MS.
   */
  constructor(opts) {
    super();
    this.home = opts.home;
    this.version = opts.version;
    this.env = opts.env || process.env;
    this.stuckMs = envNumber(this.env, 'CC_STUCK_MS', 12_000);
    this.promptGoneMs = envNumber(this.env, 'CC_PROMPT_GONE_MS', 3_000);
    this.longTurnMs = envNumber(this.env, 'CC_LONG_TURN_MS', 60_000);
    this.tickMs = envNumber(this.env, 'CC_TICK_MS', Math.max(50, Math.min(1000, Math.floor(this.stuckMs / 4))));
    this.store = new StateStore(this.home);
    this.usage = new UsageReader();
    /** @type {Map<string, Space>} */ this.spaces = new Map();
    /** @type {Map<string, Agent>} */ this.agents = new Map();
    /** @type {Map<string, AgentStatus>} */ this.status = new Map();
    /** @type {Map<string, Runtime>} */ this.rt = new Map();
    /** @type {Map<string, AgentTerminal>} */ this.terms = new Map();
    /** @type {Map<string, Scrollback>} */ this.scrollbacks = new Map();
    /** @type {Map<string, {cols:number, rows:number}>} */ this.sizes = new Map();
    /** @type {Set<string>} agents the user stopped (their late hooks are ignored) */
    this.userStopped = new Set();
    this.coreUrl = '';
    this.token = '';
    this.settingsPath = '';
    /** @type {NodeJS.Timeout|null} */ this.ticker = null;
    this.lastUsageScan = 0;
    /** @type {Set<string>} agents to resume as soon as their process has exited (agents.restart) */
    this.restartPending = new Set();
    this.library = new Library(this);
    this.dashboards = new Dashboards(this);
    this.activity = new Activity(this);
    this.external = new External(this);
    /** @type {Map<string, NodeJS.Timeout>} pending screen reads for status.prompt */
    this.promptTimers = new Map();
  }

  /** Load saved state. Agents whose process is gone (all of them, after a restart) become stopped. */
  start() {
    fs.mkdirSync(this.home, { recursive: true });
    this.settingsPath = ensureSettings(this.home);
    const data = this.store.load();
    for (const s of data.spaces) if (s && s.id) this.spaces.set(s.id, s);
    const now = Date.now();
    for (const a of data.agents) {
      if (!a || !a.id) continue;
      this.agents.set(a.id, a);
      let st = data.status[a.id] || newStatus(a.id, now);
      st = { ...newStatus(a.id, now), ...st, agentId: a.id };
      if (st.state !== 'exited' && st.state !== 'stopped') st = withState(st, 'stopped', { tool: '' }, now);
      this.status.set(a.id, st);
      this.rt.set(a.id, { ...newRuntime(), ...(data.runtime[a.id] || {}), stuck: false });
    }
    this.fixRoles();
    this.store.bind(() => this.snapshot());
    this.store.saveNow();
    this.ticker = setInterval(() => this.tick(), this.tickMs);
    this.ticker.unref();
    this.activity.start();
    this.external.start();
  }

  /** @param {string} url @param {string} token */
  setEndpoint(url, token) {
    this.coreUrl = url;
    this.token = token;
  }

  snapshot() {
    const status = {};
    const runtime = {};
    for (const [id, s] of this.status) status[id] = s;
    for (const [id, r] of this.rt) runtime[id] = { ...r, stuck: undefined };
    return { spaces: [...this.spaces.values()], agents: [...this.agents.values()], status, runtime };
  }

  // ---- events ------------------------------------------------------------------------------

  /** @param {string} event @param {any} data */
  broadcast(event, data) { this.emit('broadcast', event, data); }

  /** @param {string} title @param {string} body @param {string} agentId @param {'needs_you'|'done'|'exited'|'info'} kind */
  notify(title, body, agentId, kind) { this.broadcast('notify', { title, body, agentId, kind }); }

  /**
   * The one place an agent's status changes.
   * @param {string} id
   * @param {(s: AgentStatus, r: Runtime) => {status: AgentStatus, rt?: Runtime}|null} fn  return null for no change
   * @param {{event?: string}} [info]
   */
  update(id, fn, info = {}) {
    const before = this.status.get(id);
    const rtBefore = this.rt.get(id);
    if (!before || !rtBefore) return null;
    const out = fn(before, rtBefore);
    if (!out) return before;
    const rt = out.rt || rtBefore;
    // status.prompt always matches the screen at the moment the status changes.
    const after = this.withPrompt(id, out.status, rt);
    this.status.set(id, after);
    this.rt.set(id, rt);
    // A state change (working → idle, → needs_you, …) is on disk before anyone hears of it. On
    // Windows every stop of the core is a hard kill (no SIGTERM), so a debounced save would lose
    // the last turn. Tool details and usage still come in bursts: those are saved soon after.
    let saved = false;
    if (after.state !== before.state) {
      try { this.store.saveNow(); saved = true; } catch { /* file held open: retried below */ }
    }
    if (!saved) this.store.saveSoon();
    this.broadcast('agent.status', after);
    this.alert(id, before, after, rtBefore, info.event);
    return after;
  }

  /** Native notifications: an agent starts needing you, or a long turn ends. */
  alert(id, before, after, rtBefore, event) {
    const agent = this.agents.get(id);
    const name = agent ? agent.name : id;
    if (after.state === 'needs_you' && before.state !== 'needs_you') {
      this.notify(`${name} needs you`, after.message || 'Waiting for you', id, 'needs_you');
    } else if ((event === 'Stop' || event === 'SubagentStop') && after.state === 'idle'
      && (rtBefore.doneFrom || rtBefore.turnStartedAt)) {
      // A turn whose background subagents still ran at Stop is done when the last one ends.
      const took = after.updatedAt - (rtBefore.doneFrom || rtBefore.turnStartedAt);
      if (took >= this.longTurnMs) {
        const secs = Math.floor(took / 1000);
        const m = Math.floor(secs / 60);
        const s = String(secs % 60).padStart(2, '0');
        this.notify(`${name} is done (${m}m${s}s)`, after.lastPrompt || 'Finished its turn', id, 'done');
      }
    }
  }

  // ---- hooks -------------------------------------------------------------------------------

  /**
   * A hook event from hook.js. Applied synchronously, before the HTTP response is sent.
   * @param {string} id @param {string} event @param {any} payload
   * @returns {boolean} false if the agent is unknown
   */
  handleHook(id, event, payload) {
    if (!this.agents.has(id)) return false;
    const term = this.terms.get(id);
    const live = term && term.running;
    // Late hooks from a process that is gone must not resurrect it. A natural exit's
    // SessionEnd can race the process exit, so that one is still accepted.
    if (!live && (event !== 'SessionEnd' || this.userStopped.has(id))) return true;
    /** @type {any} */
    let ctx = {};
    try { ctx = this.activity.onHook(id, event, payload) || {}; } catch { /* the log never breaks status */ }
    this.update(id, (s, r) => {
      const out = applyEvent(s, r, event, payload, Date.now(), ctx);
      out.rt.stuck = false;
      if (event === 'Stop') out.rt.turnStartedAt = 0;
      const u = out.rt.transcriptPath ? this.usage.read(out.rt.transcriptPath) : null;
      if (u) out.status.usage = u;
      // Keep the turn start for alert(), which reads it from the "before" runtime.
      return out;
    }, { event });
    return true;
  }

  // ---- timers ------------------------------------------------------------------------------

  tick() {
    const now = Date.now();
    const scanUsage = now - this.lastUsageScan > 5000;
    if (scanUsage) this.lastUsageScan = now;
    for (const [id, term] of this.terms) {
      if (!term.running) continue;
      // Output may have stopped before the last redraw was read (no more data events to trigger it).
      const st0 = this.status.get(id);
      if (st0 && st0.state === 'needs_you') this.refreshPrompt(id);
      const s = this.status.get(id);
      const r = this.rt.get(id);
      if (!s || !r) continue;
      if (s.state === 'starting' && !r.hookSinceLaunch && now - r.launchAt > this.stuckMs) {
        // No hook since launch: Claude is probably on a screen (trust folder, login, update).
        this.update(id, (st, rt) => ({
          status: withState(st, 'needs_you', { message: STUCK_MESSAGE, needsSince: rt.launchAt || now }, now),
          rt: { ...rt, stuck: true },
        }));
      } else if (s.state === 'needs_you' && s.permission && now - (r.permAt || s.needsSince || 0) > this.promptGoneMs
        && this.promptGone(term)) {
        // Answered inside the terminal (e.g. Esc): no hook fires for that.
        const subs = this.activity.onPromptGone(id);
        this.update(id, (st, rt) => ({ status: restingStatus(st, subs, now), rt: { ...rt, answeredAt: now, turnStartedAt: 0 } }));
      } else if (scanUsage && r.transcriptPath && s.state === 'working') {
        const u = this.usage.read(r.transcriptPath);
        if (u && JSON.stringify(u) !== JSON.stringify(s.usage)) {
          this.update(id, (st) => ({ status: { ...st, usage: u, updatedAt: now } }));
        }
      }
    }
  }

  // ---- the permission prompt on screen (status.prompt) -------------------------------------

  /** Waiting on a permission prompt: a PermissionRequest, or (older Claude) a "needs your permission" Notification. @param {AgentStatus} s */
  static permissionStatus(s) {
    return Boolean(s && s.state === 'needs_you' && (s.permission || /permission/i.test(s.message || '')));
  }

  /**
   * The prompt on the agent's screen right now, or null (none, or one the parser can't read).
   * The fingerprint is salted with the agent and its last PermissionRequest, so the same prompt
   * asked again, or by another agent, gets another id.
   * @param {string} id @param {AgentStatus} s @param {Runtime} r
   */
  promptFor(id, s, r) {
    if (!Core.permissionStatus(s)) return null;
    const term = this.terms.get(id);
    if (!term || !term.running) return null;
    return parsePrompt(term.screenText(), { salt: `${id}:${(r && r.permAt) || 0}` });
  }

  /** s with prompt (and permission) set from the screen, or prompt removed. Returns s itself when nothing changes. */
  withPrompt(id, s, r) {
    const p = this.promptFor(id, s, r);
    if (!p) {
      if (!s.prompt) return s;
      const out = { ...s };
      delete out.prompt;
      return out;
    }
    if (s.prompt && s.prompt.id === p.id && s.permission) return s;
    return { ...s, prompt: p, permission: true };
  }

  /** Re-read the prompt and publish a status change if it differs. @param {string} id */
  refreshPrompt(id) {
    const s = this.status.get(id);
    const r = this.rt.get(id);
    if (!s || !r) return;
    if (this.withPrompt(id, s, r) === s) return;
    this.update(id, (st) => ({ status: { ...st, updatedAt: Date.now() } }));
  }

  /** Terminal output while the agent needs you: read the screen once the burst is parsed. @param {string} id @param {AgentTerminal} term */
  schedulePromptRead(id, term) {
    const s = this.status.get(id);
    if (!s || s.state !== 'needs_you' || this.promptTimers.has(id)) return;
    const t = setTimeout(() => {
      this.promptTimers.delete(id);
      if (this.terms.get(id) !== term || !term.running) return;
      this.flushScreen(term).then(() => { if (this.terms.get(id) === term) this.refreshPrompt(id); });
    }, PROMPT_READ_MS);
    t.unref();
    this.promptTimers.set(id, t);
  }

  /**
   * Resolves true once the headless screen has parsed every byte received so far; false if it
   * didn't within a moment (huge backlog, terminal gone).
   * @param {AgentTerminal} term @returns {Promise<boolean>}
   */
  flushScreen(term) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 1000);
      t.unref();
      try { term.screen.write('', () => { clearTimeout(t); resolve(true); }); } catch { clearTimeout(t); resolve(false); }
    });
  }

  /** @param {AgentTerminal} term */
  promptGone(term) {
    const screen = term.screenText();
    return Boolean(screen.trim()) && !PROMPT_MARKERS.some((m) => screen.includes(m));
  }

  // ---- spaces ------------------------------------------------------------------------------

  spacesList() { return [...this.spaces.values()]; }

  spacesAdd(params) {
    const p = params && params.path;
    if (typeof p !== 'string' || !p.trim()) throw new RpcError(ERRORS.BAD_REQUEST, 'path is required');
    const abs = path.resolve(p);
    let st;
    try { st = fs.statSync(abs); } catch { throw new RpcError(ERRORS.BAD_REQUEST, `folder not found: ${abs}`); }
    if (!st.isDirectory()) throw new RpcError(ERRORS.BAD_REQUEST, `not a folder: ${abs}`);
    const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    for (const s of this.spaces.values()) if (same(s.path, abs)) return s;
    const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : path.basename(abs) || abs;
    const id = this.uniqueId(slug(name) || 'space', this.spaces);
    const space = { id, name, path: abs, createdAt: Date.now() };
    this.spaces.set(id, space);
    this.store.saveNow();
    this.broadcast('space.changed', { spaces: this.spacesList() });
    return space;
  }

  spacesRemove(params) {
    const id = params && params.id;
    if (!this.spaces.has(id)) throw new RpcError(ERRORS.NOT_FOUND, `no space ${id}`);
    this.spaces.delete(id);
    this.store.saveNow();
    this.broadcast('space.changed', { spaces: this.spacesList() });
    return true;
  }

  /** @param {string} base @param {Map<string, any>} map */
  uniqueId(base, map) {
    let id = base;
    for (let n = 2; map.has(id); n++) id = `${base}-${n}`;
    return id;
  }

  // ---- agents ------------------------------------------------------------------------------

  agentsList() {
    return [...this.agents.values()].map((agent) => ({ agent, status: this.status.get(agent.id), running: this.isRunning(agent.id) }));
  }

  isRunning(id) {
    const t = this.terms.get(id);
    return Boolean(t && t.running);
  }

  /** @param {string} id */
  getAgent(id) {
    const a = typeof id === 'string' ? this.agents.get(id) : undefined;
    if (!a) throw new RpcError(ERRORS.NOT_FOUND, `no agent ${id}`);
    return a;
  }

  /** @param {string} id */
  runningTerm(id) {
    this.getAgent(id);
    const t = this.terms.get(id);
    if (!t || !t.running) throw new RpcError(ERRORS.NOT_RUNNING, `agent ${id} is not running`);
    return t;
  }

  agentsCreate(params) {
    params = params || {};
    const space = this.spaces.get(params.spaceId);
    if (!space) throw new RpcError(ERRORS.NOT_FOUND, `no space ${params.spaceId}`);
    for (const k of ['name', 'prompt', 'model', 'effort', 'mode', 'worktree']) {
      if (params[k] !== undefined && params[k] !== null && typeof params[k] !== 'string') throw new RpcError(ERRORS.BAD_REQUEST, `${k} must be a string`);
    }
    let role = null;
    if (params.role !== undefined && params.role !== null) {
      role = normalizeRole(params.role);
      if (!role) throw new RpcError(ERRORS.BAD_REQUEST, 'role must be { id } with a known id, or { id: "custom", label }');
    }
    // The first agent of a space is its Main unless another role was asked for.
    const hasMain = [...this.agents.values()].some((a) => a.spaceId === space.id && a.role && a.role.id === 'main');
    if (!role) role = roleOf(hasMain ? 'worker' : 'main');
    let cwd = space.path;
    if (params.worktree) {
      cwd = path.resolve(params.worktree);
      if (!fs.existsSync(cwd)) throw new RpcError(ERRORS.BAD_REQUEST, `worktree not found: ${cwd}`);
    }
    const name = (params.name || '').trim() || 'agent';
    /** @type {Agent} */
    const agent = {
      id: this.uniqueId(slug(name) || 'agent', this.agents),
      spaceId: space.id,
      name,
      cwd,
      sessionId: crypto.randomUUID(),
      model: params.model || '',
      effort: params.effort || '',
      mode: params.mode || '',
      prompt: params.prompt || '',
      role,
      createdAt: Date.now(),
    };
    if (params.worktree) agent.worktree = cwd;
    const demoted = role.id === 'main' ? this.demoteMain(space.id) : [];
    this.agents.set(agent.id, agent);
    this.status.set(agent.id, newStatus(agent.id));
    this.rt.set(agent.id, newRuntime());
    this.store.saveNow();
    this.broadcast('agent.created', { agent, status: this.status.get(agent.id) });
    for (const a of demoted) this.broadcast('agent.updated', { agent: a });
    this.launch(agent, { resume: false });
    return agent;
  }

  /**
   * v3 external.takeOver: a conversation started outside the app becomes an agent here, resumed
   * with `claude --resume <sessionId>` in its own cwd. The caller has already ended the outside process.
   * @param {{spaceId: string, name: string, cwd: string, sessionId: string, transcriptPath?: string}} p
   * @returns {Agent}
   */
  adoptSession(p) {
    const space = this.spaces.get(p.spaceId);
    if (!space) throw new RpcError(ERRORS.NOT_FOUND, `no space ${p.spaceId}`);
    const hasMain = [...this.agents.values()].some((a) => a.spaceId === space.id && a.role && a.role.id === 'main');
    const name = String(p.name || '').trim().slice(0, 80) || 'agent';
    /** @type {Agent} */
    const agent = {
      id: this.uniqueId(slug(name) || 'agent', this.agents),
      spaceId: space.id, name, cwd: path.resolve(p.cwd), sessionId: p.sessionId,
      model: '', effort: '', mode: '', prompt: '', role: roleOf(hasMain ? 'worker' : 'main'), createdAt: Date.now(),
    };
    this.agents.set(agent.id, agent);
    this.status.set(agent.id, newStatus(agent.id));
    // launch() resumes only when it can find the transcript: tell it where the outside session kept it.
    this.rt.set(agent.id, { ...newRuntime(), transcriptPath: p.transcriptPath || '' });
    this.store.saveNow();
    this.broadcast('agent.created', { agent, status: this.status.get(agent.id) });
    this.launch(agent, { resume: true });
    return agent;
  }

  // ---- roles ------------------------------------------------------------------------------------

  /** Make every agent of a space that is Main a Worker. @param {string} spaceId @returns {Agent[]} the changed agents */
  demoteMain(spaceId) {
    const out = [];
    for (const a of this.agents.values()) {
      if (a.spaceId !== spaceId || !a.role || a.role.id !== 'main') continue;
      a.role = roleOf('worker');
      out.push(a);
    }
    return out;
  }

  /**
   * Every agent has a role, and every space with agents has exactly one Main (the oldest wins).
   * Run on load (state from before roles existed) and after an agent is removed.
   * @returns {Agent[]} agents whose role changed
   */
  fixRoles() {
    const changed = new Set();
    const bySpace = new Map();
    for (const a of this.agents.values()) {
      const r = normalizeRole(a.role);
      if (!r) { a.role = roleOf('worker'); changed.add(a); } else if (JSON.stringify(r) !== JSON.stringify(a.role)) { a.role = r; changed.add(a); }
      if (!bySpace.has(a.spaceId)) bySpace.set(a.spaceId, []);
      bySpace.get(a.spaceId).push(a);
    }
    for (const list of bySpace.values()) {
      list.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
      const mains = list.filter((a) => a.role.id === 'main');
      const keep = mains.length ? mains[0] : list[0];
      for (const a of list) {
        const want = a === keep ? 'main' : (a.role.id === 'main' ? 'worker' : a.role.id);
        if (want !== a.role.id) { a.role = roleOf(want); changed.add(a); }
      }
    }
    return [...changed];
  }

  agentsUpdate(params) {
    const agent = this.getAgent(params && params.id);
    let name = agent.name;
    if (params.name !== undefined) {
      if (typeof params.name !== 'string' || !params.name.trim()) throw new RpcError(ERRORS.BAD_REQUEST, 'name must be a non-empty string');
      name = params.name.trim().slice(0, 80);
    }
    let role = agent.role;
    if (params.role !== undefined) {
      const r = normalizeRole(params.role);
      if (!r) throw new RpcError(ERRORS.BAD_REQUEST, 'role must be { id } with a known id, or { id: "custom", label }');
      role = r;
    }
    const others = [];
    if (role.id === 'main' && agent.role.id !== 'main') others.push(...this.demoteMain(agent.spaceId));
    agent.name = name;
    agent.role = role;
    // Taking Main away from the only Main gives it to the oldest other agent (one Main per space).
    others.push(...this.fixRoles().filter((a) => a !== agent));
    this.store.saveNow();
    this.broadcast('agent.updated', { agent });
    for (const a of new Set(others)) if (a !== agent) this.broadcast('agent.updated', { agent: a });
    return agent;
  }

  /** Stop and resume the same conversation, e.g. so it picks up changed plugins. */
  agentsRestart(params) {
    const agent = this.getAgent(params && params.id);
    const term = this.terms.get(agent.id);
    if (!term || !term.running) {
      this.launch(agent, { resume: true });
      return true;
    }
    this.restartPending.add(agent.id);
    this.agentsStop({ id: agent.id });
    return true;
  }

  /** Stop every agent and ask the process to exit (index.js listens for 'shutdown-request'). */
  coreShutdown() {
    setImmediate(() => this.emit('shutdown-request'));
    return true;
  }

  /** @param {Agent} agent @param {{resume: boolean}} opts */
  launch(agent, opts) {
    const r = this.rt.get(agent.id) || newRuntime();
    const transcript = r.transcriptPath && fs.existsSync(r.transcriptPath) ? r.transcriptPath
      : fs.existsSync(defaultTranscriptPath(agent.cwd, agent.sessionId, this.env)) ? defaultTranscriptPath(agent.cwd, agent.sessionId, this.env) : '';
    // Resume only with a transcript; otherwise (e.g. closed on a setup screen) start fresh with the same id and resend the task.
    const resume = opts.resume && Boolean(transcript);
    const args = claudeArgs(agent, { resume, settingsPath: this.settingsPath, prompt: resume ? '' : agent.prompt });
    const now = Date.now();
    this.userStopped.delete(agent.id);
    this.update(agent.id, (s, rt) => ({
      status: withState(s, 'starting', { tool: '', detail: '' }, now),
      rt: { ...rt, launchAt: now, hookSinceLaunch: false, stuck: false, turnStartedAt: 0 },
    }));
    let spec;
    let term;
    try {
      spec = spawnSpec(baseCommand(this.env), args, { env: this.env, cwd: agent.cwd });
      let sb = this.scrollbacks.get(agent.id);
      if (!sb) { sb = new Scrollback(); this.scrollbacks.set(agent.id, sb); }
      const size = this.sizes.get(agent.id) || { cols: 120, rows: 32 };
      term = new AgentTerminal({ file: spec.file, args: spec.args, cwd: agent.cwd, env: this.agentEnv(agent), scrollback: sb, ...size });
    } catch (e) {
      const msg = `Could not start Claude: ${/** @type {Error} */ (e).message}`;
      this.update(agent.id, (s) => ({ status: withState(s, 'exited', { detail: msg }) }));
      this.broadcast('agent.exit', { id: agent.id, code: -1 });
      return;
    }
    this.terms.set(agent.id, term);
    term.on('data', (data) => { this.emit('output', agent.id, data); this.schedulePromptRead(agent.id, term); });
    term.on('exit', (code) => this.onExit(agent.id, term, code));
  }

  /** @param {Agent} agent */
  agentEnv(agent) {
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...this.env };
    // Started from inside a Claude Code session (e.g. the app opened from a Claude Code terminal):
    // drop what that session sets for its own children, or every agent would think it is a
    // nested child session (no transcript, so no resume and no usage). User settings such as
    // ANTHROPIC_API_KEY or CLAUDE_CODE_USE_BEDROCK pass through untouched.
    for (const k of PARENT_SESSION_VARS) delete env[k];
    // The installed core runs on Electron with ELECTRON_RUN_AS_NODE=1. Claude must not inherit
    // it (it would break any Electron app Claude starts); the hook launcher sets it for hook.js.
    delete env.ELECTRON_RUN_AS_NODE;
    env.CC_AGENT_ID = agent.id;
    env.CC_CORE_URL = this.coreUrl;
    env.CC_TOKEN = this.token;
    return env;
  }

  /** @param {string} id @param {AgentTerminal} term @param {number} code */
  onExit(id, term, code) {
    if (this.terms.get(id) !== term) return; // an older process of a resumed agent
    this.terms.delete(id);
    term.dispose();
    this.broadcast('agent.exit', { id, code });
    const stopped = this.userStopped.has(id);
    this.update(id, (s) => {
      if (stopped) return s.state === 'stopped' ? null : { status: withState(s, 'stopped', { tool: '' }) };
      return s.state === 'exited' ? null : { status: withState(s, 'exited', { tool: '' }) };
    });
    if (this.restartPending.delete(id)) {
      const agent = this.agents.get(id);
      if (agent) this.launch(agent, { resume: true });
    }
  }

  agentsStop(params) {
    const agent = this.getAgent(params && params.id);
    const term = this.terms.get(agent.id);
    this.userStopped.add(agent.id);
    if (term && term.running) {
      term.kill();
      if (process.platform !== 'win32') {
        // Something that ignores SIGHUP still has to go.
        setTimeout(() => { if (term.running) try { process.kill(term.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
      }
    }
    this.update(agent.id, (s) => (s.state === 'stopped' || s.state === 'exited' && !(term && term.running) ? null
      : { status: withState(s, 'stopped', { tool: '' }) }));
    return true;
  }

  agentsResume(params) {
    const agent = this.getAgent(params && params.id);
    if (this.isRunning(agent.id)) return true;
    this.launch(agent, { resume: true });
    return true;
  }

  agentsRemove(params) {
    const agent = this.getAgent(params && params.id);
    const term = this.terms.get(agent.id);
    this.userStopped.add(agent.id);
    if (term) {
      this.terms.delete(agent.id);
      term.kill();
      term.dispose();
    }
    this.agents.delete(agent.id);
    this.status.delete(agent.id);
    const r = this.rt.get(agent.id);
    if (r && r.transcriptPath) this.usage.forget(r.transcriptPath);
    this.rt.delete(agent.id);
    this.scrollbacks.delete(agent.id);
    this.sizes.delete(agent.id);
    const promoted = this.fixRoles();
    this.store.saveNow();
    try { this.activity.onRemove(agent.id); } catch { /* best effort */ }
    this.broadcast('agent.removed', { id: agent.id });
    for (const a of promoted) this.broadcast('agent.updated', { agent: a });
    return true;
  }

  agentsInput(params) {
    if (!params || typeof params.data !== 'string') throw new RpcError(ERRORS.BAD_REQUEST, 'data must be a string');
    this.runningTerm(params.id).write(params.data);
    return true;
  }

  agentsSend(params) {
    if (!params || typeof params.text !== 'string') throw new RpcError(ERRORS.BAD_REQUEST, 'text must be a string');
    this.runningTerm(params.id).send(params.text);
    return true;
  }

  agentsResize(params) {
    params = params || {};
    const agent = this.getAgent(params.id);
    const cols = Number(params.cols);
    const rows = Number(params.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 1000) {
      throw new RpcError(ERRORS.BAD_REQUEST, 'cols and rows must be whole numbers');
    }
    this.sizes.set(agent.id, { cols, rows });
    const t = this.terms.get(agent.id);
    if (t && t.running) t.resize(cols, rows);
    return true;
  }

  /** @returns {{replay: string}} */
  agentsAttach(params) {
    const agent = this.getAgent(params && params.id);
    const sb = this.scrollbacks.get(agent.id);
    return { replay: sb ? sb.toString() : '' };
  }

  /** Is a permission prompt on screen? Older Claude versions only send a Notification for it. */
  permissionPending(id) {
    return Core.permissionStatus(/** @type {AgentStatus} */ (this.status.get(id)));
  }

  /**
   * v2: the prompt the user answered (promptId) must still be the one on screen, read NOW; then
   * act(prompt) presses the key. The check and act run in one synchronous step after the screen
   * flush: nothing (another approve, a hook) can run in between.
   * @template T @param {string} id @param {AgentTerminal} term @param {string} promptId
   * @param {(p: import('./prompt').PermissionPrompt) => T} act @returns {Promise<T>}
   */
  async checkedPrompt(id, term, promptId, act) {
    const flushed = await this.flushScreen(term);
    if (this.terms.get(id) !== term || !term.running) throw new RpcError(ERRORS.NOT_RUNNING, `agent ${id} is not running`);
    if (!flushed) throw new RpcError(ERRORS.PROMPT_CHANGED, 'the screen is still changing; check the prompt again');
    if (!this.permissionPending(id)) throw new RpcError(ERRORS.NO_PERMISSION_PENDING, 'no permission prompt is waiting');
    const p = this.promptFor(id, /** @type {AgentStatus} */ (this.status.get(id)), /** @type {Runtime} */ (this.rt.get(id)));
    if (!p || p.id !== promptId) {
      this.refreshPrompt(id); // let the app see what is there now
      throw new RpcError(ERRORS.PROMPT_CHANGED, 'the prompt on screen is not the one you answered; check it again');
    }
    return act(p);
  }

  /** @param {any} params */
  answerParams(params) {
    if (!params || typeof params !== 'object') throw new RpcError(ERRORS.BAD_REQUEST, 'params required');
    if (params.promptId !== undefined && params.promptId !== null && (typeof params.promptId !== 'string' || !params.promptId)) {
      throw new RpcError(ERRORS.BAD_REQUEST, 'promptId must be a non-empty string');
    }
    return { id: params.id, promptId: typeof params.promptId === 'string' ? params.promptId : '' };
  }

  agentsApprove(params) {
    const { id, promptId } = this.answerParams(params);
    const choice = params.choice === undefined || params.choice === null ? 'allow' : params.choice;
    if (!APPROVE_CHOICES.includes(choice)) throw new RpcError(ERRORS.BAD_REQUEST, `choice must be one of ${APPROVE_CHOICES.join(', ')}`);
    const term = this.runningTerm(id);
    if (!this.permissionPending(id)) throw new RpcError(ERRORS.NO_PERMISSION_PENDING, 'no permission prompt is waiting');
    const answered = () => {
      const now = Date.now();
      this.update(id, (s, r) => ({ status: withState(s, 'working', {}, now), rt: { ...r, answeredAt: now } }));
      return true;
    };
    if (!promptId) {
      // v1: "1. Yes" is the first option. Anything else needs to know which prompt is on screen.
      if (choice !== 'allow') throw new RpcError(ERRORS.BAD_REQUEST, `choice ${choice} needs promptId`);
      term.write('1');
      return answered();
    }
    return this.checkedPrompt(id, term, promptId, (p) => {
      // By wording, never by position; no fallback to another option.
      const opts = p.options.filter((o) => o.kind === choice);
      if (opts.length !== 1) throw new RpcError(ERRORS.BAD_REQUEST, `this prompt has no ${choice === 'allow' ? '"Yes"' : '"don\'t ask again"'} option`);
      term.rawWrite(opts[0].key); // now, ahead of anything queued: the screen was checked a moment ago
      return answered();
    });
  }

  agentsDeny(params) {
    const { id, promptId } = this.answerParams(params);
    const term = this.runningTerm(id);
    if (!this.permissionPending(id)) throw new RpcError(ERRORS.NO_PERMISSION_PENDING, 'no permission prompt is waiting');
    const denied = () => {
      const now = Date.now();
      // Esc ends the turn; background subagents go on (the session stays working while they run).
      const subs = this.activity.onPromptGone(id);
      this.update(id, (s, r) => ({ status: restingStatus(s, subs, now), rt: { ...r, answeredAt: now, turnStartedAt: 0 } }));
      return true;
    };
    if (!promptId) {
      term.write('\x1b'); // Esc cancels; Claude then waits for instructions
      return denied();
    }
    return this.checkedPrompt(id, term, promptId, () => {
      term.rawWrite('\x1b');
      return denied();
    });
  }

  hello() { return { version: this.version, protocol: PROTOCOL_VERSION }; }

  /** Save, then end every agent process. */
  shutdown() {
    if (this.ticker) clearInterval(this.ticker);
    try { this.dashboards.shutdown(); } catch { /* best effort */ }
    try { this.activity.shutdown(); } catch { /* best effort */ }
    try { this.external.shutdown(); } catch { /* best effort */ }
    try { this.store.saveNow(); } catch { /* best effort */ }
    for (const [id, term] of this.terms) {
      this.userStopped.add(id);
      term.kill();
    }
  }
}

module.exports = { Core, RpcError, slug, defaultTranscriptPath, normalizeRole, STUCK_MESSAGE, PROMPT_MARKERS };
