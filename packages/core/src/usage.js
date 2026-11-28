// @ts-check
'use strict';
/**
 * Token use from Claude Code's own session transcript (JSONL), read incrementally:
 * each call only parses complete lines appended since the previous call.
 * Ported from the Python deck's usage.py.
 *
 * (v4) This is the fallback for AgentUsage (source 'transcript'): the status line (statusline.js)
 * is exact and wins once it has reported. The window size is never assumed to be 200k when it is
 * known; see contextWindowFor().
 */
const fs = require('fs');

const CONTEXT_WINDOW = 200_000;
const BIG_CONTEXT_WINDOW = 1_000_000;

/**
 * @typedef {Object} Totals
 * @property {number} input @property {number} output @property {number} cacheRead @property {number} cacheWrite
 * @property {number} context  prompt size of the latest reply
 * @property {string} model
 * @property {number} replies
 */

class UsageReader {
  constructor() {
    /** @type {Map<string, {offset:number, seen:Set<string>, t:Totals}>} */
    this.cursors = new Map();
  }

  /**
   * @param {string} file
   * @param {{windowFor?: (model: string) => number|undefined}} [opts]  windowFor: the window the status line
   *   last reported for this agent, else for this model id (see contextWindowFor)
   * @returns {import('./types').AgentUsage|null}
   */
  read(file, opts = {}) {
    if (!file) return null;
    let cur = this.cursors.get(file);
    if (!cur) {
      cur = fresh();
      this.cursors.set(file, cur);
    }
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size < cur.offset) { // file was replaced: start over
        cur = fresh();
        this.cursors.set(file, cur);
      }
      if (size > cur.offset) {
        const buf = Buffer.alloc(size - cur.offset);
        const n = fs.readSync(fd, buf, 0, buf.length, cur.offset);
        const chunk = buf.subarray(0, n);
        // Only consume complete lines; a partial last line is read next time.
        const end = chunk.lastIndexOf(0x0a) + 1;
        cur.offset += end;
        for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) consume(cur, line);
      }
    } catch {
      if (!cur.t.replies) return null;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    return summary(cur.t, opts.windowFor);
  }

  forget(file) { this.cursors.delete(file); }
}

function fresh() {
  return { offset: 0, seen: new Set(), t: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: 0, model: '', replies: 0 } };
}

function consume(cur, line) {
  if (!line.trim()) return;
  let rec;
  try { rec = JSON.parse(line); } catch { return; }
  if (!rec || rec.type !== 'assistant') return;
  const msg = rec.message || {};
  const u = msg.usage;
  if (!u) return;
  const key = msg.id || rec.uuid;
  if (key) {
    if (cur.seen.has(key)) return; // one reply can be written over several lines
    cur.seen.add(key);
  }
  const t = cur.t;
  const i = Number(u.input_tokens) || 0;
  const cr = Number(u.cache_read_input_tokens) || 0;
  const cw = Number(u.cache_creation_input_tokens) || 0;
  t.input += i;
  t.output += Number(u.output_tokens) || 0;
  t.cacheRead += cr;
  t.cacheWrite += cw;
  t.context = i + cr + cw;
  t.model = msg.model || t.model;
  t.replies += 1;
}

/** @param {Totals} t */
/**
 * The context window to estimate with. Order: what the status line reported (for this agent, else for
 * this model id: `known`); else `[1m]` in the model name; else 1M when the context is already over 200k
 * (it can't be a 200k window); else 200k.
 * @param {string} model @param {number} context @param {number|undefined} [known]
 */
function contextWindowFor(model, context, known) {
  if (typeof known === 'number' && Number.isFinite(known) && known > 0) return known;
  if (String(model || '').includes('[1m]')) return BIG_CONTEXT_WINDOW;
  if (context > CONTEXT_WINDOW) return BIG_CONTEXT_WINDOW;
  return CONTEXT_WINDOW;
}

/** @param {number} context @param {number} window */
function percentOf(context, window) {
  const pct = context && window > 0 ? Math.min(100, (100 * context) / window) : 0;
  return Math.round(pct * 100) / 100;
}

/** @param {Totals} t @param {(model: string) => number|undefined} [windowFor] @returns {import('./types').AgentUsage} */
function summary(t, windowFor) {
  let known;
  try { known = windowFor ? windowFor(t.model) : undefined; } catch { known = undefined; }
  const window = contextWindowFor(t.model, t.context, known);
  return {
    total: t.input + t.output + t.cacheWrite, // new tokens; cheap cache re-reads are not counted
    context: t.context,
    contextPct: percentOf(t.context, window),
    model: t.model,
    contextWindow: window,
    source: 'transcript',
  };
}

module.exports = { UsageReader, contextWindowFor, percentOf, CONTEXT_WINDOW, BIG_CONTEXT_WINDOW };
