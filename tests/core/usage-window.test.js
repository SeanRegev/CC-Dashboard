'use strict';
// M4 track A: the transcript estimate (usage.js) no longer assumes a 200k window when the window is known.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { UsageReader, contextWindowFor, percentOf } = require('../../packages/core/src/usage');
const { tempHome, rmrf } = require('./helpers');

test('contextWindowFor: status line window, then [1m], then over 200k means 1M, else 200k', () => {
  assert.equal(contextWindowFor('claude-opus-4', 1000, 1000000), 1000000); // known (agent or model id) wins
  assert.equal(contextWindowFor('claude-opus-4[1m]', 1000, 200000), 200000); // even over the [1m] hint
  assert.equal(contextWindowFor('claude-opus-4[1m]', 1000, undefined), 1000000);
  assert.equal(contextWindowFor('claude-opus-4', 250000, undefined), 1000000);
  assert.equal(contextWindowFor('claude-opus-4', 200000, undefined), 200000);
  assert.equal(contextWindowFor('', 0, undefined), 200000);
  for (const junk of [0, -5, NaN, Infinity, null, '1000000']) {
    assert.equal(contextWindowFor('m', 10, /** @type {any} */ (junk)), 200000, String(junk));
  }
  assert.equal(percentOf(98000, 1000000), 9.8);
  assert.equal(percentOf(0, 1000000), 0);
  assert.equal(percentOf(300000, 200000), 100);
});

test('UsageReader: the window comes from windowFor (by model id), source transcript', (t) => {
  const dir = tempHome();
  t.after(() => rmrf(dir));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5',
    usage: { input_tokens: 6, output_tokens: 412, cache_creation_input_tokens: 3120, cache_read_input_tokens: 94870 } } }) + '\n');
  const seen = [];
  const u = new UsageReader().read(file, { windowFor: (model) => { seen.push(model); return 1000000; } });
  assert.deepEqual(seen, ['claude-haiku-5-5']);
  assert.deepEqual(u, { total: 3538, context: 97996, contextPct: 9.8, model: 'claude-haiku-5-5', contextWindow: 1000000, source: 'transcript' });
  // A windowFor that throws or knows nothing falls back to the rules.
  assert.equal(new UsageReader().read(file, { windowFor: () => { throw new Error('x'); } }).contextWindow, 200000);
  assert.equal(new UsageReader().read(file, { windowFor: () => undefined }).contextPct, 49);
});
