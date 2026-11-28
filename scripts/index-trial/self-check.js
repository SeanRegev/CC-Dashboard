#!/usr/bin/env node
// @ts-check
'use strict';
/**
 * Tiny self-check for measure.js against synthetic logs. Research script, not part of `npm test`.
 *   node scripts/index-trial/self-check.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('./measure');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-trial-'));
const w = (/** @type {string} */ name, /** @type {any[]} */ lines) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
};

try {
  // 1. Activity log: two prompts = two tasks; a subagent's tool counts for its task.
  const act = w('agent.jsonl', [
    { seq: 1, at: 1000, subagentId: '', kind: 'session_start' },
    { seq: 2, at: 2000, subagentId: '', kind: 'prompt', text: 'where is X' },
    { seq: 3, at: 2100, subagentId: '', kind: 'tool', tool: 'Grep', detail: 'X' },
    { seq: 4, at: 2200, subagentId: '', kind: 'tool_done', tool: 'Grep', ms: 50 },
    { seq: 5, at: 2300, subagentId: '', kind: 'tool', tool: 'Read', detail: 'a.js' },
    { seq: 6, at: 2400, subagentId: 'sub1', kind: 'tool', tool: 'Glob', detail: '**/*.js' },
    { seq: 7, at: 5000, subagentId: '', kind: 'turn_end', text: 'X is in a.js' },
    { seq: 8, at: 6000, subagentId: '', kind: 'prompt', text: 'who calls X' },
    { seq: 9, at: 6100, subagentId: '', kind: 'tool', tool: 'mcp__codegraph__codegraph_explore' },
    { seq: 10, at: 7000, subagentId: '', kind: 'turn_end', text: 'b.js calls X' },
  ]);
  const a = m.measureFile(act);
  assert.strictEqual(a.length, 2, 'two tasks');
  assert.deepStrictEqual(m.summarize(a[0]), { Grep: 1, Glob: 1, Read: 1, Bash: 0, index: 0, other: 0, calls: 3 });
  assert.strictEqual(a[0].wallMs, 3000);
  assert.strictEqual(a[0].answer, 'X is in a.js');
  assert.strictEqual(m.summarize(a[1]).index, 1);
  assert.strictEqual(a[1].hasTokens, false);

  // 2. stream-json: usage from the result line (session total), tool ids counted once, Claude's own cost wins.
  const stream = w('run.jsonl', [
    { type: 'system', subtype: 'init', model: 'claude-haiku-5-5', tools: ['Read'] },
    { type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: {} }], usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: {} }], usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
    { type: 'assistant', message: { id: 'm2', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 20, output_tokens: 7 } } },
    { type: 'result', subtype: 'success', total_cost_usd: 0.0123, duration_ms: 4200, num_turns: 2, result: 'done',
      usage: { input_tokens: 30, output_tokens: 12, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000 } },
  ]);
  const s = m.measureFile(stream);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].tools.Grep, 1, 'repeated message line counted once');
  assert.deepStrictEqual(s[0].tokens, { input: 30, output: 12, cacheWrite: 1000, cacheRead: 20000 });
  assert.strictEqual(s[0].costUsd, 0.0123);
  assert.strictEqual(s[0].wallMs, 4200);
  // estimate: 30*0.1 + 12*0.5 + 1000*0.125 + 20000*0.01 = 3 + 6 + 125 + 200 = 334 per 1e6
  assert.ok(Math.abs(/** @type {number} */ (s[0].estUsd) - 334e-6) < 1e-9, 'estimate from PRICES');

  // 3. Transcript without a result line: usage summed per message id; time from timestamps.
  const tr = w('transcript.jsonl', [
    { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'where is X' } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:02.000Z', message: { id: 'a', model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: 'u1', name: 'Read' }], usage: { input_tokens: 100, output_tokens: 10 } } },
    { type: 'user', timestamp: '2026-01-01T00:00:03.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'u1' }] } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:05.000Z', message: { id: 'b', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'in a.js' }], usage: { input_tokens: 200, output_tokens: 20 } } },
    { type: 'user', timestamp: '2026-01-01T00:01:00.000Z', message: { content: 'who calls X' } },
    { type: 'assistant', timestamp: '2026-01-01T00:01:01.000Z', message: { id: 'c', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'b.js' }], usage: { input_tokens: 300, output_tokens: 30 } } },
  ]);
  const t = m.measureFile(tr);
  assert.strictEqual(t.length, 2, 'two prompts, two tasks');
  assert.strictEqual(t[0].tokens.input, 300);
  assert.strictEqual(t[0].wallMs, 5000);
  assert.strictEqual(t[1].tokens.output, 30);
  assert.strictEqual(t[0].costUsd, null);
  assert.ok(Math.abs(/** @type {number} */ (t[0].estUsd) - (300 * 1 + 30 * 5) / 1e6) < 1e-12);

  // 4. --pair: tools and time from the activity log, tokens from the transcript.
  const p = m.pair(a, t);
  assert.strictEqual(p[0].tools.Grep, 1);
  assert.strictEqual(p[0].tokens.input, 300);
  assert.strictEqual(p[0].wallMs, 3000);

  // 5. A bare `--output-format json` result, pretty-printed.
  const jf = path.join(dir, 'run.json');
  fs.writeFileSync(jf, JSON.stringify({ type: 'result', total_cost_usd: 0.5, duration_ms: 1000, usage: { input_tokens: 1, output_tokens: 2 } }, null, 2));
  const j = m.measureFile(jf);
  assert.strictEqual(j.length, 1);
  assert.strictEqual(j[0].costUsd, 0.5);
  assert.strictEqual(j[0].tokens.output, 2);

  assert.ok(m.table([...a, ...s]).split('\n').length === 4, 'table has a header and three rows');
  process.stdout.write('measure.js self-check: ok\n' + m.table([...a, ...s, ...t]) + '\n');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
