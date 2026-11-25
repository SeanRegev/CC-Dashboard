// @ts-check
'use strict';
/**
 * Files the core keeps in its home dir, written atomically (temp file, then rename).
 *   state.json  { version, spaces, agents, status: {id: AgentStatus}, runtime: {id: Runtime} }
 */
const fs = require('fs');
const path = require('path');

const STATE_VERSION = 1;

/**
 * Write a file atomically. Retries the rename briefly: on Windows a virus scanner or indexer
 * can hold the target open for a moment (EPERM / EBUSY / EACCES).
 * @param {string} file @param {string} text @param {{mode?: number}} [opts]
 */
function writeFileAtomic(file, text, opts = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text, { mode: opts.mode });
  if (opts.mode !== undefined && process.platform !== 'win32') {
    try { fs.chmodSync(tmp, opts.mode); } catch { /* umask already applied */ }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = /** @type {any} */ (e).code;
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
      }
      const until = Date.now() + 25;
      while (Date.now() < until) { /* brief spin; sync on purpose, writes are tiny */ }
    }
  }
}

/** @param {string} file @returns {any} null when missing or unreadable */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

class StateStore {
  /** @param {string} home */
  constructor(home) {
    this.file = path.join(home, 'state.json');
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** @type {(() => any)|null} */
    this.snapshot = null;
  }

  load() {
    const data = readJson(this.file);
    if (!data || typeof data !== 'object') return { version: STATE_VERSION, spaces: [], agents: [], status: {}, runtime: {} };
    return {
      version: STATE_VERSION,
      spaces: Array.isArray(data.spaces) ? data.spaces : [],
      agents: Array.isArray(data.agents) ? data.agents : [],
      status: data.status && typeof data.status === 'object' ? data.status : {},
      runtime: data.runtime && typeof data.runtime === 'object' ? data.runtime : {},
    };
  }

  /** @param {() => any} snapshot produces the object to save */
  bind(snapshot) { this.snapshot = snapshot; }

  /** Save soon (status changes come in bursts). @param {number} [delay] */
  saveSoon(delay = 200) {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.saveNow(); }, delay);
  }

  saveNow() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.snapshot) return;
    writeFileAtomic(this.file, JSON.stringify({ version: STATE_VERSION, ...this.snapshot() }, null, 1) + '\n');
  }
}

module.exports = { writeFileAtomic, readJson, StateStore, STATE_VERSION };
