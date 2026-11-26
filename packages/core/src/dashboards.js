// @ts-check
'use strict';
/**
 * Dashboards: tools with a dashboard the app can open (protocol `dashboards.*`). Owner: the Dashboards track (M2).
 *
 * Where dashboards come from:
 *   - builtin: a small registry (CodeBurn terminal + web). `available` = the tool is on PATH (or npx is).
 *   - plugin:  installed Claude Code plugins (`claude plugin list --json`). A `dashboard` field in
 *              .claude-plugin/plugin.json (or plugin.json), a dashboard/index.html file, or a homepage.
 *              Their commands are untrusted until `dashboards.trust` (remembered per command).
 *   - user:    `dashboards.add`, saved in <CC_HOME>/dashboards.json, trusted.
 *
 * Terminal dashboards run in a PTY (AgentTerminal) and stream through core.emit('dashboard-output');
 * web dashboards run as a plain child process and resolve with the local URL they print.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { ERRORS } = require('../../shared/protocol');
const { baseCommand, splitCommand, spawnSpec, which, quoteWinArg } = require('./command');
const { writeFileAtomic, readJson } = require('./store');

const FILE_VERSION = 1;
const SCAN_TTL_MS = 60_000;
const URL_TIMEOUT_MS = 20_000;
const OUTPUT_TAIL = 8192;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s"'<>\x1b\x07]*)?/i;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const KINDS = ['terminal', 'web', 'page', 'url', 'app'];
const USER_KINDS = ['terminal', 'web', 'url', 'app'];

/** @param {string} code @param {string} message */
function rpcError(code, message) {
  const { RpcError } = require('./core');
  return new RpcError(code, message);
}

/** @param {string} text */
const stripAnsi = (text) => text.replace(ANSI, '');

/**
 * Is this a web address a dashboard may open in its own window (local only)?
 * @param {unknown} u @returns {boolean}
 */
function isLocalUrl(u) {
  if (typeof u !== 'string') return false;
  let p;
  try { p = new URL(u); } catch { return false; }
  return (p.protocol === 'http:' || p.protocol === 'https:') && (p.hostname === 'localhost' || p.hostname === '127.0.0.1');
}

/** @param {unknown} u @returns {boolean} */
function isWebUrl(u) {
  if (typeof u !== 'string') return false;
  try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; }
}

/**
 * First local URL in program output (ANSI removed). Trailing sentence punctuation is dropped.
 * @param {string} text @returns {string|null}
 */
function findLocalUrl(text) {
  const m = stripAnsi(text).match(LOCAL_URL);
  return m ? m[0].replace(/[.,;:)\]]+$/, '') : null;
}

/**
 * What child_process needs to run a spawnSpec result (node-pty's Windows command-line string passes through verbatim).
 * @param {{file:string, args:string[]|string}} spec
 */
function childSpawn(spec) {
  const isStr = typeof spec.args === 'string';
  // A verbatim command line starts with argv0: quote it, or a program under "C:\\Program Files" gets a broken argv[0] (library.js does the same).
  return { file: spec.file, args: isStr ? [/** @type {string} */ (spec.args)] : /** @type {string[]} */ (spec.args), verbatim: isStr, argv0: isStr ? quoteWinArg(spec.file) : undefined };
}

/** Kill a process and what it started. @param {import('child_process').ChildProcess} child */
function killTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    }
  } catch { /* already gone */ }
}

/**
 * Dashboards declared by one plugin folder.
 * @param {string} pluginId @param {string} pluginName @param {string} dir absolute plugin folder
 * @returns {import('../../shared/protocol').Dashboard[]}
 */
function readPluginDashboards(pluginId, pluginName, dir) {
  /** @type {any} */
  let manifest = null;
  for (const f of [path.join(dir, '.claude-plugin', 'plugin.json'), path.join(dir, 'plugin.json')]) {
    manifest = readJson(f);
    if (manifest && typeof manifest === 'object') break;
    manifest = null;
  }
  const name = String((manifest && manifest.name) || pluginName || pluginId);
  const id = `plugin:${pluginId}`;
  /** @param {string} rel @returns {string|null} absolute file inside the plugin folder, if it exists */
  const inside = (rel) => {
    if (typeof rel !== 'string' || !rel.trim()) return null;
    const abs = path.resolve(dir, rel);
    const r = path.relative(dir, abs);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
    try { return fs.statSync(abs).isFile() ? abs : null; } catch { return null; }
  };
  /** @type {import('../../shared/protocol').Dashboard} */
  const base = { id, name, kind: 'url', source: 'plugin', pluginId, available: true, trusted: true, cwd: dir };
  const field = manifest && manifest.dashboard;

  if (typeof field === 'string' && field.trim()) {
    if (isLocalUrl(field)) return [{ ...base, kind: 'web', url: field, description: `Dashboard from the ${name} plugin` }];
    const file = inside(field);
    if (file) return [{ ...base, kind: 'page', file, description: `Dashboard from the ${name} plugin` }];
  } else if (field && typeof field === 'object') {
    const d = /** @type {any} */ (field);
    const kind = KINDS.includes(d.kind) ? d.kind : d.command ? 'terminal' : d.file ? 'page' : d.url ? (isLocalUrl(d.url) ? 'web' : 'url') : '';
    const label = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : name;
    const description = typeof d.description === 'string' ? d.description : `Dashboard from the ${name} plugin`;
    if (kind === 'terminal' || kind === 'web' || kind === 'app') {
      if (typeof d.command === 'string' && d.command.trim()) return [{ ...base, name: label, kind, command: d.command.trim(), trusted: false, description }];
      if (kind === 'web' && isLocalUrl(d.url)) return [{ ...base, name: label, kind, url: d.url, description }];
    } else if (kind === 'page') {
      const file = inside(d.file);
      if (file) return [{ ...base, name: label, kind, file, description }];
    } else if (kind === 'url' && isWebUrl(d.url)) {
      return [{ ...base, name: label, kind, url: d.url, description }];
    }
  }
  const index = inside(path.join('dashboard', 'index.html'));
  if (index) return [{ ...base, kind: 'page', file: index, description: `Dashboard page of the ${name} plugin` }];
  if (manifest && isWebUrl(manifest.homepage)) return [{ ...base, kind: 'url', url: manifest.homepage, description: `Homepage of the ${name} plugin` }];
  return [];
}

/** @typedef {{kind:'terminal', term: import('./terminal').AgentTerminal, exited: boolean}} TermRun */
/** @typedef {{kind:'web', child: import('child_process').ChildProcess, url: string, tail: string, exited: boolean, pending: Promise<{url:string}>|null}} WebRun */

class Dashboards {
  /** @param {import('./core').Core} core */
  constructor(core) {
    this.core = core;
    this.file = path.join(core.home, 'dashboards.json');
    /** @type {import('../../shared/protocol').Dashboard[]} */
    this.userEntries = [];
    /** @type {Record<string, string>} plugin dashboard id -> the command the user trusted */
    this.trusted = {};
    this.loaded = false;
    /** @type {import('../../shared/protocol').Dashboard[]} */
    this.pluginEntries = [];
    this.scannedAt = 0;
    /** @type {Promise<void>|null} */
    this.scanning = null;
    /** @type {Map<string, TermRun|WebRun>} */
    this.running = new Map();
    this.urlTimeoutMs = Number(core.env.CC_DASHBOARD_URL_TIMEOUT_MS) > 0 ? Number(core.env.CC_DASHBOARD_URL_TIMEOUT_MS) : URL_TIMEOUT_MS;
  }

  // ---- storage ----

  load() {
    if (this.loaded) return;
    this.loaded = true;
    const data = readJson(this.file);
    if (data && Array.isArray(data.dashboards)) {
      this.userEntries = data.dashboards.filter((/** @type {any} */ d) => d && typeof d.id === 'string' && USER_KINDS.includes(d.kind) && typeof d.name === 'string')
        .map((/** @type {any} */ d) => ({ ...d, source: 'user', available: true, trusted: true }));
    }
    if (data && data.trusted && typeof data.trusted === 'object') this.trusted = { ...data.trusted };
  }

  save() {
    const user = this.userEntries.map(({ id, name, kind, command, url, cwd, description }) => ({ id, name, kind, command, url, cwd, description }));
    writeFileAtomic(this.file, JSON.stringify({ version: FILE_VERSION, dashboards: user, trusted: this.trusted }, null, 1) + '\n');
  }

  // ---- discovery ----

  /** @returns {import('../../shared/protocol').Dashboard[]} */
  builtin() {
    const env = this.core.env;
    const override = (env.CC_CODEBURN || '').trim();
    const direct = which('codeburn', { env });
    const npx = which('npx', { env });
    const command = override || (direct ? 'codeburn' : 'npx codeburn');
    const available = !!(override || direct || npx);
    const hint = 'npm i -g codeburn';
    return [
      { id: 'codeburn-terminal', name: 'CodeBurn', kind: 'terminal', source: 'builtin', command, available, trusted: true, description: `Token and cost dashboard in a terminal. Not installed? ${hint}` },
      { id: 'codeburn-web', name: 'CodeBurn (web)', kind: 'web', source: 'builtin', command: `${command} web`, available, trusted: true, description: `Token and cost dashboard in your browser. Not installed? ${hint}` },
    ];
  }

  /** Installed plugin folders from `claude plugin list --json`. @returns {Promise<Array<{id:string, name:string, dir:string}>>} */
  listPluginFolders() {
    return new Promise((resolve) => {
      let spec;
      try { spec = spawnSpec(baseCommand(this.core.env), ['plugin', 'list', '--json'], { env: this.core.env }); } catch { return resolve([]); }
      const c = childSpawn(spec);
      try {
        const proc = execFile(c.file, c.args, { env: this.core.env, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: c.verbatim, argv0: c.argv0 }, (err, stdout) => {
          if (err) return resolve([]);
          /** @type {any} */
          let data;
          try { data = JSON.parse(stdout); } catch { return resolve([]); }
          const rows = Array.isArray(data) ? data : data && Array.isArray(data.plugins) ? data.plugins : data && Array.isArray(data.installed) ? data.installed : [];
          /** @type {Array<{id:string, name:string, dir:string}>} */
          const out = [];
          for (const r of rows) {
            if (!r || typeof r !== 'object' || r.enabled === false) continue;
            const dir = r.installPath || r.path || r.dir;
            const id = r.id || r.name;
            if (typeof dir !== 'string' || typeof id !== 'string' || !fs.existsSync(dir)) continue;
            out.push({ id, name: String(r.name || String(id).split('@')[0]), dir: path.resolve(dir) });
          }
          resolve(out);
        });
        if (proc.stdin) proc.stdin.end(); // a program that reads stdin must see the end
      } catch { resolve([]); }
    });
  }

  /** @param {boolean} [force] */
  async scan(force = false) {
    if (!force && this.scannedAt && Date.now() - this.scannedAt < SCAN_TTL_MS) return;
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const folders = await this.listPluginFolders();
      /** @type {import('../../shared/protocol').Dashboard[]} */
      const entries = [];
      for (const f of folders) {
        try { entries.push(...readPluginDashboards(f.id, f.name, f.dir)); } catch { /* unreadable plugin: skip */ }
      }
      this.pluginEntries = entries;
      this.scannedAt = Date.now();
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  /** Everything, from what is cached. @returns {import('../../shared/protocol').Dashboard[]} */
  build() {
    this.load();
    const plugins = this.pluginEntries.map((d) => ({ ...d, trusted: !d.command || this.trusted[d.id] === d.command }));
    return [...this.builtin(), ...plugins, ...this.userEntries.map((d) => ({ ...d }))];
  }

  changed() { this.core.broadcast('dashboards.changed', { dashboards: this.build() }); }

  /** @param {any} [params] */
  async list(params) {
    this.load();
    await this.scan(!!(params && params.refresh));
    return this.build();
  }

  /** @param {any} id @returns {Promise<import('../../shared/protocol').Dashboard>} */
  async find(id) {
    if (typeof id !== 'string' || !id) throw rpcError(ERRORS.BAD_REQUEST, 'id is required');
    this.load();
    let d = this.build().find((x) => x.id === id);
    if (!d && id.startsWith('plugin:')) { await this.scan(true); d = this.build().find((x) => x.id === id); }
    if (!d) throw rpcError(ERRORS.NOT_FOUND, `no dashboard ${id}`);
    return d;
  }

  // ---- user entries ----

  /** @param {any} p */
  add(p) {
    this.load();
    const name = p && typeof p.name === 'string' ? p.name.trim() : '';
    if (!name) throw rpcError(ERRORS.BAD_REQUEST, 'name is required');
    if (!p || !USER_KINDS.includes(p.kind)) throw rpcError(ERRORS.BAD_REQUEST, `kind must be one of ${USER_KINDS.join(', ')}`);
    const command = typeof p.command === 'string' ? p.command.trim() : '';
    const url = typeof p.url === 'string' ? p.url.trim() : '';
    /** @type {import('../../shared/protocol').Dashboard} */
    const d = { id: `user-${require('crypto').randomBytes(4).toString('hex')}`, name, kind: p.kind, source: 'user', available: true, trusted: true };
    if (p.kind === 'url') {
      if (!isWebUrl(url)) throw rpcError(ERRORS.BAD_REQUEST, 'a web address (http or https) is required');
      d.url = url;
    } else if (p.kind === 'web' && !command) {
      if (!isLocalUrl(url)) throw rpcError(ERRORS.BAD_REQUEST, 'a command, or a local address (http://localhost…), is required');
      d.url = url;
    } else {
      if (!command) throw rpcError(ERRORS.BAD_REQUEST, 'a command is required');
      d.command = command;
    }
    if (typeof p.cwd === 'string' && p.cwd.trim()) d.cwd = p.cwd.trim();
    this.userEntries.push(d);
    this.save();
    this.changed();
    return d;
  }

  /** @param {any} p */
  async remove(p) {
    this.load();
    const id = p && p.id;
    const i = this.userEntries.findIndex((d) => d.id === id);
    if (i < 0) {
      if (typeof id === 'string' && (id.startsWith('plugin:') || this.builtin().some((b) => b.id === id))) throw rpcError(ERRORS.NOT_ALLOWED, 'only your own dashboards can be removed');
      throw rpcError(ERRORS.NOT_FOUND, `no dashboard ${id}`);
    }
    this.stopRun(id);
    this.userEntries.splice(i, 1);
    this.save();
    this.changed();
    return true;
  }

  /** @param {any} p */
  async trust(p) {
    const d = await this.find(p && p.id);
    if (d.source !== 'plugin') return d;
    if (d.command) {
      this.trusted[d.id] = d.command;
      this.save();
      this.changed();
    }
    return { ...d, trusted: true };
  }

  // ---- running ----

  /** @param {import('../../shared/protocol').Dashboard} d */
  workDir(d) {
    const dir = d.cwd && fs.existsSync(d.cwd) ? d.cwd : os.homedir();
    return dir;
  }

  childEnv() {
    const env = { ...this.core.env };
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }

  /** @param {any} p @returns {Promise<{url?:string}>} */
  async start(p) {
    const d = await this.find(p && p.id);
    if (d.command && !d.trusted) throw rpcError(ERRORS.NOT_ALLOWED, `${d.name}: the command "${d.command}" has not been trusted yet`);
    if (d.kind === 'url' || d.kind === 'page') return d.url ? { url: d.url } : {};
    if (!d.command) return d.url ? { url: d.url } : {};
    if (d.kind === 'terminal') return this.startTerminal(d);
    if (d.kind === 'web') return this.startWeb(d);
    return this.startApp(d);
  }

  /** @param {import('../../shared/protocol').Dashboard} d @returns {import('child_process').ChildProcess} */
  spawnPlain(d) {
    const spec = spawnSpec(splitCommand(/** @type {string} */ (d.command)), [], { env: this.childEnv(), cwd: this.workDir(d) });
    const c = childSpawn(spec);
    return spawn(c.file, c.args, {
      cwd: this.workDir(d), env: this.childEnv(), windowsHide: true, windowsVerbatimArguments: c.verbatim, argv0: c.argv0,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  /** @param {import('../../shared/protocol').Dashboard} d */
  startTerminal(d) {
    const cur = this.running.get(d.id);
    if (cur && cur.kind === 'terminal' && !cur.exited) return {};
    const { AgentTerminal } = require('./terminal');
    let spec;
    try { spec = spawnSpec(splitCommand(/** @type {string} */ (d.command)), [], { env: this.childEnv(), cwd: this.workDir(d) }); } catch (e) {
      throw rpcError(ERRORS.BAD_REQUEST, /** @type {any} */ (e).message);
    }
    /** @type {import('./terminal').AgentTerminal} */
    let term;
    try {
      term = new AgentTerminal({ file: spec.file, args: spec.args, cwd: this.workDir(d), env: { ...this.childEnv(), TERM: 'xterm-256color' } });
    } catch (e) {
      throw rpcError(ERRORS.INTERNAL, `could not start ${d.name}: ${/** @type {any} */ (e).message}`);
    }
    /** @type {TermRun} */
    const run = { kind: 'terminal', term, exited: false };
    this.running.set(d.id, run);
    term.on('data', (data) => { if (this.running.get(d.id) === run) this.core.emit('dashboard-output', d.id, data); });
    term.on('exit', (code) => {
      run.exited = true;
      this.core.broadcast('dashboard.exit', { id: d.id, code });
    });
    return {};
  }

  /** @param {import('../../shared/protocol').Dashboard} d @returns {Promise<{url:string}>} */
  startWeb(d) {
    const cur = this.running.get(d.id);
    if (cur && cur.kind === 'web' && !cur.exited) return cur.pending || Promise.resolve({ url: cur.url });
    let child;
    try { child = this.spawnPlain(d); } catch (e) { throw rpcError(ERRORS.BAD_REQUEST, /** @type {any} */ (e).message); }
    /** @type {WebRun} */
    const run = { kind: 'web', child, url: '', tail: '', exited: false, pending: null };
    this.running.set(d.id, run);
    run.pending = new Promise((resolve, reject) => {
      let settled = false;
      const done = (/** @type {Error|null} */ err, /** @type {string} */ url = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run.pending = null;
        if (err) { killTree(child); this.running.delete(d.id); reject(err); } else { run.url = url; resolve({ url }); }
      };
      const timer = setTimeout(() => done(rpcError(ERRORS.INTERNAL, `${d.name} did not print a local address within ${Math.round(this.urlTimeoutMs / 1000)} s`)), this.urlTimeoutMs);
      /** @param {Buffer} chunk */
      const onData = (chunk) => {
        run.tail = (run.tail + chunk.toString('utf8')).slice(-OUTPUT_TAIL);
        if (!settled) {
          const url = findLocalUrl(run.tail);
          if (url) done(null, url);
        }
      };
      child.stdout && child.stdout.on('data', onData);
      child.stderr && child.stderr.on('data', onData);
      child.on('error', (e) => done(rpcError(ERRORS.INTERNAL, `could not start ${d.name}: ${e.message}`)));
      child.on('exit', (code) => {
        run.exited = true;
        if (this.running.get(d.id) === run) this.core.broadcast('dashboard.exit', { id: d.id, code: code === null ? -1 : code });
        const last = stripAnsi(run.tail).trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
        done(rpcError(ERRORS.INTERNAL, `${d.name} stopped before it printed a local address (exit ${code})${last ? `: ${last}` : ''}`));
      });
    });
    return run.pending;
  }

  /** @param {import('../../shared/protocol').Dashboard} d */
  async startApp(d) {
    let child;
    try {
      const spec = spawnSpec(splitCommand(/** @type {string} */ (d.command)), [], { env: this.childEnv(), cwd: this.workDir(d) });
      const c = childSpawn(spec);
      child = spawn(c.file, c.args, { cwd: this.workDir(d), env: this.childEnv(), detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: c.verbatim, argv0: c.argv0 });
    } catch (e) {
      throw rpcError(ERRORS.BAD_REQUEST, /** @type {any} */ (e).message);
    }
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (e) => reject(rpcError(ERRORS.INTERNAL, `could not start ${d.name}: ${e.message}`)));
    });
    child.unref();
    return {};
  }

  /** @param {string} id */
  stopRun(id) {
    const run = this.running.get(id);
    if (!run) return false;
    if (run.kind === 'terminal') run.term.kill();
    else killTree(run.child);
    return true;
  }

  /** @param {any} p */
  stop(p) {
    const id = p && p.id;
    if (typeof id !== 'string') throw rpcError(ERRORS.BAD_REQUEST, 'id is required');
    this.stopRun(id);
    return true;
  }

  /** @param {any} p @returns {{replay: string}} */
  attach(p) {
    const id = p && p.id;
    if (typeof id !== 'string' || !id) throw rpcError(ERRORS.BAD_REQUEST, 'id is required');
    this.load();
    const known = this.running.has(id) || this.build().some((d) => d.id === id);
    if (!known) throw rpcError(ERRORS.NOT_FOUND, `no dashboard ${id}`);
    const run = this.running.get(id);
    return { replay: run && run.kind === 'terminal' ? run.term.scrollback.toString() : '' };
  }

  /** @param {any} p */
  termOf(p) {
    const id = p && p.id;
    const run = typeof id === 'string' ? this.running.get(id) : undefined;
    if (!run || run.kind !== 'terminal' || run.exited) throw rpcError(ERRORS.NOT_RUNNING, `dashboard ${id} is not running`);
    return run.term;
  }

  /** @param {any} p */
  input(p) {
    if (!p || typeof p.data !== 'string') throw rpcError(ERRORS.BAD_REQUEST, 'data must be a string');
    this.termOf(p).write(p.data);
    return true;
  }

  /** @param {any} p */
  resize(p) {
    const cols = Math.floor(Number(p && p.cols));
    const rows = Math.floor(Number(p && p.rows));
    if (!(cols >= 2 && cols <= 1000 && rows >= 2 && rows <= 1000)) throw rpcError(ERRORS.BAD_REQUEST, 'cols and rows must be numbers');
    this.termOf(p).resize(cols, rows);
    return true;
  }

  /** Called by core.shutdown(): stop every running dashboard process. */
  shutdown() {
    for (const id of [...this.running.keys()]) this.stopRun(id);
  }
}

module.exports = { Dashboards, isLocalUrl, findLocalUrl, readPluginDashboards, childSpawn };
