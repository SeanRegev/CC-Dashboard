// @ts-check
'use strict';
// Pure helpers of the usage UI (meter, context gauge, limit warning, totals rows).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'app', 'src', 'renderer', 'components', 'usage-logic.js')).href);
const NOW = new Date(2026, 10, 28, 14, 0, 0).getTime();
const at = (h, m) => new Date(2026, 10, 28, h, m, 0).getTime();

test('limitLevel: amber from 75, red from 90', async () => {
  const { limitLevel } = await load();
  assert.deepEqual([0, 74, 75, 89, 90, 100].map(limitLevel), ['low', 'low', 'mid', 'mid', 'high', 'high']);
});

test('formatCost', async () => {
  const { formatCost } = await load();
  assert.equal(formatCost(1.84), '$1.84');
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(undefined), '$0.00');
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(12), '$12.00');
});

test('contextInfo: "98k / 1M (10%)", the bar percentage is the text percentage', async () => {
  const { contextInfo } = await load();
  const c = contextInfo({ context: 98000, contextPct: 9.8, contextWindow: 1_000_000, source: 'statusline' });
  assert.equal(c.text, '98k / 1M (10%)');
  assert.equal(c.pct, 10);
  assert.equal(c.estimate, false);
  assert.match(c.title, /10% full/);
});

test('contextInfo: a transcript value reads as an estimate; a missing window is left out', async () => {
  const { contextInfo } = await load();
  const e = contextInfo({ context: 50000, contextPct: 25, contextWindow: 200000, source: 'transcript' });
  assert.equal(e.text, '~50k / 200k (~25%)');
  assert.equal(e.estimate, true);
  assert.equal(contextInfo({ context: 5000, contextPct: 2 }).text, '5k (2%)');
  assert.equal(contextInfo(undefined).text, '0 (0%)');
});

test('meterModel: nothing without limits, or when updatedAt is 0', async () => {
  const { meterModel } = await load();
  assert.equal(meterModel(null, NOW), null);
  assert.equal(meterModel({ limits: { updatedAt: 0 } }, NOW), null);
  assert.equal(meterModel({ limits: { updatedAt: NOW } }, NOW), null);
});

test('meterModel: text, level, tooltip with the reporting agent', async () => {
  const { meterModel } = await load();
  const usage = { limits: { fiveHour: { usedPct: 62, resetsAt: at(16, 20) }, sevenDay: { usedPct: 31, resetsAt: NOW + 86400e3 }, updatedAt: at(13, 59), fromAgentId: 'a1' } };
  const m = meterModel(usage, NOW, (id) => (id === 'a1' ? 'fix-flaky-tests' : undefined));
  assert.equal(m.text, '5h 62% · resets 16:20 / week 31%');
  assert.equal(m.short, '5h 62% / wk 31%');
  assert.equal(m.level, 'low');
  assert.equal(m.title, 'Claude usage limits, as of 13:59 (reported by fix-flaky-tests)');
  // an unknown agent: the name is left out
  assert.equal(meterModel(usage, NOW, () => undefined).title, 'Claude usage limits, as of 13:59');
  assert.equal(meterModel(usage, NOW).title, 'Claude usage limits, as of 13:59');
});

test('meterModel: the worse window sets the level', async () => {
  const { meterModel } = await load();
  const mk = (f, w) => ({ limits: { fiveHour: { usedPct: f, resetsAt: NOW + 3600e3 }, sevenDay: { usedPct: w, resetsAt: NOW + 86400e3 }, updatedAt: NOW } });
  assert.equal(meterModel(mk(10, 76), NOW).level, 'mid');
  assert.equal(meterModel(mk(91, 10), NOW).level, 'high');
  assert.equal(meterModel(mk(75, 91), NOW).level, 'high');
});

test('meterModel: a window whose reset time has passed shows "reset", not the old percentage', async () => {
  const { meterModel } = await load();
  const usage = { limits: { fiveHour: { usedPct: 95, resetsAt: NOW - 60e3 }, sevenDay: { usedPct: 31, resetsAt: NOW + 86400e3 }, updatedAt: NOW - 3600e3 } };
  const m = meterModel(usage, NOW);
  assert.equal(m.text, '5h reset / week 31%');
  assert.ok(!/95/.test(m.text + m.short));
  assert.equal(m.level, 'low');
  // only the stale window: still a meter
  assert.equal(meterModel({ limits: { fiveHour: { usedPct: 95, resetsAt: NOW - 1 }, updatedAt: NOW } }, NOW).text, '5h reset');
});

test('meterModel: only the windows that are present', async () => {
  const { meterModel } = await load();
  const m = meterModel({ limits: { sevenDay: { usedPct: 40, resetsAt: NOW + 1e6 }, updatedAt: NOW } }, NOW);
  assert.equal(m.text, 'week 40%');
});

test('limitWarningText: at 90% or more, and not when stale or unknown', async () => {
  const { limitWarningText } = await load();
  const mk = (pct, resetsAt, updatedAt = NOW) => ({ limits: { fiveHour: { usedPct: pct, resetsAt }, updatedAt } });
  assert.equal(limitWarningText(mk(89, at(16, 0)), NOW), null);
  assert.match(limitWarningText(mk(90, at(16, 5)), NOW), /5-hour limit is 90% used.*resets 16:05/);
  assert.match(limitWarningText(mk(97, at(16, 5)), NOW), /97%/);
  assert.equal(limitWarningText(mk(97, NOW - 1), NOW), null);
  assert.equal(limitWarningText(mk(97, at(16, 5), 0), NOW), null);
  assert.equal(limitWarningText(null, NOW), null);
});

test('totalsRows: biggest cost first; days newest first; names via label', async () => {
  const { totalsRows, maxCost, dayLabel } = await load();
  const rows = totalsRows({ a: { costUsd: 1, inputTokens: 5, outputTokens: 1, name: 'alpha' }, b: { costUsd: 3, inputTokens: 1, outputTokens: 1, name: 'beta' }, c: {} }, { label: (k, t) => t.name || k });
  assert.deepEqual(rows.map((r) => r.label), ['beta', 'alpha', 'c']);
  assert.equal(rows[2].costUsd, 0);
  assert.equal(maxCost(rows), 3);
  assert.equal(maxCost([]), 0);
  const days = totalsRows({ '2026-11-26': { costUsd: 9 }, '2026-11-28': { costUsd: 1 } }, { byKey: true });
  assert.deepEqual(days.map((r) => r.key), ['2026-11-28', '2026-11-26']);
  assert.equal(totalsRows(undefined).length, 0);
  assert.equal(dayLabel('2026-11-28'), 'Sat 28 Nov');
  assert.equal(dayLabel('junk'), 'junk');
});
