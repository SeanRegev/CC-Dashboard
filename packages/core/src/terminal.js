// @ts-check
'use strict';
/**
 * One running `claude` in a pseudo terminal (node-pty: ConPTY on Windows), plus:
 *   - a scrollback ring buffer replayed when a window attaches
 *   - a headless terminal emulator, so the core can read what is on screen right now
 *     (to notice a permission prompt answered inside the terminal)
 *   - a write queue, so "type text, wait, press Enter" can't interleave with other keys
 */
const { EventEmitter } = require('events');
const pty = require('node-pty');
const { Terminal: Headless } = require('@xterm/headless');

const SCROLLBACK_LIMIT = 256 * 1024; // characters kept per agent
const ENTER_DELAY_MS = 150; // Claude treats a fast burst as a paste; Enter must come separately

class Scrollback {
  constructor(limit = SCROLLBACK_LIMIT) {
    this.limit = limit;
    /** @type {string[]} */
    this.chunks = [];
    this.size = 0;
  }

  /** @param {string} data */
  push(data) {
    if (!data) return;
    this.chunks.push(data);
    this.size += data.length;
    if (this.size > this.limit * 1.25) this.compact();
  }

  compact() {
    let all = this.chunks.join('');
    if (all.length > this.limit) {
      let cut = all.length - this.limit;
      // Start the replay at a line break when one is near, to avoid half an escape sequence.
      const nl = all.indexOf('\n', cut);
      if (nl !== -1 && nl - cut < 4096) cut = nl + 1;
      all = all.slice(cut);
    }
    this.chunks = [all];
    this.size = all.length;
  }

  toString() {
    this.compact();
    return this.chunks[0] || '';
  }

  clear() { this.chunks = []; this.size = 0; }
}

class AgentTerminal extends EventEmitter {
  /**
   * @param {{file:string, args:string[]|string, cwd:string, env:NodeJS.ProcessEnv, cols?:number, rows?:number, scrollback?:Scrollback}} spec
   */
  constructor(spec) {
    super();
    this.cols = spec.cols || 120;
    this.rows = spec.rows || 32;
    this.scrollback = spec.scrollback || new Scrollback();
    this.screen = new Headless({ cols: this.cols, rows: this.rows, scrollback: 0, allowProposedApi: true });
    this.bracketedPaste = false;
    this.running = true;
    /** @type {number|null} */
    this.exitCode = null;
    /** @type {Promise<void>} */
    this.queue = Promise.resolve();
    this.proc = pty.spawn(spec.file, /** @type {any} */ (spec.args), {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: spec.cwd,
      env: /** @type {any} */ (spec.env),
      useConpty: true,
    });
    this.pid = this.proc.pid;
    this.proc.onData((data) => {
      this.scrollback.push(data);
      this.screen.write(data);
      if (data.includes('\x1b[?2004h')) this.bracketedPaste = true;
      if (data.includes('\x1b[?2004l')) this.bracketedPaste = false;
      this.emit('data', data);
    });
    this.proc.onExit(({ exitCode }) => {
      this.running = false;
      this.exitCode = exitCode;
      this.emit('exit', exitCode);
    });
  }

  /** Raw keystrokes, in order with any queued send. @param {string} data */
  write(data) {
    this.enqueue(async () => this.rawWrite(data));
  }

  /** Type text, then press Enter a moment later. @param {string} text */
  send(text) {
    this.enqueue(async () => {
      const multiline = /[\r\n]/.test(text);
      this.rawWrite(multiline && this.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text);
      await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
      this.rawWrite('\r');
    });
  }

  /** @param {() => Promise<void>} job */
  enqueue(job) {
    this.queue = this.queue.then(job).catch(() => { /* process gone */ });
  }

  rawWrite(data) {
    if (!this.running) return;
    try { this.proc.write(data); } catch { /* exited meanwhile */ }
  }

  /** @param {number} cols @param {number} rows */
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    try { this.screen.resize(cols, rows); } catch { /* ignore */ }
    if (this.running) try { this.proc.resize(cols, rows); } catch { /* exited meanwhile */ }
  }

  /** The text currently visible on screen (best effort: the emulator parses asynchronously). */
  screenText() {
    const b = this.screen.buffer.active;
    const lines = [];
    for (let y = b.viewportY; y < b.viewportY + this.rows; y++) {
      const line = b.getLine(y);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  }

  kill() {
    if (!this.running) return;
    try { this.proc.kill(); } catch { /* already gone */ }
  }

  dispose() {
    try { this.screen.dispose(); } catch { /* ignore */ }
  }
}

module.exports = { AgentTerminal, Scrollback, SCROLLBACK_LIMIT, ENTER_DELAY_MS };
