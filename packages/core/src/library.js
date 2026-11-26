// @ts-check
'use strict';
/**
 * Library: the user's Claude Code plugins, skills and marketplaces (protocol `library.*`).
 * Owner: the Library track (M2).
 *
 * Contract: packages/shared/protocol.js (LibraryPlugin, LibrarySkill, Library and the library.* methods).
 * Runs `claude plugin ...` with the same claude the agents use (command.js baseCommand / spawnSpec), reads SKILL.md
 * files from <config dir>/skills, <space>/.claude/skills and each plugin's skills/ folder, and emits
 * 'library.changed' through core.broadcast after every rescan and action.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ERRORS } = require('../../shared/protocol');
const { baseCommand, spawnSpec, quoteWinArg } = require('./command');

const MANAGED_SCOPES = new Set(['synced', 'managed', 'builtin', 'policy', 'enterprise']);
const ACTIONS = ['install', 'uninstall', 'update', 'enable', 'disable'];
const SCOPE_ARG = new Set(['user', 'project', 'local']);
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_BYTES = 1024 * 1024;
const TOKEN_JOBS = 2;

function rpcError(code, message) {
  const { RpcError } = require('./core');
  return new RpcError(code, message);
}

/**
 * Parse the YAML front matter of a SKILL.md (flat keys only: `key: value`, quoted values, `>` / `|` blocks).
 * @param {string} text @returns {Record<string, string>}
 */
function parseFrontMatter(text) {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (/^[>|][+-]?$/.test(val)) {
      const fold = val[0] === '>';
      const parts = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) parts.push(lines[++i].trim());
      val = parts.join(fold ? ' ' : '\n').trim();
    } else if ((val.startsWith('"') && val.endsWith('"') && val.length > 1) || (val.startsWith("'") && val.endsWith("'") && val.length > 1)) {
      const q = val[0];
      val = val.slice(1, -1);
      val = q === '"' ? val.replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n') : val.replace(/''/g, "'");
    } else {
      // plain scalar, may continue on indented lines
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s+[A-Za-z0-9_-]+\s*:/.test(lines[i + 1])) val += ` ${lines[++i].trim()}`;
    }
    out[key] = val;
  }
  return out;
}

/** The template for a new skill. @param {string} name */
function skillTemplate(name) {
  return `---\nname: ${name}\ndescription: Describe what this skill does and when Claude should use it.\n---\n\n# ${name}\n\nInstructions for Claude go here.\n`;
}

/** Last JSON object/array printed on stdout (the CLI's --json prints one line; be tolerant of noise before it). @param {string} text */
function parseJsonOutput(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* fall through */ }
  const lines = t.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l || !/^[[{]/.test(l)) continue;
    try { return JSON.parse(l); } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Is version a newer than b? Dotted numbers compare numerically ("1.10.0" > "1.9.2"); a release beats its
 * pre-release ("1.0.0" > "1.0.0-beta"); anything that isn't a version ('unknown', '') is never newer.
 * @param {any} a @param {any} b
 */
function isNewerVersion(a, b) {
  const parse = (/** @type {any} */ v) => {
    const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
    return m ? { nums: m[1].split('.').map(Number), pre: m[2] || '' } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d > 0;
  }
  if (x.pre === y.pre) return false;
  if (!x.pre) return true;  // release > pre-release
  if (!y.pre) return false;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0;
}

/** Pull "Always-on: ~873 tok" (or "~1.2k tok") out of `claude plugin details`. @param {string} text @returns {number|undefined} */
function parseAlwaysOn(text) {
  const m = /Always-on:\s*~?\s*([\d.,]+)\s*(k)?\s*tok/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(m[2] ? n * 1000 : n) : undefined;
}

/** @param {string} file @returns {any} */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/** @param {string} dir @returns {fs.Dirent[]} */
function readDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** @param {string} p */
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
/** @param {string} p */
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/** True when child is inside (or equal to) parent. @param {string} parent @param {string} child */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Names of the markdown files under dir (recursive, depth 3). @param {string} dir @param {number} [depth] @returns {string[]} */
function markdownNames(dir, depth = 3, prefix = '') {
  const out = [];
  for (const e of readDir(dir)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() || (e.isSymbolicLink() && isDir(full))) { if (depth > 0) out.push(...markdownNames(full, depth - 1, `${prefix}${e.name}/`)); }
    else if (/\.md$/i.test(e.name)) out.push(prefix + e.name.replace(/\.md$/i, ''));
  }
  return out.sort();
}

/** @param {string} skillsDir @returns {Array<{dir: string, file: string, name: string, description: string}>} */
function scanSkillsDir(skillsDir) {
  const out = [];
  for (const e of readDir(skillsDir)) {
    const dir = path.join(skillsDir, e.name);
    if (!(e.isDirectory() || (e.isSymbolicLink() && isDir(dir)))) continue;
    const file = path.join(dir, 'SKILL.md');
    if (!isFile(file)) continue;
    let fm = {};
    try { fm = parseFrontMatter(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: still list it */ }
    out.push({ dir: e.name, file, name: fm.name || e.name, description: fm.description || '' });
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** @param {any} v */
function authorName(v) {
  if (!v) return undefined;
  if (typeof v === 'string') return v;
  return typeof v.name === 'string' ? v.name : undefined;
}

class Library {
  /** @param {import('./core').Core|any} core @param {{env?: NodeJS.ProcessEnv}} [opts] */
  constructor(core, opts = {}) {
    this.core = core;
    this.env = opts.env || process.env;
    /** @type {import('../../shared/protocol').Library|null} */
    this.cache = null;
    /** @type {Promise<any>|null} */
    this.scanning = null;
    /** @type {Map<string, number>} id@version → always-on tokens */
    this.tokenCache = new Map();
    /** @type {Set<string>} */
    this.tokenQueued = new Set();
    this.tokenJobs = 0;
    /** @type {string[]} */
    this.tokenQueue = [];
    /** @type {any} */
    this.changedTimer = null;
    this.disposed = false;
  }

  dispose() { this.disposed = true; clearTimeout(this.changedTimer); }

  get configDir() { return this.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }

  // ---- running claude -----------------------------------------------------------------------

  /**
   * Run `claude <args>` and collect the output. Never rejects.
   * @param {string[]} args @param {{input?: string, timeout?: number, cwd?: string}} [opts]
   * @returns {Promise<{code: number|null, stdout: string, stderr: string, error?: string}>}
   */
  run(args, opts = {}) {
    return new Promise((resolve) => {
      let spec;
      try { spec = spawnSpec(baseCommand(this.env), args, { env: this.env }); } catch (e) {
        return resolve({ code: null, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) });
      }
      /** @type {import('child_process').ChildProcess} */
      let child;
      const env = { ...this.env };
      for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
      try {
        const so = { env, cwd: opts.cwd, windowsHide: true, stdio: /** @type {any} */ (['pipe', 'pipe', 'pipe']) };
        child = typeof spec.args === 'string'
          // Windows: a ready-made command line (see command.js spawnSpec).
          ? spawn(spec.file, [spec.args], { ...so, windowsVerbatimArguments: true, argv0: quoteWinArg(spec.file) })
          : spawn(spec.file, spec.args, so);
      } catch (e) {
        return resolve({ code: null, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) });
      }
      let stdout = '';
      let stderr = '';
      let done = false;
      let error;
      const finish = (/** @type {number|null} */ code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, ...(error ? { error } : {}) });
      };
      const timer = setTimeout(() => {
        error = `claude ${args.slice(0, 3).join(' ')} timed out`;
        try { child.kill(); } catch { /* gone */ }
        finish(null);
      }, opts.timeout || 30000);
      if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
      if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => { error = e.message; finish(null); });
      child.on('close', (code) => finish(code));
      if (child.stdin) {
        child.stdin.on('error', () => { /* it exited before reading */ });
        child.stdin.end(opts.input || '');
      }
    });
  }

  // ---- scanning -----------------------------------------------------------------------------

  /** @param {{refresh?: boolean}} [params] */
  async list(params) {
    if (this.cache && !(params && params.refresh)) return this.cache;
    return this.scan();
  }

  /** Rescan everything and broadcast. */
  scan() {
    if (this.scanning) return this.scanning;
    this.scanning = this.doScan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async doScan() {
    /** @type {string[]} */
    const errors = [];
    const [listed, mk] = await Promise.all([
      this.run(['plugin', 'list', '--json']),
      this.run(['plugin', 'marketplace', 'list', '--json']),
    ]);
    /** @type {any[]} */
    let raw = [];
    const lj = parseJsonOutput(listed.stdout);
    if (Array.isArray(lj)) raw = lj;
    else if (lj && Array.isArray(lj.installed)) raw = lj.installed;
    else errors.push(`claude plugin list failed: ${listed.error || listed.stderr.trim() || listed.stdout.trim() || `exit ${listed.code}`}`.slice(0, 300));

    const plugins = raw.filter((p) => p && typeof p.id === 'string').map((p) => this.buildPlugin(p));
    const skills = this.scanSkills(plugins);

    /** @type {any[]} */
    let marketplaces = [];
    const mj = parseJsonOutput(mk.stdout);
    if (Array.isArray(mj)) {
      marketplaces = mj.filter((m) => m && m.name).map((m) => ({
        name: String(m.name),
        source: typeof m.source === 'string' && (m.repo || m.url || m.path) ? (m.repo ? `${m.source}:${m.repo}` : String(m.url || m.path)) : String(m.source || m.repo || m.url || m.path || ''),
        ...(m.lastUpdated ? { lastUpdated: String(m.lastUpdated) } : {}),
      }));
    } else if (!errors.length) {
      errors.push(`claude plugin marketplace list failed: ${mk.error || mk.stderr.trim() || `exit ${mk.code}`}`.slice(0, 300));
    }

    this.cache = { plugins, skills, marketplaces, scannedAt: Date.now(), errors };
    this.applyUpdates();
    this.emitChanged();
    for (const p of plugins) this.queueTokens(p);
    this.checkUpdates();
    return this.cache;
  }

  /** @param {any} p an entry of `claude plugin list --json` @returns {import('../../shared/protocol').LibraryPlugin} */
  buildPlugin(p) {
    const id = String(p.id);
    const at = id.lastIndexOf('@');
    const name = at > 0 ? id.slice(0, at) : id;
    const market = at > 0 ? id.slice(at + 1) : '';
    const scope = String(p.scope || 'user');
    const installPath = typeof p.installPath === 'string' && p.installPath ? p.installPath : undefined;
    const manifest = installPath ? (readJson(path.join(installPath, '.claude-plugin', 'plugin.json')) || readJson(path.join(installPath, 'plugin.json')) || {}) : {};
    const managed = MANAGED_SCOPES.has(scope) || market === 'builtin' || !installPath;
    const components = installPath ? this.scanComponents(installPath, manifest) : { skills: [], agents: [], commands: [], hooks: 0, mcpServers: [] };
    const version = String(p.version || manifest.version || 'unknown');
    /** @type {import('../../shared/protocol').LibraryPlugin} */
    const out = {
      id, name: String(manifest.name || name), version, scope, enabled: p.enabled !== false, managed, components,
    };
    if (installPath) out.installPath = installPath;
    if (typeof manifest.description === 'string') out.description = manifest.description;
    const author = authorName(manifest.author);
    if (author) out.author = author;
    if (typeof manifest.homepage === 'string') out.homepage = manifest.homepage;
    if (typeof manifest.repository === 'string') out.repository = manifest.repository;
    else if (manifest.repository && typeof manifest.repository.url === 'string') out.repository = manifest.repository.url;
    if (market && !MANAGED_SCOPES.has(market)) out.marketplace = market;
    if (installPath && typeof manifest.logo === 'string' && manifest.logo) {
      const logo = path.resolve(installPath, manifest.logo);
      if (isInside(installPath, logo) && isFile(logo)) out.logo = logo;
    }
    const tok = this.tokenCache.get(`${id}@${version}`);
    if (typeof tok === 'number') out.tokens = { alwaysOn: tok }; // null = asked, no number
    if (p.hasUserConfig || manifest.userConfig) out.hasConfig = true;
    if (p.updateAvailable === true || (typeof p.latestVersion === 'string' && p.latestVersion && p.latestVersion !== version)) out.updateAvailable = true;
    return out;
  }

  /** @param {string} root @param {any} manifest */
  scanComponents(root, manifest) {
    const skills = scanSkillsDir(path.join(root, 'skills')).map((s) => s.name);
    const agents = markdownNames(path.join(root, 'agents'));
    const commands = markdownNames(path.join(root, 'commands'));
    let hooks = 0;
    const hj = readJson(path.join(root, 'hooks', 'hooks.json')) || (manifest.hooks && typeof manifest.hooks === 'object' ? manifest.hooks : null);
    const table = hj && (hj.hooks && typeof hj.hooks === 'object' ? hj.hooks : hj);
    if (table && typeof table === 'object') {
      for (const entries of Object.values(table)) {
        if (!Array.isArray(entries)) continue;
        for (const en of entries) hooks += en && Array.isArray(en.hooks) ? en.hooks.length : 1;
      }
    }
    const mj = readJson(path.join(root, '.mcp.json'));
    const servers = (mj && (mj.mcpServers || mj)) || manifest.mcpServers;
    const mcpServers = servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers).filter((k) => servers[k] && typeof servers[k] === 'object') : [];
    return { skills, agents, commands, hooks, mcpServers };
  }

  /** @param {import('../../shared/protocol').LibraryPlugin[]} plugins @returns {import('../../shared/protocol').LibrarySkill[]} */
  scanSkills(plugins) {
    /** @type {import('../../shared/protocol').LibrarySkill[]} */
    const out = [];
    for (const s of scanSkillsDir(path.join(this.configDir, 'skills'))) {
      out.push({ id: `user:${s.dir}`, name: s.name, description: s.description, source: 'user', path: s.file, deletable: true });
    }
    const spaces = this.core && this.core.spaces ? [...this.core.spaces.values()] : [];
    for (const sp of spaces) {
      if (!sp || !sp.path) continue;
      for (const s of scanSkillsDir(path.join(sp.path, '.claude', 'skills'))) {
        out.push({ id: `project:${sp.id}:${s.dir}`, name: s.name, description: s.description, source: 'project', spaceId: sp.id, path: s.file, deletable: true });
      }
    }
    for (const p of plugins) {
      if (!p.installPath) continue;
      for (const s of scanSkillsDir(path.join(p.installPath, 'skills'))) {
        out.push({ id: `plugin:${p.id}:${s.dir}`, name: s.name, description: s.description, source: 'plugin', pluginId: p.id, path: s.file, deletable: false });
      }
    }
    return out;
  }

  // ---- updates: installed version vs the marketplace's (`plugin list --available` has versions) ----

  /** Read marketplace versions in the background (at most every 10 minutes), then mark updates. */
  checkUpdates() {
    if (this.disposed || this.updatesRunning) return;
    if (this.latestVersions && Date.now() - this.latestAt < 10 * 60e3) return;
    this.updatesRunning = true;
    this.run(['plugin', 'list', '--available', '--json'], { timeout: 60000 }).then((r) => {
      const j = parseJsonOutput(r.stdout);
      if (!j || !Array.isArray(j.available)) return;
      /** @type {Map<string, string>} */
      const latest = new Map();
      for (const a of j.available) {
        const id = a && (a.pluginId || a.id);
        if (typeof id === 'string' && typeof a.version === 'string' && a.version) latest.set(id, a.version);
      }
      this.latestVersions = latest;
      this.latestAt = Date.now();
      if (this.applyUpdates()) this.emitChanged();
    }).catch(() => { /* no marketplace info: no badges */ }).finally(() => { this.updatesRunning = false; });
  }

  /** Mark plugins whose marketplace version is newer. @returns {boolean} whether anything changed */
  applyUpdates() {
    if (!this.cache || !this.latestVersions) return false;
    let changed = false;
    for (const p of this.cache.plugins) {
      if (p.managed) continue; // can't be updated here anyway
      const v = this.latestVersions.get(p.id);
      const want = v !== undefined && isNewerVersion(v, p.version);
      if (want && !p.updateAvailable) { p.updateAvailable = true; changed = true; }
      // A plugin the CLI itself reported as outdated keeps its badge.
    }
    return changed;
  }

  // ---- context cost (`claude plugin details` is slow: read it in the background) -----------

  /** @param {import('../../shared/protocol').LibraryPlugin} p */
  queueTokens(p) {
    if (this.disposed) return;
    const key = `${p.id}@${p.version}`;
    if (this.tokenCache.has(key) || this.tokenQueued.has(key)) return;
    this.tokenQueued.add(key);
    this.tokenQueue.push(p.id);
    this.pumpTokens();
  }

  pumpTokens() {
    while (!this.disposed && this.tokenJobs < TOKEN_JOBS && this.tokenQueue.length) {
      const id = /** @type {string} */ (this.tokenQueue.shift());
      this.tokenJobs++;
      this.run(['plugin', 'details', id], { timeout: 60000 }).then((r) => {
        const plugin = this.cache && this.cache.plugins.find((x) => x.id === id);
        const key = plugin ? `${id}@${plugin.version}` : '';
        if (key) this.tokenQueued.delete(key);
        const n = parseAlwaysOn(r.stdout);
        if (plugin && n !== undefined) {
          this.tokenCache.set(key, n);
          plugin.tokens = { alwaysOn: n };
          this.emitChanged();
        } else if (key && r.code === 0) {
          // Answered, but without a number (built-in plugins, some synced ones): remember that too,
          // or every rescan would run `claude plugin details` for it again.
          this.tokenCache.set(key, null);
        }
      }).finally(() => { this.tokenJobs--; this.pumpTokens(); });
    }
  }

  /** Broadcast library.changed (coalesced a little, so a burst of token results is one event). */
  emitChanged() {
    if (this.disposed || !this.cache) return;
    clearTimeout(this.changedTimer);
    this.changedTimer = setTimeout(() => {
      if (this.cache && !this.disposed) this.core.broadcast('library.changed', { library: this.cache });
    }, 60);
    if (this.changedTimer.unref) this.changedTimer.unref();
  }

  // ---- plugins ------------------------------------------------------------------------------

  async available() {
    const r = await this.run(['plugin', 'list', '--available', '--json'], { timeout: 60000 });
    const j = parseJsonOutput(r.stdout);
    if (!j || !Array.isArray(j.available)) throw rpcError(ERRORS.INTERNAL, `claude plugin list --available failed: ${r.error || r.stderr.trim() || `exit ${r.code}`}`.slice(0, 300));
    const installed = new Set((Array.isArray(j.installed) ? j.installed : []).map((/** @type {any} */ p) => p.id));
    for (const p of (this.cache ? this.cache.plugins : [])) installed.add(p.id);
    return j.available.filter((/** @type {any} */ a) => a && (a.pluginId || a.id)).map((/** @type {any} */ a) => {
      const id = String(a.pluginId || a.id);
      return {
        id, name: String(a.name || id.split('@')[0]),
        ...(a.description ? { description: String(a.description) } : {}),
        marketplace: String(a.marketplaceName || a.marketplace || id.split('@')[1] || ''),
        installed: installed.has(id),
      };
    });
  }

  /** @param {{id?: string, action?: string, keepData?: boolean, acceptCommand?: string}} params */
  async pluginAction(params) {
    const p = params || {};
    const id = checkId(p.id, 'plugin id');
    const action = String(p.action || '');
    if (!ACTIONS.includes(action)) throw rpcError(ERRORS.BAD_REQUEST, `unknown action "${action}"`);
    if (p.acceptCommand !== undefined && !/^[0-9a-f]{64}$/i.test(String(p.acceptCommand))) throw rpcError(ERRORS.BAD_REQUEST, 'acceptCommand must be a sha256');
    const lib = this.cache || await this.scan();
    const plugin = lib.plugins.find((x) => x.id === id);
    if (action !== 'install') {
      if (!plugin) throw rpcError(ERRORS.NOT_FOUND, `no plugin ${id}`);
      // Turning a plugin on or off is the user's own setting, even for plugins an organization syncs or that
      // are built in: let `claude` decide and pass on its answer. Removing or replacing them is not theirs.
      if (plugin.managed && action !== 'enable' && action !== 'disable') {
        throw rpcError(ERRORS.NOT_ALLOWED, `${plugin.name} is managed by your organization`);
      }
    }
    const args = ['plugin', action, id, '--json'];
    if (plugin && SCOPE_ARG.has(plugin.scope)) args.push('--scope', plugin.scope);
    if (action === 'uninstall' && p.keepData) args.push('--keep-data');
    if ((action === 'install' || action === 'update') && p.acceptCommand) args.push('--accept-command', String(p.acceptCommand).toLowerCase());
    const r = await this.run(args, { timeout: 180000 });
    const j = parseJsonOutput(r.stdout);
    const obj = j && !Array.isArray(j) && typeof j === 'object' ? j : {};
    const shown = obj.shownCommand;
    if (shown && (action === 'install' || action === 'update') && !(r.code === 0 && obj.ok !== false && !obj.error && !obj.needsConfirmation)) {
      const sha = typeof shown === 'object' ? shown.sha256 : obj.sha256;
      if (typeof sha === 'string' && sha) {
        const command = typeof shown === 'string' ? shown : String(shown.command || shown.text || shown.line || JSON.stringify(shown));
        return { ok: false, message: 'This plugin runs a command to install. Review it, then confirm.', confirm: { command, sha256: sha } };
      }
    }
    const ok = r.code === 0 && obj.ok !== false && !obj.error;
    const detail = String(obj.message || obj.error || (ok ? '' : r.error || r.stderr.trim() || r.stdout.trim()) || '').trim();
    const message = detail || (ok ? `${verb(action)} ${plugin ? plugin.name : id}` : `${action} failed (exit ${r.code})`);
    await this.scan();
    return { ok, message: message.slice(0, 500) };
  }

  /** @param {{id?: string, values?: Record<string, any>}} params */
  async configure(params) {
    const p = params || {};
    const id = checkId(p.id, 'plugin id');
    if (p.values !== undefined) {
      if (!p.values || typeof p.values !== 'object' || Array.isArray(p.values)) throw rpcError(ERRORS.BAD_REQUEST, 'values must be an object');
      const lib = this.cache || await this.scan();
      const plugin = lib.plugins.find((x) => x.id === id);
      if (plugin && plugin.managed) throw rpcError(ERRORS.NOT_ALLOWED, `${plugin.name} is managed by your organization`);
      /** @type {Record<string, string>} */
      const strings = {};
      for (const [k, v] of Object.entries(p.values)) {
        const s = typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : null;
        if (s === null || /[\r\n]/.test(s)) throw rpcError(ERRORS.BAD_REQUEST, `value of "${k}" must be a single-line string`);
        strings[k] = s;
      }
      const w = await this.run(['plugin', 'configure', id, '--values-stdin'], { input: JSON.stringify(strings), timeout: 60000 });
      if (w.code !== 0) throw rpcError(ERRORS.INTERNAL, `could not save: ${w.error || w.stderr.trim() || w.stdout.trim() || `exit ${w.code}`}`.slice(0, 300));
    }
    const r = await this.run(['plugin', 'configure', id, '--json'], { timeout: 60000 });
    const j = parseJsonOutput(r.stdout);
    if (!j || Array.isArray(j)) throw rpcError(ERRORS.INTERNAL, `claude plugin configure failed: ${r.error || r.stderr.trim() || `exit ${r.code}`}`.slice(0, 300));
    if (p.values !== undefined) this.emitChanged();
    return parseConfigure(j);
  }

  /** @param {{action?: string, source?: string, name?: string}} params */
  async marketplace(params) {
    const p = params || {};
    const action = String(p.action || '');
    /** @type {string[]} */
    let args;
    if (action === 'add') args = ['plugin', 'marketplace', 'add', checkId(p.source, 'marketplace source', true)];
    else if (action === 'remove') args = ['plugin', 'marketplace', 'remove', checkId(p.name, 'marketplace name')];
    else if (action === 'update') args = ['plugin', 'marketplace', 'update', ...(p.name ? [checkId(p.name, 'marketplace name')] : [])];
    else throw rpcError(ERRORS.BAD_REQUEST, `unknown marketplace action "${action}"`);
    this.latestAt = 0; // marketplace versions may change: check updates again on the next scan
    const r = await this.run(args, { timeout: 180000 });
    const ok = r.code === 0;
    const text = (r.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || r.stderr.trim() || r.error || '').slice(0, 500);
    await this.scan();
    return { ok, message: text || (ok ? `${action}: done` : `${action} failed (exit ${r.code})`) };
  }

  // ---- skills -------------------------------------------------------------------------------

  /** @param {string} id @returns {Promise<import('../../shared/protocol').LibrarySkill>} */
  async knownSkill(id) {
    if (typeof id !== 'string' || !id) throw rpcError(ERRORS.BAD_REQUEST, 'id is required');
    const lib = this.cache || await this.scan();
    const sk = lib.skills.find((s) => s.id === id);
    if (!sk) throw rpcError(ERRORS.NOT_FOUND, `no skill ${id}`);
    return sk;
  }

  /** @param {{id?: string}} params */
  async skillRead(params) {
    const sk = await this.knownSkill(/** @type {string} */ (params && params.id));
    try { return { content: fs.readFileSync(sk.path, 'utf8') }; } catch (e) {
      throw rpcError(ERRORS.NOT_FOUND, `cannot read ${sk.name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** @param {{id?: string, scope?: string, spaceId?: string, name?: string, content?: string}} params */
  async skillWrite(params) {
    const p = params || {};
    if (p.content !== undefined && typeof p.content !== 'string') throw rpcError(ERRORS.BAD_REQUEST, 'content must be text');
    if (p.content && Buffer.byteLength(p.content) > MAX_SKILL_BYTES) throw rpcError(ERRORS.BAD_REQUEST, 'skill is too large (1 MB max)');
    let file;
    let id;
    if (p.id) {
      const sk = await this.knownSkill(p.id);
      if (!sk.deletable || sk.source === 'plugin') throw rpcError(ERRORS.NOT_ALLOWED, 'plugin skills can not be edited (they come back on update)');
      if (typeof p.content !== 'string') throw rpcError(ERRORS.BAD_REQUEST, 'content is required');
      file = sk.path;
      id = sk.id;
    } else {
      const scope = String(p.scope || '');
      const name = String(p.name || '');
      if (!SKILL_NAME.test(name)) throw rpcError(ERRORS.BAD_REQUEST, 'skill name: lowercase letters, digits and dashes only (max 64)');
      let base;
      if (scope === 'user') {
        base = path.join(this.configDir, 'skills');
        id = `user:${name}`;
      } else if (scope === 'project') {
        const sp = this.core.spaces && this.core.spaces.get(String(p.spaceId || ''));
        if (!sp) throw rpcError(ERRORS.NOT_FOUND, `no space ${p.spaceId}`);
        base = path.join(sp.path, '.claude', 'skills');
        id = `project:${sp.id}:${name}`;
      } else throw rpcError(ERRORS.BAD_REQUEST, 'scope must be user or project');
      const folder = path.join(base, name);
      if (path.dirname(path.resolve(folder)) !== path.resolve(base)) throw rpcError(ERRORS.BAD_REQUEST, 'bad skill name');
      file = path.join(folder, 'SKILL.md');
      if (fs.existsSync(folder)) throw rpcError(ERRORS.BAD_REQUEST, `a skill named ${name} already exists`);
      fs.mkdirSync(folder, { recursive: true });
    }
    const content = p.content && p.content.trim() ? p.content : skillTemplate(String(p.name || ''));
    try { fs.writeFileSync(file, content, 'utf8'); } catch (e) {
      throw rpcError(ERRORS.INTERNAL, `could not save: ${e instanceof Error ? e.message : e}`);
    }
    const lib = await this.scan();
    const sk = lib.skills.find((s) => s.id === id);
    if (!sk) throw rpcError(ERRORS.INTERNAL, 'saved, but the skill did not show up after a rescan');
    return sk;
  }
}

/** @param {string} action */
function verb(action) {
  return { install: 'Installed', uninstall: 'Uninstalled', update: 'Updated', enable: 'Enabled', disable: 'Disabled' }[action] || action;
}

/** A plugin id / name / source: non-empty, one line, never an option. @param {any} v @param {string} what @param {boolean} [allowPath] */
function checkId(v, what, allowPath = false) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw rpcError(ERRORS.BAD_REQUEST, `${what} is required`);
  if (s.startsWith('-') || /[\r\n\0]/.test(s) || s.length > 500 || (!allowPath && !/^[A-Za-z0-9._@:+/-]+$/.test(s))) throw rpcError(ERRORS.BAD_REQUEST, `bad ${what}`);
  return s;
}

/**
 * `claude plugin configure --json` → { options, values }. The CLI prints { schema, inputs, choices, configured, unconfigured };
 * we accept a JSON-schema ({properties}) or a plain map of option → definition.
 * @param {any} j
 */
function parseConfigure(j) {
  const schema = j.schema && typeof j.schema === 'object' ? j.schema : {};
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : schema;
  const choices = j.choices && typeof j.choices === 'object' ? j.choices : {};
  const options = [];
  for (const [key, def] of Object.entries(props)) {
    if (!def || typeof def !== 'object') continue;
    const d = /** @type {any} */ (def);
    const list = Array.isArray(d.enum) ? d.enum : Array.isArray(d.options) ? d.options : Array.isArray(choices[key]) ? choices[key] : undefined;
    options.push({
      key, ...(d.title || d.name ? { title: String(d.title || d.name) } : {}), ...(d.description ? { description: String(d.description) } : {}),
      type: String(d.type || 'string'), ...(d.default !== undefined ? { default: d.default } : {}), ...(list ? { options: list } : {}),
    });
  }
  const values = j.inputs && typeof j.inputs === 'object' ? j.inputs : j.values && typeof j.values === 'object' ? j.values : {};
  return { options, values };
}

module.exports = { Library, parseFrontMatter, parseAlwaysOn, parseJsonOutput, parseConfigure, skillTemplate, isNewerVersion };
