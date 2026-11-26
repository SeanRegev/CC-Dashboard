// @ts-check
'use strict';
/**
 * Claude Code sessions running on this computer that CC-Dashboard did not start (contract v3).
 * Owner: the Outside sessions track (docs/M3.md). Read from Claude's running-session files
 * (<claude config>/sessions/<pid>.json) and transcripts: no model call, no tokens.
 * external.takeOver ends the outside process and resumes the same conversation as an agent here.
 *
 * Ending a process is the dangerous part. Before anything is signalled, takeOver re-reads the
 * registry file (same pid and sessionId), checks the process is alive and looks like that Claude
 * (command line / image name, and its start time where the platform gives one), and only then ends it.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ERRORS, SUBAGENT_TYPES } = require('../../shared/protocol');
const { RpcError } = require('./errors');
const { newParseState, parseLine, findTranscript, parseMeta, TranscriptTail, parseJsonLines, MAX_TEXT } = require('./transcript');

/** Entries kept in memory per outside session (the transcript is the record). */
const MAX_LOG = 2000;
/** A process that started this long after the session's startedAt is not that session (pid reused). */
const START_SLACK_MS = 60_000;
/** Look for a missing transcript in every project folder at most this often. */
const SCAN_TRANSCRIPT_MS = 10_000;

/**
 * @typedef {import('./types').ActivityEntry} ActivityEntry
 * @typedef {import('./types').Subagent} Subagent
 * @typedef {Omit<ActivityEntry, 'seq'>} RawEntry
 * @typedef {{pid: number, sessionId: string, cwd: string, status: string, name: string, entrypoint: string,
 *            version: string, kind: string, startedAt: number, updatedAt: number, procStart: string}} Registry
 * @typedef {{argv?: string[], command?: string, image?: string, procStart?: string, startMs?: number}} ProcInfo
 * @typedef {{
 *   alive: (pid: number) => boolean,
 *   identity: (pid: number) => Promise<ProcInfo|null>,
 *   signal: (pid: number, sig: 'SIGTERM'|'SIGKILL') => void,
 *   taskkill: (pid: number) => Promise<void>,
 * }} Sys
 * @typedef {{sub: Subagent, tail: TranscriptTail|null, st: import('./transcript').ParseState, metaFile: string,
 *            metaMtime: number, meta: ReturnType<typeof parseMeta>, announced: boolean}} SubRec
 * @typedef {{id: string, file: string, reg: Registry, transcript: string, lastFind: number, tail: TranscriptTail|null,
 *            st: import('./transcript').ParseState, log: ActivityEntry[], seq: number, subs: Map<string, SubRec>,
 *            notesSeen: number}} Rec
 */

function envNumber(env, name, fallback) {
  const v = Number(env[name]);
  return env[name] !== undefined && env[name] !== '' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** @param {any} v @returns {string} */
const str = (v) => (typeof v === 'string' ? v : '');
/** @param {any} v @returns {number} */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * One running-session file, read defensively (Claude's internal format). null when it is not one.
 * @param {any} obj @returns {Registry|null}
 */
function parseRegistry(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const { pid, sessionId, cwd } = obj;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (typeof sessionId !== 'string' || !/^[\w-]{1,128}$/.test(sessionId)) return null;
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  return {
    pid, sessionId, cwd,
    status: str(obj.status), name: str(obj.name).slice(0, 200), entrypoint: str(obj.entrypoint).slice(0, 60),
    version: str(obj.version).slice(0, 60), kind: str(obj.kind),
    startedAt: num(obj.startedAt), updatedAt: Math.max(num(obj.updatedAt), num(obj.statusUpdatedAt)),
    procStart: typeof obj.procStart === 'string' || typeof obj.procStart === 'number' ? String(obj.procStart) : '',
  };
}

/** Registry status → ExternalSession state. @param {string} status @returns {'working'|'idle'|'needs_you'|'unknown'} */
function stateOf(status) {
  const s = String(status || '').toLowerCase();
  if (!s) return 'unknown';
  if (/^(busy|working|running|thinking|streaming|responding)$/.test(s)) return 'working';
  if (/^(idle|ready)$/.test(s)) return 'idle';
  if (/wait|permission|approv|input|blocked|needs|prompt|ask/.test(s)) return 'needs_you';
  return 'unknown';
}

/**
 * Is child the folder parent or inside it? Case-insensitive with either slash on Windows.
 * @param {string} child @param {string} parent @param {NodeJS.Platform} [platform]
 */
function pathInside(child, parent, platform = process.platform) {
  if (!child || !parent) return false;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const norm = (/** @type {string} */ x) => {
    let n = p.resolve(win ? x.replace(/\//g, '\\') : x);
    if (win) n = n.toLowerCase();
    return n.length > 1 && n.endsWith(p.sep) && !/^[a-z]:\\$/i.test(n) ? n.slice(0, -1) : n;
  };
  const c = norm(child);
  const par = norm(parent);
  if (c === par) return true;
  return c.startsWith(par.endsWith(p.sep) ? par : par + p.sep);
}

/**
 * The space whose folder is cwd or contains it (the deepest one wins).
 * @param {Iterable<{id: string, path: string}>} spaces @param {string} cwd @param {NodeJS.Platform} [platform]
 */
function matchSpace(spaces, cwd, platform = process.platform) {
  let best = null;
  for (const s of spaces) {
    if (!s || typeof s.path !== 'string' || !pathInside(cwd, s.path, platform)) continue;
    if (!best || s.path.length > best.path.length) best = s;
  }
  return best;
}

/** First field of `tasklist /FO CSV /NH` for that pid, or ''. @param {string} text @param {number} pid */
function parseTasklist(text, pid) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
    if (fields.length >= 2 && Number(fields[1].replace(/[^\d]/g, '')) === pid) return fields[0];
  }
  return '';
}

/** starttime (field 22) of /proc/<pid>/stat, or ''. @param {string} text */
function parseProcStat(text) {
  const t = String(text || '');
  const close = t.lastIndexOf(')');
  if (close < 0) return '';
  const fields = t.slice(close + 2).split(' ');
  // fields[0] is field 3 (state); starttime is field 22.
  const v = fields[19];
  return v && /^\d+$/.test(v) ? v : '';
}

/** Does the process look like Claude Code (the native binary, or node / bun running Claude)? @param {ProcInfo|null} info */
function looksLikeClaude(info) {
  if (!info) return false;
  const first = (info.argv && info.argv[0]) || info.image || '';
  const exe = first.split(/[\\/]/).pop()?.toLowerCase().replace(/\.(exe|cmd|bat)$/, '') || '';
  if (exe.includes('claude')) return true;
  if (!/^(node|nodejs|bun)$/.test(exe)) return false;
  return /claude/i.test(info.command || '');
}

/**
 * Is the process (info, read now) the Claude session the registry describes?
 * @param {Registry} reg @param {ProcInfo|null} info @param {NodeJS.Platform} [platform]
 * @returns {{ok: boolean, reason: string}}
 */
function confirmIdentity(reg, info, platform = process.platform) {
  if (!info) return { ok: false, reason: `could not read process ${reg.pid}` };
  if (!looksLikeClaude(info)) {
    const what = (info.argv && info.argv[0]) || info.image || 'unknown';
    return { ok: false, reason: `process ${reg.pid} does not look like Claude Code (${path.basename(what)})` };
  }
  if (platform === 'linux' && /^\d+$/.test(reg.procStart) && info.procStart && info.procStart !== reg.procStart) {
    return { ok: false, reason: `process ${reg.pid} is not the one that started this session (start time differs)` };
  }
  if (info.startMs && reg.startedAt && info.startMs > reg.startedAt + START_SLACK_MS) {
    return { ok: false, reason: `process ${reg.pid} started after this session did: it is another process` };
  }
  return { ok: true, reason: '' };
}

/** @param {string} file @param {string[]} args @returns {Promise<string>} stdout ('' on failure) */
function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/** @param {number} pid */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === 'EPERM'; }
}

/** Read what the OS says about a process. @param {number} pid @param {NodeJS.Platform} platform @returns {Promise<ProcInfo|null>} */
async function readIdentity(pid, platform) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') {
    const image = parseTasklist(await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']), pid);
    if (!image) return null;
    /** @type {ProcInfo} */
    const info = { image };
    // Command line and start time, when PowerShell can tell (it can't always: policies, old systems).
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { @{ c = $p.CommandLine; s = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }`;
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
    try {
      const o = JSON.parse(out.trim());
      if (o && typeof o.c === 'string') info.command = o.c;
      if (o && Number.isFinite(o.s)) info.startMs = o.s;
    } catch { /* image name only */ }
    return info;
  }
  if (platform === 'linux') {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (!argv.length) return null; // a zombie or kernel thread
      let procStart = '';
      try { procStart = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { /* ignore */ }
      return { argv, command: argv.join(' '), procStart };
    } catch {
      return null;
    }
  }
  const command = (await run('ps', ['-p', String(pid), '-o', 'command='])).trim();
  if (!command) return null;
  const comm = (await run('ps', ['-p', String(pid), '-o', 'comm='])).trim();
  const lstart = Date.parse((await run('ps', ['-p', String(pid), '-o', 'lstart='])).trim());
  /** @type {ProcInfo} */
  const info = { argv: [comm || command.split(/\s+/)[0]], command };
  if (Number.isFinite(lstart)) info.startMs = lstart;
  return info;
}

/** @param {NodeJS.Platform} platform @returns {Sys} */
function realSys(platform) {
  return {
    alive: pidAlive,
    identity: (pid) => readIdentity(pid, platform),
    signal: (pid, sig) => { try { process.kill(pid, sig); } catch { /* gone */ } },
    taskkill: async (pid) => { await run('taskkill', ['/PID', String(pid), '/T', '/F']); },
  };
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} type */
function typeLabel(type) {
  const t = SUBAGENT_TYPES.find((x) => x.id === type);
  return t ? t.label : type;
}

class External {
  /**
   * @param {import('./core').Core} core
   * @param {{sys?: Partial<Sys>, platform?: NodeJS.Platform}} [opts]  tests replace the OS calls
   */
  constructor(core, opts = {}) {
    this.core = core;
    this.platform = opts.platform || process.platform;
    /** @type {Sys} */
    this.sys = { ...realSys(this.platform), ...(opts.sys || {}) };
    /** @type {Map<string, Rec>} by ExternalSession id */
    this.sessions = new Map();
    /** @type {Set<string>} sessions being taken over */
    this.taking = new Set();
    /** @type {NodeJS.Timeout|null} */ this.pollTimer = null;
    /** @type {NodeJS.Timeout|null} */ this.tailTimer = null;
    /** @type {NodeJS.Timeout|null} */ this.watchTimer = null;
    /** @type {fs.FSWatcher|null} */ this.watcher = null;
    this.lastJson = '[]';
    this.changePending = false;
    this.running = false;
  }

  get env() { return this.core.env || process.env; }

  /** Claude's config folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
  get configDir() { return this.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }

  get sessionsDir() { return path.join(this.configDir, 'sessions'); }

  /** Called from Core.start(). */
  start() {
    if (this.running) return;
    this.running = true;
    this.pollMs = Math.max(50, envNumber(this.env, 'CC_EXTERNAL_POLL_MS', 2000));
    this.fastMs = Math.max(50, envNumber(this.env, 'CC_EXTERNAL_TAIL_MS', 1000));
    this.termMs = envNumber(this.env, 'CC_TAKEOVER_TERM_MS', 3000);
    this.waitMs = envNumber(this.env, 'CC_TAKEOVER_WAIT_MS', 10_000);
    this.safeScan();
    this.pollTimer = setInterval(() => this.safeScan(), this.pollMs);
    this.pollTimer.unref();
    this.scheduleTail();
  }

  /** Called from Core.shutdown(). */
  shutdown() {
    this.running = false;
    for (const t of [this.pollTimer, this.tailTimer, this.watchTimer]) if (t) clearTimeout(t);
    this.pollTimer = this.tailTimer = this.watchTimer = null;
    this.closeWatcher();
  }

  closeWatcher() {
    if (this.watcher) try { this.watcher.close(); } catch { /* ignore */ }
    this.watcher = null;
  }

  /** fs.watch the sessions folder once it exists (the poll covers platforms where watching fails). */
  ensureWatcher() {
    if (this.watcher || !this.running) return;
    try {
      this.watcher = fs.watch(this.sessionsDir, () => {
        if (this.watchTimer) return;
        this.watchTimer = setTimeout(() => { this.watchTimer = null; this.safeScan(); }, 50);
        this.watchTimer.unref();
      });
      this.watcher.on('error', () => this.closeWatcher());
      // @ts-ignore unref exists on FSWatcher since Node 14.3
      if (typeof this.watcher.unref === 'function') this.watcher.unref();
    } catch {
      this.watcher = null;
    }
  }

  safeScan() {
    try { this.scan(); } catch { /* a bad file never stops discovery */ }
  }

  /** Our own sessions: every agent's sessionId and the pids of the processes we run. */
  ownSessions() {
    const ids = new Set();
    const pids = new Set([process.pid]);
    for (const a of this.core.agents.values()) if (a && a.sessionId) ids.add(a.sessionId);
    for (const t of this.core.terms.values()) if (t && t.pid) pids.add(t.pid);
    return { ids, pids };
  }

  /**
   * Read the registry folder and bring the session list up to date.
   * @returns {boolean} something changed
   */
  scan() {
    if (!this.running) return false;
    this.ensureWatcher();
    let names = [];
    try { names = fs.readdirSync(this.sessionsDir); } catch { names = []; }
    const own = this.ownSessions();
    /** @type {Map<string, {file: string, reg: Registry}>} */
    const found = new Map();
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const file = path.join(this.sessionsDir, n);
      const reg = this.readRegistry(file);
      if (!reg || own.ids.has(reg.sessionId) || own.pids.has(reg.pid)) continue;
      if (!this.sys.alive(reg.pid) || !this.sameProcessCheap(reg)) continue;
      const id = `ext:${reg.sessionId}`;
      const prev = found.get(id);
      if (!prev || reg.updatedAt > prev.reg.updatedAt) found.set(id, { file, reg });
    }
    let changed = false;
    for (const id of [...this.sessions.keys()]) {
      if (!found.has(id) && !this.taking.has(id)) { this.sessions.delete(id); changed = true; }
    }
    for (const [id, { file, reg }] of found) {
      let rec = this.sessions.get(id);
      if (!rec) {
        rec = {
          id, file, reg, transcript: '', lastFind: 0, tail: null, st: newParseState(), log: [], seq: 0,
          subs: new Map(), notesSeen: 0,
        };
        this.sessions.set(id, rec);
        this.append(rec, this.tailSession(rec).entries); // the backlog, quietly: clients ask activity.list for it
        changed = true;
        continue;
      }
      const before = stateOf(rec.reg.status);
      rec.file = file;
      rec.reg = reg;
      const after = stateOf(reg.status);
      if (before !== after) {
        this.tailAndPublish(rec);
        if (before === 'working' && after !== 'working' && rec.st.lastText) {
          this.publish(rec, [{ at: Date.now(), subagentId: '', kind: 'turn_end', text: rec.st.lastText }], []);
        }
        this.scheduleTail(); // working ↔ idle changes the tail speed
      }
    }
    // Fields (status, name, updatedAt) may have changed too: the list is compared before it is sent.
    this.scheduleChanged();
    return changed;
  }

  /** @param {string} file @returns {Registry|null} */
  readRegistry(file) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (text.length > 1024 * 1024) return null;
      return parseRegistry(JSON.parse(text));
    } catch {
      return null;
    }
  }

  /**
   * A quick check that the pid in a registry file is still the process that wrote it, where that is
   * cheap (Linux: the start time in /proc). Elsewhere a live pid is taken at its word for listing;
   * takeOver checks properly.
   * @param {Registry} reg
   */
  sameProcessCheap(reg) {
    if (this.platform !== 'linux' || !/^\d+$/.test(reg.procStart)) return true;
    try {
      const now = parseProcStat(fs.readFileSync(`/proc/${reg.pid}/stat`, 'utf8'));
      return !now || now === reg.procStart;
    } catch {
      return true;
    }
  }

  // ---- transcripts --------------------------------------------------------------------------

  scheduleTail() {
    if (!this.running) return;
    if (this.tailTimer) clearTimeout(this.tailTimer);
    const working = [...this.sessions.values()].some((r) => stateOf(r.reg.status) === 'working');
    this.tailTimer = setTimeout(() => {
      this.tailTimer = null;
      for (const rec of this.sessions.values()) {
        try { this.tailAndPublish(rec); } catch { /* next time */ }
      }
      this.scheduleChanged();
      this.scheduleTail();
    }, working ? this.fastMs : this.fastMs * 3);
    this.tailTimer.unref();
  }

  /** @param {Rec} rec */
  tailAndPublish(rec) {
    const { entries, subs } = this.tailSession(rec);
    if (entries.length || subs.length) this.publish(rec, entries, subs);
  }

  /**
   * Give entries their seq, keep them, and send the events.
   * @param {Rec} rec @param {RawEntry[]} raw @param {Subagent[]} subs
   */
  publish(rec, raw, subs) {
    const entries = this.append(rec, raw);
    if (entries.length) this.core.broadcast('activity', { agentId: rec.id, entries });
    for (const s of subs) this.core.broadcast('subagent.updated', { agentId: rec.id, subagent: { ...s } });
  }

  /** @param {Rec} rec @param {RawEntry[]} raw @returns {ActivityEntry[]} */
  append(rec, raw) {
    const sorted = raw.map((e, i) => ({ e, i })).sort((a, b) => a.e.at - b.e.at || a.i - b.i).map((x) => x.e);
    const out = sorted.map((e) => /** @type {ActivityEntry} */ ({ seq: ++rec.seq, ...e }));
    rec.log.push(...out);
    if (rec.log.length > MAX_LOG) rec.log.splice(0, rec.log.length - MAX_LOG);
    return out;
  }

  /**
   * Read what is new in a session's transcript and its subagents' files.
   * @param {Rec} rec @returns {{entries: RawEntry[], subs: Subagent[]}}
   */
  tailSession(rec) {
    /** @type {RawEntry[]} */
    const entries = [];
    /** @type {Map<string, Subagent>} */
    const changedSubs = new Map();
    const now = Date.now();
    if (!rec.transcript) {
      const scan = now - rec.lastFind > SCAN_TRANSCRIPT_MS;
      if (scan) rec.lastFind = now;
      rec.transcript = findTranscript(this.configDir, rec.reg.cwd, rec.reg.sessionId, { scan });
      if (!rec.transcript) return { entries, subs: [] };
      rec.tail = new TranscriptTail(rec.transcript);
    }
    const tail = /** @type {TranscriptTail} */ (rec.tail);
    const { lines, reset } = tail.read();
    if (reset) rec.st = newParseState();
    for (const obj of lines) entries.push(...parseLine(obj, rec.st, { now }));

    // Subagents: <dir>/<sessionId>/subagents/agent-<id>.meta.json + agent-<id>.jsonl
    const subDir = path.join(path.dirname(rec.transcript), rec.reg.sessionId, 'subagents');
    let names = [];
    try { names = fs.readdirSync(subDir); } catch { names = []; }
    const ids = new Set();
    for (const n of names) {
      const m = /^agent-([\w-]{1,128})\.(meta\.json|jsonl)$/.exec(n);
      if (m) ids.add(m[1]);
    }
    for (const sid of ids) {
      const changed = this.tailSubagent(rec, subDir, sid, entries, now);
      if (changed) changedSubs.set(sid, changed);
    }
    // Task notifications in the main transcript end background subagents (completed / failed / stopped).
    while (rec.notesSeen < rec.st.notifications.length) {
      const n = rec.st.notifications[rec.notesSeen++];
      const sr = rec.subs.get(n.taskId) || [...rec.subs.values()].find((x) => x.meta && x.meta.toolUseId && x.meta.toolUseId === n.toolUseId);
      if (!sr || sr.sub.state !== 'running') continue;
      const state = /fail|error/i.test(n.status) ? 'failed' : /kill|stop|cancel/i.test(n.status) ? 'stopped' : 'done';
      this.endSubagent(rec, sr, state, n.at, entries);
      changedSubs.set(sr.sub.id, sr.sub);
    }
    return { entries, subs: [...changedSubs.values()] };
  }

  /**
   * @param {Rec} rec @param {string} dir @param {string} sid @param {RawEntry[]} entries @param {number} now
   * @returns {Subagent|null} the subagent when it changed
   */
  tailSubagent(rec, dir, sid, entries, now) {
    const metaFile = path.join(dir, `agent-${sid}.meta.json`);
    const jsonl = path.join(dir, `agent-${sid}.jsonl`);
    let sr = rec.subs.get(sid);
    let changed = false;
    let metaMtime = 0;
    try { metaMtime = fs.statSync(metaFile).mtimeMs; } catch { metaMtime = 0; }
    if (!sr) {
      sr = {
        sub: { id: sid, agentId: rec.id, title: '', type: '', state: 'running', background: false, counts: { tools: 0, errors: 0 }, startedAt: 0, updatedAt: now },
        tail: new TranscriptTail(jsonl), st: newParseState(), metaFile, metaMtime: -1, meta: null, announced: false,
      };
      rec.subs.set(sid, sr);
      changed = true;
    }
    const sub = sr.sub;
    if (metaMtime !== sr.metaMtime) {
      sr.metaMtime = metaMtime;
      let meta = null;
      try { meta = parseMeta(JSON.parse(fs.readFileSync(metaFile, 'utf8'))); } catch { meta = null; }
      if (meta) { sr.meta = meta; changed = true; }
    }
    const { lines, reset } = /** @type {TranscriptTail} */ (sr.tail).read();
    if (reset) sr.st = newParseState();
    /** @type {RawEntry[]} */
    const own = [];
    for (const obj of lines) {
      if (!sub.startedAt && obj && typeof obj.timestamp === 'string' && Number.isFinite(Date.parse(obj.timestamp))) sub.startedAt = Date.parse(obj.timestamp);
      own.push(...parseLine(obj, sr.st, { subagentId: sid, now }));
    }

    // Title and type: meta.json, else the Agent call that started it, else the type's label.
    const call = this.agentCallFor(rec, sid, sr.meta);
    const type = (sr.meta && sr.meta.type) || (call && call.type) || sub.type;
    const title = (sr.meta && sr.meta.description) || (call && call.description) || sub.title || typeLabel(type) || 'Subagent';
    const background = Boolean((sr.meta && sr.meta.background) || (call && call.background));
    if (type !== sub.type || title !== sub.title || background !== sub.background) {
      Object.assign(sub, { type, title, background });
      changed = true;
    }
    if (!sub.startedAt) sub.startedAt = metaMtime || now;
    if (!sr.announced) {
      sr.announced = true;
      entries.push({ at: sub.startedAt, subagentId: sid, kind: 'subagent_start', text: sub.title, type: sub.type });
    }
    if (own.length) {
      entries.push(...own);
      changed = true;
    }
    const counts = { tools: sr.st.tools, errors: sr.st.errors };
    if (counts.tools !== sub.counts.tools || counts.errors !== sub.counts.errors) { sub.counts = counts; changed = true; }
    if (sub.state === 'running') {
      const pending = [...sr.st.pending.values()].pop();
      const tool = pending ? pending.tool : '';
      const detail = pending ? pending.detail : '';
      if ((sub.tool || '') !== tool || (sub.detail || '') !== detail) {
        if (tool) { sub.tool = tool; sub.detail = detail; } else { delete sub.tool; delete sub.detail; }
        changed = true;
      }
      if (sr.meta && sr.meta.finished) {
        this.endSubagent(rec, sr, 'done', metaMtime || now, entries);
        changed = true;
      }
    }
    if (changed) sub.updatedAt = Math.max(sub.updatedAt, ...own.map((e) => e.at), sub.endedAt || 0);
    return changed ? sub : null;
  }

  /** The Agent tool call that started subagent sid, from the main transcript. */
  agentCallFor(rec, sid, meta) {
    if (meta && meta.toolUseId && rec.st.agentCalls.has(meta.toolUseId)) return rec.st.agentCalls.get(meta.toolUseId);
    for (const [toolUseId, agentId] of rec.st.agentIds) if (agentId === sid) return rec.st.agentCalls.get(toolUseId) || null;
    return null;
  }

  /**
   * @param {Rec} rec @param {SubRec} sr @param {'done'|'failed'|'stopped'} state @param {number} at @param {RawEntry[]} entries
   */
  endSubagent(rec, sr, state, at, entries) {
    void rec;
    const sub = sr.sub;
    sub.state = state;
    sub.endedAt = at;
    sub.updatedAt = Math.max(sub.updatedAt, at);
    delete sub.tool;
    delete sub.detail;
    if (sr.st.lastText) sub.summary = sr.st.lastText.slice(0, MAX_TEXT);
    /** @type {RawEntry} */
    const e = { at, subagentId: sub.id, kind: 'subagent_end' };
    if (sub.summary) e.text = sub.summary;
    entries.push(e);
  }

  // ---- the list -----------------------------------------------------------------------------

  /** @param {Rec} rec */
  toSession(rec) {
    const r = rec.reg;
    const subs = [...rec.subs.values()].map((x) => x.sub);
    const last = rec.log.length ? rec.log[rec.log.length - 1].at : 0;
    /** @type {any} */
    const s = {
      id: rec.id,
      sessionId: r.sessionId,
      pid: r.pid,
      cwd: r.cwd,
      name: r.name || path.basename(r.cwd) || r.cwd,
      state: stateOf(r.status),
      startedAt: r.startedAt || 0,
      updatedAt: Math.max(r.updatedAt, r.startedAt, last),
      subagents: { running: subs.filter((x) => x.state === 'running').length, total: subs.length },
    };
    const space = matchSpace(this.core.spaces.values(), r.cwd, this.platform);
    if (space) s.spaceId = space.id;
    if (rec.st.lastTool) {
      s.tool = rec.st.lastTool.tool;
      if (rec.st.lastTool.detail) s.detail = rec.st.lastTool.detail;
    }
    if (rec.st.lastPrompt) s.lastPrompt = rec.st.lastPrompt;
    if (r.entrypoint) s.entrypoint = r.entrypoint;
    if (r.version) s.version = r.version;
    return s;
  }

  /** @returns {any[]} ExternalSession[] */
  list() {
    return [...this.sessions.values()].map((r) => this.toSession(r));
  }

  /** external.changed, at most once per tick, only when the list differs from the last one sent. */
  scheduleChanged() {
    if (this.changePending) return;
    this.changePending = true;
    setImmediate(() => {
      this.changePending = false;
      this.emitChangedNow();
    });
  }

  emitChangedNow() {
    const sessions = this.list();
    const json = JSON.stringify(sessions);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.core.broadcast('external.changed', { sessions });
  }

  /** @param {any} p @returns {Rec} */
  need(p) {
    const id = p && p.agentId;
    const rec = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (!rec) throw new RpcError(ERRORS.NOT_FOUND, `no outside session ${id}`);
    return rec;
  }

  /** @param {{agentId: string}} p */
  subagentsList(p) {
    const rec = this.need(p);
    return [...rec.subs.values()].map((x) => ({ ...x.sub, counts: { ...x.sub.counts } })).sort((a, b) => a.startedAt - b.startedAt);
  }

  /** @param {{agentId: string, subagentId?: string, before?: number, limit?: number}} p */
  activityList(p) {
    const rec = this.need(p);
    let log = rec.log;
    if (typeof p.subagentId === 'string') log = log.filter((e) => e.subagentId === p.subagentId);
    if (typeof p.before === 'number') log = log.filter((e) => e.seq < /** @type {number} */ (p.before));
    const n = Number(p.limit);
    const limit = Number.isFinite(n) && n >= 1 ? Math.min(1000, Math.floor(n)) : 200;
    return { entries: log.slice(-limit).map((e) => ({ ...e })), more: log.length > limit };
  }

  // ---- take over ----------------------------------------------------------------------------

  /**
   * End the outside process and resume its conversation as an agent here.
   * @param {{id: string, spaceId?: string, name?: string, force?: boolean}} p
   */
  async takeOver(p) {
    if (!p || typeof p.id !== 'string' || !p.id.startsWith('ext:')) throw new RpcError(ERRORS.BAD_REQUEST, 'id must be an outside session id ("ext:...")');
    for (const k of ['spaceId', 'name']) {
      const v = /** @type {any} */ (p)[k];
      if (v !== undefined && v !== null && typeof v !== 'string') throw new RpcError(ERRORS.BAD_REQUEST, `${k} must be a string`);
    }
    if (p.force !== undefined && p.force !== null && typeof p.force !== 'boolean') throw new RpcError(ERRORS.BAD_REQUEST, 'force must be true or false');
    const rec = this.sessions.get(p.id);
    if (!rec) throw new RpcError(ERRORS.NOT_FOUND, `no outside session ${p.id}`);
    if (p.spaceId && !this.core.spaces.has(p.spaceId)) throw new RpcError(ERRORS.NOT_FOUND, `no space ${p.spaceId}`);
    if (this.taking.has(p.id)) throw new RpcError(ERRORS.NOT_ALLOWED, 'this session is already being taken over');
    this.taking.add(p.id);
    try {
      // 1. The registry file still says the same thing.
      const reg = this.readRegistry(rec.file);
      if (!reg) throw new RpcError(ERRORS.NOT_FOUND, 'that session has ended');
      if (reg.pid !== rec.reg.pid || reg.sessionId !== rec.reg.sessionId) {
        throw new RpcError(ERRORS.NOT_ALLOWED, 'that session changed since it was listed; try again');
      }
      const own = this.ownSessions();
      if (own.ids.has(reg.sessionId) || own.pids.has(reg.pid) || reg.pid === process.ppid) {
        throw new RpcError(ERRORS.NOT_ALLOWED, 'that session already belongs to CC-Dashboard');
      }
      if (!this.sys.alive(reg.pid)) throw new RpcError(ERRORS.NOT_FOUND, 'that session has ended');
      let cwdOk = false;
      try { cwdOk = fs.statSync(reg.cwd).isDirectory(); } catch { cwdOk = false; }
      if (!cwdOk) throw new RpcError(ERRORS.BAD_REQUEST, `its folder is gone: ${reg.cwd}`);

      // 2. The process is that Claude.
      const check = confirmIdentity(reg, await this.sys.identity(reg.pid), this.platform);
      if (!check.ok) throw new RpcError(ERRORS.NOT_ALLOWED, `not ending it: ${check.reason}`);

      // 3. Busy: only with force.
      if (stateOf(reg.status) === 'working' && p.force !== true) {
        throw new RpcError(ERRORS.STILL_WORKING, `${reg.name || path.basename(reg.cwd)} is still working; take over with force to end it anyway`);
      }

      // 4. End it and wait until it is gone.
      await this.endProcess(reg);
      const deadline = Date.now() + this.waitMs;
      while (this.sys.alive(reg.pid)) {
        if (Date.now() >= deadline) throw new RpcError(ERRORS.NOT_ALLOWED, `process ${reg.pid} did not exit; it is still running outside the app`);
        await sleep(100);
      }

      // 5. It leaves the outside list at once and becomes an agent here.
      const transcript = rec.transcript || findTranscript(this.configDir, reg.cwd, reg.sessionId);
      this.sessions.delete(p.id);
      this.emitChangedNow();
      let spaceId = p.spaceId || '';
      if (!spaceId) {
        const m = matchSpace(this.core.spaces.values(), reg.cwd, this.platform);
        spaceId = m ? m.id : this.core.spacesAdd({ path: reg.cwd }).id;
      }
      const name = (p.name || '').trim() || reg.name || path.basename(reg.cwd) || 'agent';
      return this.core.adoptSession({ spaceId, name, cwd: reg.cwd, sessionId: reg.sessionId, transcriptPath: transcript });
    } finally {
      this.taking.delete(p.id);
    }
  }

  /**
   * Windows: taskkill /T /F. Elsewhere SIGTERM, then SIGKILL after termMs if it is still the same process.
   * @param {Registry} reg
   */
  async endProcess(reg) {
    if (this.platform === 'win32') {
      await this.sys.taskkill(reg.pid);
      return;
    }
    this.sys.signal(reg.pid, 'SIGTERM');
    const until = Date.now() + this.termMs;
    while (Date.now() < until) {
      if (!this.sys.alive(reg.pid)) return;
      await sleep(50);
    }
    if (!this.sys.alive(reg.pid)) return;
    // Still there: make sure the pid was not reused in the meantime before the hard kill.
    if (!confirmIdentity(reg, await this.sys.identity(reg.pid), this.platform).ok) return;
    this.sys.signal(reg.pid, 'SIGKILL');
  }
}

module.exports = {
  External, parseRegistry, stateOf, pathInside, matchSpace, parseTasklist, parseProcStat, looksLikeClaude, confirmIdentity,
  pidAlive, readIdentity, MAX_LOG, parseJsonLines,
};
