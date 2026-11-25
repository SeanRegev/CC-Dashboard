// @ts-check
'use strict';
/**
 * Token use from Claude Code's own session transcript (JSONL), read incrementally:
 * each call only parses complete lines appended since the previous call.
 * Ported from the Python deck's usage.py.
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

  /** @param {string} file @returns {{total:number, context:number, contextPct:number, model:string}|null} */
  read(file) {
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
    return summary(cur.t);
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
function summary(t) {
  const window = t.model.includes('[1m]') ? BIG_CONTEXT_WINDOW : CONTEXT_WINDOW;
  const pct = t.context ? Math.min(100, (100 * t.context) / window) : 0;
  return {
    total: t.input + t.output + t.cacheWrite, // new tokens; cheap cache re-reads are not counted
    context: t.context,
    contextPct: Math.round(pct * 100) / 100,
    model: t.model,
  };
}

module.exports = { UsageReader, CONTEXT_WINDOW, BIG_CONTEXT_WINDOW };
