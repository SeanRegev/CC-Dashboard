#!/usr/bin/env node
// @ts-check
'use strict';
/**
 * Indexer trial: measure what a task cost. Research tool, not product code (docs/INDEXER.md).
 *
 *   node scripts/index-trial/measure.js [--json] [--pair] <file.jsonl>...
 *
 * Each file is read line by line and its format is detected per line:
 *   - CC-Dashboard activity log (<CC_HOME>/activity/<agentId>.jsonl): ActivityEntry lines ({seq, at, kind, ...}).
 *     A task starts at each `prompt` entry. Gives tool counts and wall time (prompt -> turn_end). No tokens.
 *   - Claude transcript (<config>/projects/<dir>/<sessionId>.jsonl) or headless `claude -p --output-format
 *     stream-json --verbose` output: {type: 'assistant'|'user'|'system'|'result', ...}. A task starts at a
 *     `system/init` line or a user prompt that is not a tool result. Gives tool counts, tokens and, for
 *     stream-json, Claude's own total_cost_usd and duration_ms from the `result` line.
 *   - A single `claude -p --output-format json` result object (one line or pretty-printed): tokens, cost, time.
 * --pair: with exactly one activity file and one transcript file, task i of each is merged (tools and time from
 * the activity log, tokens and cost from the transcript).
 *
 * No dependencies. Cost: Claude's total_cost_usd when the file has it, else an estimate from PRICES
 * (API-equivalent; on a subscription it is not a bill).
 */
const fs = require('fs');
const path = require('path');

/** USD per million tokens: [input, output, cache write (5 min), cache read]. Matched by prefix of the model id. */
const PRICES = [
  ['claude-haiku-5-5', [0.10, 0.50, 0.125, 0.01]],
  ['claude-haiku-4-5', [1, 5, 1.25, 0.10]],
  ['claude-sonnet-5-5', [2, 10, 2.5, 0.10]],
  ['claude-sonnet-5', [2, 10, 2.5, 0.20]],
  ['claude-sonnet-4', [3, 15, 3.75, 0.30]],
  ['claude-opus-5-5', [4, 20, 5, 0.20]],
  ['claude-opus', [5, 25, 6.25, 0.50]],
];

/**
 * @typedef {Object} Task
 * @property {string} label
 * @property {string} source        file name(s)
 * @property {Record<string, number>} tools   tool name -> calls
 * @property {{input: number, output: number, cacheWrite: number, cacheRead: number}} tokens
 * @property {string[]} models
 * @property {number|null} costUsd   Claude's own figure, when known
 * @property {number|null} estUsd    estimate from PRICES
 * @property {number|null} wallMs
 * @property {number|null} turns
 * @property {string} [answer]       start of the final text, if known
 * @property {boolean} hasTokens
 */

/** @param {string} label @param {string} source @returns {Task} */
function newTask(label, source) {
  return {
    label, source, tools: {}, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, models: [],
    costUsd: null, estUsd: null, wallMs: null, turns: null, hasTokens: false,
  };
}

/** Grep / Glob / Read / Bash / index (any MCP tool) / other. @param {string} name */
function category(name) {
  if (name === 'Grep' || name === 'Glob' || name === 'Read' || name === 'Bash') return name;
  if (name.startsWith('mcp__')) return 'index';
  return 'other';
}

/** @param {string} model @returns {number[]|null} */
function priceFor(model) {
  const m = String(model || '').toLowerCase();
  for (const [prefix, p] of PRICES) if (m.startsWith(prefix)) return /** @type {number[]} */ (p);
  return null;
}

/** @param {Task} t */
function estimate(t) {
  const p = priceFor(t.models[0] || '');
  if (!p || !t.hasTokens) return null;
  const k = t.tokens;
  return (k.input * p[0] + k.output * p[1] + k.cacheWrite * p[2] + k.cacheRead * p[3]) / 1e6;
}

/** @param {string} text @returns {any[]} */
function parseLines(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && !trimmed.includes('\n{')) {
    try { return [JSON.parse(trimmed)]; } catch { /* fall through to lines */ }
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* half-written line: skip */ }
  }
  return out;
}

/** @param {any} o */
function isActivity(o) { return o && typeof o.seq === 'number' && typeof o.kind === 'string'; }

/** @param {any} content */
function isPromptContent(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && b.type === 'text') && !content.some((b) => b && b.type === 'tool_result');
}

/** @param {any} u @param {Task} t */
function addUsage(u, t) {
  if (!u) return;
  t.tokens.input += Number(u.input_tokens) || 0;
  t.tokens.output += Number(u.output_tokens) || 0;
  t.tokens.cacheWrite += Number(u.cache_creation_input_tokens) || 0;
  t.tokens.cacheRead += Number(u.cache_read_input_tokens) || 0;
  t.hasTokens = true;
}

/**
 * Turn the parsed lines of one file into tasks.
 * @param {any[]} lines @param {string} source @returns {Task[]}
 */
function tasksFromLines(lines, source) {
  /** @type {Task[]} */
  const tasks = [];
  /** @type {Task|null} */
  let cur = null;
  const start = () => { cur = newTask(`${source}#${tasks.length + 1}`, source); tasks.push(cur); return cur; };
  const ensure = () => cur || start();
  // Activity log state
  let promptAt = 0, lastAt = 0;
  // Transcript state: one assistant message can span several lines with the same id; count its usage once.
  /** @type {Map<string, any>} */
  let usageById = new Map();
  let firstTs = 0, lastTs = 0;
  /** @type {Set<string>} */
  let toolIds = new Set();
  const closeTranscript = () => {
    if (!cur) return;
    for (const u of usageById.values()) addUsage(u, cur);
    if (cur.wallMs == null && firstTs && lastTs > firstTs) cur.wallMs = lastTs - firstTs;
    usageById = new Map(); toolIds = new Set(); firstTs = 0; lastTs = 0;
  };
  const closeActivity = () => {
    if (cur && promptAt && cur.wallMs == null && lastAt >= promptAt) cur.wallMs = lastAt - promptAt;
    promptAt = 0; lastAt = 0;
  };

  for (const o of lines) {
    if (!o || typeof o !== 'object') continue;
    if (isActivity(o)) {
      if (o.subagentId) { // a subagent's tools still count for the task
        if (o.kind === 'tool' && o.tool) { const t = ensure(); t.tools[o.tool] = (t.tools[o.tool] || 0) + 1; }
        lastAt = Math.max(lastAt, Number(o.at) || 0);
        continue;
      }
      if (o.kind === 'prompt') { closeActivity(); start(); promptAt = Number(o.at) || 0; lastAt = promptAt; continue; }
      if (!cur && o.kind !== 'tool') continue; // session_start etc. before the first prompt
      const t = ensure();
      if (o.kind === 'tool' && o.tool) t.tools[o.tool] = (t.tools[o.tool] || 0) + 1;
      if (o.kind === 'turn_end') { lastAt = Number(o.at) || lastAt; if (o.text) t.answer = String(o.text); if (promptAt) t.wallMs = lastAt - promptAt; continue; }
      lastAt = Math.max(lastAt, Number(o.at) || 0);
      continue;
    }
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
    if (o.type === 'system' && o.subtype === 'init') { closeTranscript(); start(); if (o.model) /** @type {Task} */ (cur).models.push(String(o.model)); continue; }
    if (o.type === 'user' && o.message && isPromptContent(o.message.content) && !o.isMeta) {
      // A headless run's first prompt follows its init line: same task.
      const c = /** @type {Task|null} */ (cur);
      if (!c || Object.keys(c.tools).length || usageById.size) { closeTranscript(); start(); }
      if (ts) { firstTs = firstTs || ts; lastTs = ts; }
      continue;
    }
    if (o.type === 'assistant' && o.message) {
      const t = ensure();
      const m = o.message;
      if (m.model && m.model !== '<synthetic>' && !t.models.includes(m.model)) t.models.push(String(m.model));
      if (m.usage) usageById.set(String(m.id || `line${usageById.size}`), m.usage);
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b && b.type === 'tool_use' && b.name && !toolIds.has(b.id)) {
          toolIds.add(b.id); t.tools[b.name] = (t.tools[b.name] || 0) + 1;
        }
        if (b && b.type === 'text' && b.text) t.answer = String(b.text);
      }
      if (ts) { firstTs = firstTs || ts; lastTs = ts; }
      continue;
    }
    if (o.type === 'result' || (o.type === undefined && typeof o.total_cost_usd === 'number')) {
      const t = ensure();
      if (typeof o.total_cost_usd === 'number') t.costUsd = o.total_cost_usd;
      if (typeof o.duration_ms === 'number') t.wallMs = o.duration_ms;
      if (typeof o.num_turns === 'number') t.turns = o.num_turns;
      if (typeof o.result === 'string') t.answer = o.result;
      if (o.modelUsage && typeof o.modelUsage === 'object') {
        for (const k of Object.keys(o.modelUsage)) if (!t.models.includes(k)) t.models.push(k);
      }
      // A bare json result has no assistant lines: take its usage. stream-json has both; the result's usage is
      // the session total, so prefer it over the per-message sum.
      if (o.usage) { usageById = new Map([['result', o.usage]]); }
      continue;
    }
    if (ts) lastTs = Math.max(lastTs, ts);
  }
  closeTranscript();
  closeActivity();
  for (const t of tasks) t.estUsd = estimate(t);
  return tasks;
}

/** @param {string} file @returns {Task[]} */
function measureFile(file) {
  return tasksFromLines(parseLines(fs.readFileSync(file, 'utf8')), path.basename(file));
}

/** Merge task i of an activity log with task i of a transcript. @param {Task[]} act @param {Task[]} tr */
function pair(act, tr) {
  const n = Math.max(act.length, tr.length);
  /** @type {Task[]} */
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = act[i], b = tr[i];
    if (!a || !b) { out.push(/** @type {Task} */ (a || b)); continue; }
    out.push({ ...b, label: a.label, source: `${a.source}+${b.source}`, tools: a.tools, wallMs: a.wallMs ?? b.wallMs, answer: b.answer || a.answer });
  }
  return out;
}

/** @param {Task} t */
function summarize(t) {
  /** @type {Record<string, number>} */
  const by = { Grep: 0, Glob: 0, Read: 0, Bash: 0, index: 0, other: 0 };
  let total = 0;
  for (const [name, n] of Object.entries(t.tools)) { by[category(name)] += n; total += n; }
  return { ...by, calls: total };
}

/** @param {Task[]} tasks @returns {string} */
function table(tasks) {
  const head = ['task', 'Grep', 'Glob', 'Read', 'Bash', 'index', 'other', 'calls', 'in', 'out', 'cacheW', 'cacheR', 'cost$', 'wall s'];
  const rows = tasks.map((t) => {
    const s = summarize(t);
    const k = t.tokens;
    const cost = t.costUsd ?? t.estUsd;
    return [t.label, s.Grep, s.Glob, s.Read, s.Bash, s.index, s.other, s.calls,
      t.hasTokens ? k.input : '-', t.hasTokens ? k.output : '-', t.hasTokens ? k.cacheWrite : '-', t.hasTokens ? k.cacheRead : '-',
      cost == null ? '-' : (t.costUsd == null ? '~' : '') + cost.toFixed(4),
      t.wallMs == null ? '-' : (t.wallMs / 1000).toFixed(1)].map(String);
  });
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (/** @type {string[]} */ r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  return [fmt(head), ...rows.map(fmt)].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const doPair = args.includes('--pair');
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    process.stderr.write('usage: node measure.js [--json] [--pair] <activity.jsonl|transcript.jsonl|run.json>...\n');
    process.exit(2);
  }
  let tasks;
  if (doPair && files.length === 2) {
    const [x, y] = files.map(measureFile);
    const xIsAct = !x.some((t) => t.hasTokens);
    tasks = xIsAct ? pair(x, y) : pair(y, x);
  } else {
    tasks = files.flatMap(measureFile);
  }
  if (json) process.stdout.write(JSON.stringify(tasks.map((t) => ({ ...t, summary: summarize(t) })), null, 2) + '\n');
  else process.stdout.write(table(tasks) + '\n');
}

module.exports = { tasksFromLines, measureFile, parseLines, pair, summarize, table, estimate, priceFor, category, PRICES };

if (require.main === module) main();
