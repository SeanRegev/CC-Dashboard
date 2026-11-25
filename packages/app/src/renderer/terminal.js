// @ts-check
/**
 * One xterm.js terminal attached to one agent. Lives as long as its tab; moved between panes.
 * xterm.js and the fit addon are loaded as UMD scripts in index.html (globalThis.Terminal / FitAddon).
 */
import { shortcutFor } from './logic.js';

export const TERMINAL_FONT = '"Cascadia Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace';

export const TERMINAL_THEME = Object.freeze({
  background: '#1D1B1A',
  foreground: '#EDE8E3',
  cursor: '#E8805F',
  cursorAccent: '#1D1B1A',
  selectionBackground: 'rgba(232, 128, 95, 0.30)',
  selectionInactiveBackground: 'rgba(232, 128, 95, 0.16)',
  black: '#2B2826', red: '#E5786D', green: '#86CF86', yellow: '#F0B44C',
  blue: '#7DA7F0', magenta: '#B7ACF2', cyan: '#7CC7C2', white: '#D8D1CA',
  brightBlack: '#6E6761', brightRed: '#F0968C', brightGreen: '#A6E0A6', brightYellow: '#F6CB7E',
  brightBlue: '#A2C1F6', brightMagenta: '#CFC7F7', brightCyan: '#A3DAD6', brightWhite: '#F6F2EE',
});

export class TerminalView {
  /**
   * @param {{
   *   id: string,
   *   client: import('./client.js').CoreClient,
   *   platform: string,
   *   onFocus?: () => void,
   *   onError?: (msg: string) => void,
   * }} o
   */
  constructor(o) {
    this.id = o.id;
    this.client = o.client;
    this.platform = o.platform;
    this.onError = o.onError || (() => {});
    this.el = document.createElement('div');
    this.el.className = 'term-slot';
    this.el.dataset.agent = o.id;
    this.ready = false;
    /** @type {string[]} output that arrived before the replay was written */
    this.early = [];
    this.lastSize = '';
    this.disposed = false;

    const g = /** @type {any} */ (globalThis);
    this.term = new g.Terminal({
      fontFamily: TERMINAL_FONT,
      fontSize: 13,
      lineHeight: 1,  // >1 leaves gaps in box-drawing characters with the DOM renderer
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'outline',
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      drawBoldTextInBrightColors: false,
      theme: TERMINAL_THEME,
    });
    this.fitAddon = new g.FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.el);

    // App shortcuts are not sent to the terminal; everything else (Ctrl+C included) is.
    this.term.attachCustomKeyEventHandler((/** @type {KeyboardEvent} */ ev) => !shortcutFor(ev, this.platform));
    this.term.onData((/** @type {string} */ data) => this.client.send('agents.input', { id: this.id, data }));
    this.term.onBinary((/** @type {string} */ data) => this.client.send('agents.input', { id: this.id, data }));
    this.term.onResize((/** @type {{cols:number, rows:number}} */ s) => this.sendSize(s.cols, s.rows));
    this.term.textarea && this.term.textarea.addEventListener('focus', () => o.onFocus && o.onFocus());
  }

  /** Attach to the agent and write its scrollback. */
  async attach() {
    try {
      const r = await this.client.attach(this.id);
      if (this.disposed) return;
      this.term.write((r && r.replay) || '');
      for (const d of this.early) this.term.write(d);
      this.early = [];
      this.ready = true;
      this.fit(true);
    } catch (e) {
      if (this.disposed) return;
      this.ready = true;
      this.term.write(`\r\n\x1b[38;2;229;120;109mCould not attach: ${/** @type {any} */ (e).message}\x1b[0m\r\n`);
      this.onError(`Could not attach to ${this.id}`);
    }
  }

  /** After a reconnect the core sends the full scrollback again: start clean. @param {string} replay */
  reattach(replay) {
    if (this.disposed) return;
    this.term.reset();
    this.term.write(replay || '');
    this.lastSize = '';
    this.fit(true);
  }

  /** @param {string} data */
  write(data) {
    if (this.disposed) return;
    if (!this.ready) this.early.push(data);
    else this.term.write(data);
  }

  /** Fit to the slot; tell the core when the grid changed. @param {boolean} [force] */
  fit(force = false) {
    if (this.disposed || !this.el.isConnected) return;
    const r = this.el.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return;
    try { this.fitAddon.fit(); } catch { return; }
    if (force) this.sendSize(this.term.cols, this.term.rows);
  }

  /** @param {number} cols @param {number} rows */
  sendSize(cols, rows) {
    const key = `${cols}x${rows}`;
    if (key === this.lastSize || !this.ready) return;
    this.lastSize = key;
    this.client.send('agents.resize', { id: this.id, cols, rows });
  }

  focus() { if (!this.disposed) this.term.focus(); }
  blur() { if (!this.disposed) this.term.blur(); }
  hasSelection() { return !this.disposed && this.term.hasSelection(); }
  getSelection() { return this.disposed ? '' : this.term.getSelection(); }
  /** @param {string} text */
  paste(text) { if (!this.disposed) this.term.paste(text); }

  /** Close the tab: detach (the agent keeps running in the core). */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.client.detach(this.id);
    this.term.dispose();
    this.el.remove();
  }
}
