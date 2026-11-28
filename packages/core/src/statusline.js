// @ts-check
'use strict';
/**
 * Status line (contract v4). Claude Code pipes a JSON snapshot to the statusLine command on every update; the
 * relay (statusline-relay.js) forwards it to POST /statusline?agent=<id> and core.handleStatusLine() hands it here.
 * From it: AgentStatus.usage (exact context window and %, cost) and the account Usage (rate limits, cost and token
 * totals per agent / space / day), saved in <CC_HOME>/usage.json.
 *
 * At launch (prepare()) it also finds the user's own status line, the way Claude would without ours, and tells
 * the relay how to run it (CC_STATUSLINE), so registering ours never hides theirs.
 *
 * Fixtures: tests/fixtures/statusline/{startup,sample}.json (real Claude 2.1.332).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic, readJson } = require('./store');
const { ensureSettings, displayOptions } = require('./hooks-settings');
const { contextWindowFor, percentOf } = require('./usage');
const { which } = require('./command');

/** @typedef {import('./types').Usage} Usage */
/** @typedef {import('./types').UsageTotals} UsageTotals */
/** @typedef {import('./types').AgentUsage} AgentUsage */

const USAGE_VERSION = 1;
/** Apply at most one update per agent per this many ms (trailing: the last one always lands). */
const THROTTLE_MS = 1000;
/** usage.changed at most this often. */
const BROADCAST_MS = 1000;
const SAVE_MS = 1000; // on Windows every stop of the core is a hard kill: keep the window short
const KEEP_DAYS = 90;

/** @returns {Usage} */
function emptyUsage() {
  return { limits: { updatedAt: 0 }, byAgent: {}, bySpace: {}, byDay: {}, updatedAt: 0 };
}

// ---- small readers that never throw on junk -------------------------------------------------

/** @param {any} v @returns {Record<string, any>} */
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
/** @param {any} v @returns {number|null} */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** @param {any} v @returns {string} */
const str = (v) => (typeof v === 'string' ? v : '');

/** Local date "YYYY-MM-DD". @param {number} ms */
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** @returns {UsageTotals} */
const zeroTotals = () => ({ costUsd: 0, inputTokens: 0, outputTokens: 0 });

/**
 * What one status-line snapshot says, cleaned up. Fields Claude left out or set to null are null.
 * @param {any} payload
 */
function parseSnapshot(payload) {
  const p = obj(payload);
  const cw = obj(p.context_window);
  const cu = cw.current_usage && typeof cw.current_usage === 'object' ? obj(cw.current_usage) : null;
  const size = num(cw.context_window_size);
  const pct = num(cw.used_percentage);
  /** @param {any} l */
  const limit = (l) => {
    const o = obj(l);
    const used = num(o.used_percentage);
    if (used === null) return undefined;
    const at = num(o.resets_at);
    return { usedPct: Math.max(0, Math.min(100, used)), resetsAt: at === null ? 0 : Math.round(at * 1000) };
  };
  const rl = p.rate_limits && typeof p.rate_limits === 'object' ? obj(p.rate_limits) : null;
  return {
    sessionId: str(p.session_id),
    model: str(obj(p.model).id),
    window: size !== null && size > 0 ? size : null,
    pct: pct === null ? null : Math.max(0, Math.min(100, pct)),
    // The prompt size: everything sent in, cached or not (the output is not in the window yet).
    context: cu ? (num(cu.input_tokens) || 0) + (num(cu.cache_creation_input_tokens) || 0) + (num(cu.cache_read_input_tokens) || 0) : null,
    cost: num(obj(p.cost).total_cost_usd),
    inputTokens: num(cw.total_input_tokens),
    outputTokens: num(cw.total_output_tokens),
    fiveHour: rl ? limit(rl.five_hour) : undefined,
    sevenDay: rl ? limit(rl.seven_day) : undefined,
  };
}

// ---- the user's own status line ------------------------------------------------------------

/** @param {NodeJS.ProcessEnv} env */
function claudeConfigDir(env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * The user's effective statusLine without ours: <cwd>/.claude/settings.local.json, then
 * <cwd>/.claude/settings.json, then <CLAUDE_CONFIG_DIR or ~/.claude>/settings.json; the first that has one.
 * (Managed settings outrank our --settings, so when they set a status line ours never runs anyway.)
 * Only type "command" can run; one that points at our own relay is skipped.
 * @param {string} cwd @param {NodeJS.ProcessEnv} env @returns {Record<string, any>|null}
 */
function findUserStatusLine(cwd, env) {
  const files = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(claudeConfigDir(env), 'settings.json'),
  ];
  for (const file of files) {
    const s = readJson(file);
    if (!s || typeof s !== 'object' || !('statusLine' in s)) continue;
    const sl = s.statusLine;
    if (!sl || typeof sl !== 'object' || Array.isArray(sl)) continue;
    if (sl.type !== 'command' || typeof sl.command !== 'string' || !sl.command.trim()) return null;
    if (/cc-statusline\.(cmd|sh)|statusline-relay\.js/i.test(sl.command)) return null;
    return sl;
  }
  return null;
}

/**
 * Git Bash, found the way Claude Code finds it on Windows: CLAUDE_CODE_GIT_BASH_PATH (a bash/sh binary
 * that exists), then the usual install folders, then <git on PATH>/../../bin/bash.exe.
 * @param {NodeJS.ProcessEnv} env @returns {string|null}
 */
function findGitBash(env) {
  const given = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (given && ['bash.exe', 'sh.exe', 'bash', 'sh'].includes(path.win32.basename(given).toLowerCase()) && fs.existsSync(given)) return given;
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
    if (fs.existsSync(p)) return p;
  }
  const git = which('git', { env, platform: 'win32' });
  if (git) {
    const p = path.win32.join(git, '..', '..', 'bin', 'bash.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * The shell Claude Code runs status-line (and hook) commands with: Git Bash on Windows when it finds one,
 * else PowerShell; sh elsewhere ('bash' here means "the POSIX shell").
 * @param {NodeJS.ProcessEnv} env @param {NodeJS.Platform} [platform]
 * @returns {{shell: 'bash'|'powershell', bash: string|null}}
 */
function claudeShell(env, platform = process.platform) {
  if (platform !== 'win32') return { shell: 'bash', bash: null };
  const bash = findGitBash(env);
  return bash ? { shell: 'bash', bash } : { shell: 'powershell', bash: null };
}

/**
 * How the relay runs the user's command, the way Claude would (CC_STATUSLINE). Claude's statusLine has no
 * shell / args / timeout options (its settings schema drops them), so it always takes the default shell.
 * @param {string} command @param {{shell: 'bash'|'powershell', bash: string|null}} sh
 * @param {NodeJS.ProcessEnv} env @param {NodeJS.Platform} [platform]
 * @returns {{command?: string, shell?: string|boolean, file?: string, args?: string[]}}
 */
function userRun(command, sh, env, platform = process.platform) {
  if (platform !== 'win32') return { command, shell: true };
  if (sh.shell === 'bash' && sh.bash) {
    // Like Claude: a command whose program is a .sh file is run with bash.
    return { command: firstWord(command).endsWith('.sh') ? `bash ${command}` : command, shell: sh.bash };
  }
  const pwsh = which('pwsh', { env, platform: 'win32' }) || which('powershell', { env, platform: 'win32' }) || 'powershell.exe';
  // Claude rewrites ${CLAUDE_PROJECT_DIR} and friends into PowerShell's ${env:...}.
  let cmd = command;
  for (const n of ['CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA']) cmd = cmd.split('${' + n + '}').join('${env:' + n + '}');
  return { file: pwsh, args: ['-NoProfile', '-NonInteractive', '-Command', cmd] };
}

/** The program of a shell command, unquoted (Claude's own rule for spotting `x.sh`). @param {string} command */
function firstWord(command) {
  const s = command.trim();
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const j = s.indexOf(c, i + 1);
      if (j === -1) { out += s.slice(i + 1); break; }
      out += s.slice(i + 1, j);
      i = j + 1;
    } else if (c === '\\' && i + 1 < s.length) { out += s[i + 1]; i += 2; } else if (/\s/.test(c)) break;
    else { out += c; i++; }
  }
  return out;
}

// ---- the core side -------------------------------------------------------------------------

/** @typedef {{sessionId: string, costUsd: number, inputTokens: number, outputTokens: number, contextWindow?: number}} Baseline */

class StatusLine {
  /** @param {import('./core').Core} core @param {{throttleMs?: number}} [opts] */
  constructor(core, opts = {}) {
    this.core = core;
    this.throttleMs = opts.throttleMs === undefined ? THROTTLE_MS : opts.throttleMs;
    /** @type {Usage} */
    this.usage = emptyUsage();
    /** @type {Record<string, number>} model id -> the window the status line last reported for it */
    this.windows = {};
    /** @type {Record<string, Baseline>} per agent: what the next deltas are measured from, and its last window */
    this.agents = {};
    /** @type {Map<string, ReturnType<typeof parseSnapshot>>} the latest applied snapshot (memory only) */
    this.live = new Map();
    /** @type {Map<string, {last: number, pending: any, timer: NodeJS.Timeout|null}>} */
    this.throttle = new Map();
    /** @type {NodeJS.Timeout|null} */ this.saveTimer = null;
    /** @type {NodeJS.Timeout|null} */ this.broadcastTimer = null;
    this.lastBroadcast = 0;
    this.file = '';
  }

  /** Load <CC_HOME>/usage.json. */
  start() {
    this.file = path.join(this.core.home, 'usage.json');
    const d = readJson(this.file);
    if (!d || typeof d !== 'object') return;
    /** @param {any} m */
    const totalsMap = (m) => {
      /** @type {Record<string, UsageTotals>} */
      const out = {};
      for (const [k, v] of Object.entries(obj(m))) {
        const o = obj(v);
        /** @type {UsageTotals} */
        const t = { costUsd: num(o.costUsd) || 0, inputTokens: num(o.inputTokens) || 0, outputTokens: num(o.outputTokens) || 0 };
        if (typeof o.name === 'string') t.name = o.name;
        if (typeof o.spaceId === 'string') t.spaceId = o.spaceId;
        out[k] = t;
      }
      return out;
    };
    const lim = obj(d.limits);
    /** @param {any} l */
    const limit = (l) => (l && num(l.usedPct) !== null ? { usedPct: num(l.usedPct) || 0, resetsAt: num(l.resetsAt) || 0 } : undefined);
    /** @type {Usage['limits']} */
    const limits = { updatedAt: num(lim.updatedAt) || 0 };
    const five = limit(lim.fiveHour);
    const seven = limit(lim.sevenDay);
    if (five) limits.fiveHour = five;
    if (seven) limits.sevenDay = seven;
    if (typeof lim.fromAgentId === 'string') limits.fromAgentId = lim.fromAgentId;
    this.usage = {
      limits, byAgent: totalsMap(d.byAgent), bySpace: totalsMap(d.bySpace), byDay: totalsMap(d.byDay), updatedAt: num(d.updatedAt) || 0,
    };
    for (const [k, v] of Object.entries(obj(d.windows))) {
      const n = num(v);
      if (n && n > 0) this.windows[k] = n;
    }
    for (const [k, v] of Object.entries(obj(d.agents))) {
      const o = obj(v);
      /** @type {Baseline} */
      const b = { sessionId: str(o.sessionId), costUsd: num(o.costUsd) || 0, inputTokens: num(o.inputTokens) || 0, outputTokens: num(o.outputTokens) || 0 };
      const w = num(o.contextWindow);
      if (w && w > 0) b.contextWindow = w;
      this.agents[k] = b;
    }
  }

  /** Apply what is pending and save now. */
  shutdown() {
    for (const [id, t] of this.throttle) {
      if (t.timer) clearTimeout(t.timer);
      t.timer = null;
      if (t.pending) {
        const p = t.pending;
        t.pending = null;
        try { this.apply(id, p); } catch { /* best effort */ }
      }
    }
    if (this.broadcastTimer) { clearTimeout(this.broadcastTimer); this.broadcastTimer = null; }
    this.saveNow();
  }

  /**
   * What an agent's launch needs: the settings file to pass (ours, with the user's display options) and the
   * env for the relay (CC_STATUSLINE: how to run the user's own status line; absent when they have none).
   * @param {{cwd: string}} agent @param {NodeJS.ProcessEnv} [env]
   * @returns {{settingsPath: string, env: Record<string, string>}}
   */
  prepare(agent, env = this.core.env) {
    const sh = claudeShell(env);
    let user = null;
    try { user = findUserStatusLine(agent.cwd, env); } catch { user = null; }
    const settingsPath = ensureSettings(this.core.home, { shell: sh.shell, display: displayOptions(user) });
    /** @type {Record<string, string>} */
    const vars = {};
    if (user) vars.CC_STATUSLINE = JSON.stringify(userRun(user.command, sh, env));
    return { settingsPath, env: vars };
  }

  /**
   * One status-line update from an agent the core knows. Applied at most once a second per agent; the last
   * one always lands.
   * @param {string} agentId @param {any} payload
   */
  handle(agentId, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    let t = this.throttle.get(agentId);
    if (!t) { t = { last: 0, pending: null, timer: null }; this.throttle.set(agentId, t); }
    const now = Date.now();
    if (!t.timer && now - t.last >= this.throttleMs) {
      t.last = now;
      this.apply(agentId, payload);
      return;
    }
    t.pending = payload;
    if (t.timer) return;
    const tt = t;
    tt.timer = setTimeout(() => {
      tt.timer = null;
      tt.last = Date.now();
      const p = tt.pending;
      tt.pending = null;
      if (p) try { this.apply(agentId, p); } catch { /* never breaks the core */ }
    }, Math.max(0, this.throttleMs - (now - t.last)));
    if (tt.timer.unref) tt.timer.unref();
  }

  /** @param {string} id @param {any} payload */
  apply(id, payload) {
    const agent = this.core.agents.get(id);
    if (!agent) return;
    const snap = parseSnapshot(payload);
    const now = Date.now();
    this.live.set(id, snap);
    const prev = this.agents[id];
    /** @type {Baseline} */
    const base = prev ? { ...prev } : { sessionId: snap.sessionId, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    if (snap.window) {
      base.contextWindow = snap.window;
      if (snap.model) this.windows[snap.model] = snap.window;
    }

    // Totals from deltas. The first update of an agent, a new session, or a value that went down (a new
    // process, --resume) starts a new baseline: what it reports then is not counted, so nothing counts twice.
    const cur = { costUsd: snap.cost, inputTokens: snap.inputTokens, outputTokens: snap.outputTokens };
    const keys = /** @type {const} */ (['costUsd', 'inputTokens', 'outputTokens']);
    const fresh = !prev || Boolean(snap.sessionId && prev.sessionId !== snap.sessionId);
    const wentDown = keys.some((k) => { const v = cur[k]; return v !== null && v < base[k]; });
    /** @type {UsageTotals} */
    const delta = zeroTotals();
    if (!fresh && !wentDown) {
      for (const k of keys) { const v = cur[k]; if (v !== null) delta[k] = v - base[k]; }
    }
    for (const k of keys) { const v = cur[k]; if (v !== null) base[k] = v; }
    if (snap.sessionId) base.sessionId = snap.sessionId;
    this.agents[id] = base;

    const u = this.usage;
    const ba = u.byAgent[id] || zeroTotals();
    ba.name = agent.name;
    ba.spaceId = agent.spaceId;
    u.byAgent[id] = ba;
    if (delta.costUsd || delta.inputTokens || delta.outputTokens) {
      addTo(ba, delta);
      addTo(u.bySpace[agent.spaceId] || (u.bySpace[agent.spaceId] = zeroTotals()), delta);
      const day = localDay(now);
      addTo(u.byDay[day] || (u.byDay[day] = zeroTotals()), delta);
    }

    if (snap.fiveHour || snap.sevenDay) {
      /** @type {Usage['limits']} */
      const limits = { updatedAt: now, fromAgentId: id };
      if (snap.fiveHour) limits.fiveHour = snap.fiveHour;
      if (snap.sevenDay) limits.sevenDay = snap.sevenDay;
      u.limits = limits;
    }
    u.updatedAt = now;

    this.core.update(id, (s) => {
      const usage = this.merge(id, s.usage || { total: 0, context: 0, contextPct: 0, model: '' });
      if (JSON.stringify(usage) === JSON.stringify(s.usage)) return null;
      return { status: { ...s, usage, updatedAt: now } };
    });
    this.saveSoon();
    this.broadcastSoon();
  }

  /**
   * The AgentUsage to show, from a transcript estimate (or the previous usage) and the latest status line.
   * With Claude's own used_percentage: context, %, window, cost and model from the status line ('statusline');
   * `total` keeps its meaning (input + output + cache writes, from the transcript). Before the first reply
   * (used_percentage null): the estimate, with the window from the status line ('transcript').
   * @param {string} id @param {AgentUsage} u @returns {AgentUsage}
   */
  merge(id, u) {
    const snap = this.live.get(id);
    if (!snap) return u;
    /** @type {AgentUsage} */
    const out = { total: u.total || 0, context: u.context || 0, contextPct: u.contextPct || 0, model: snap.model || u.model || '' };
    if (snap.pct !== null) {
      if (snap.context !== null) out.context = snap.context;
      out.contextPct = snap.pct;
      const w = snap.window || u.contextWindow;
      if (w) out.contextWindow = w;
      out.source = 'statusline';
    } else {
      const w = contextWindowFor(out.model, out.context, snap.window || this.windowFor(id, out.model));
      out.contextWindow = w;
      out.contextPct = percentOf(out.context, w);
      out.source = 'transcript';
    }
    if (snap.cost !== null) out.costUsd = snap.cost;
    else if (typeof u.costUsd === 'number') out.costUsd = u.costUsd;
    return out;
  }

  /**
   * The window to estimate with for an agent: the last one its status line reported, else the last one seen
   * for this model id. undefined when neither is known.
   * @param {string} id @param {string} model @returns {number|undefined}
   */
  windowFor(id, model) {
    const a = this.agents[id];
    if (a && a.contextWindow) return a.contextWindow;
    if (model && this.windows[model]) return this.windows[model];
    return undefined;
  }

  /** usage.get @param {any} [params] @returns {Usage} */
  usageGet(params) { void params; return this.usage; }

  /** agents.remove: keep its totals (byAgent keeps the name), drop live state. @param {string} agentId */
  onRemove(agentId) {
    const t = this.throttle.get(agentId);
    if (t && t.timer) clearTimeout(t.timer);
    this.throttle.delete(agentId);
    this.live.delete(agentId);
    delete this.agents[agentId];
    this.saveSoon();
  }

  broadcastSoon() {
    if (this.broadcastTimer) return;
    const wait = Math.max(0, BROADCAST_MS - (Date.now() - this.lastBroadcast));
    const send = () => {
      this.broadcastTimer = null;
      this.lastBroadcast = Date.now();
      this.core.broadcast('usage.changed', { usage: this.usage });
    };
    if (wait === 0) { send(); return; }
    this.broadcastTimer = setTimeout(send, wait);
    if (this.broadcastTimer.unref) this.broadcastTimer.unref();
  }

  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, SAVE_MS);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  saveNow() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.file) return;
    pruneDays(this.usage.byDay, Date.now());
    const data = { version: USAGE_VERSION, ...this.usage, windows: this.windows, agents: this.agents };
    try { writeFileAtomic(this.file, JSON.stringify(data, null, 1) + '\n'); } catch { /* retried on the next change */ }
  }
}

/** @param {UsageTotals} t @param {UsageTotals} d */
function addTo(t, d) {
  t.costUsd = Math.round((t.costUsd + d.costUsd) * 1e6) / 1e6;
  t.inputTokens += d.inputTokens;
  t.outputTokens += d.outputTokens;
}

/** Drop days older than KEEP_DAYS. @param {Record<string, UsageTotals>} byDay @param {number} now */
function pruneDays(byDay, now) {
  const cutoff = localDay(now - KEEP_DAYS * 24 * 3600 * 1000);
  for (const k of Object.keys(byDay)) if (k < cutoff) delete byDay[k];
}

module.exports = {
  StatusLine, emptyUsage, parseSnapshot, findUserStatusLine, findGitBash, claudeShell, userRun, firstWord, localDay,
  THROTTLE_MS, KEEP_DAYS,
};
