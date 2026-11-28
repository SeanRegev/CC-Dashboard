// @ts-check
'use strict';
// Pure helpers of the subagent cards (M4 track C): ordering, folding, labels, keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'app', 'src', 'renderer', 'components', 'subagent-cards-logic.js')).href);

const sub = (id, over = {}) => ({ id, agentId: 'a', title: `T ${id}`, type: 'Explore', state: 'running', background: false, counts: { tools: 0, errors: 0 }, startedAt: 1000, updatedAt: 1000, ...over });

test('splitSubagents: running (needs-you first, then oldest), failed/stopped kept visible, done folded', async () => {
  const L = await load();
  const subs = [
    sub('d1', { state: 'done', endedAt: 5000 }), sub('r2', { startedAt: 3000 }), sub('r1', { startedAt: 2000 }), sub('n1', { startedAt: 4000, needsYou: true }),
    sub('f1', { state: 'failed', endedAt: 6000 }), sub('s1', { state: 'stopped', endedAt: 7000 }), sub('d2', { state: 'done', endedAt: 9000 }),
  ];
  const r = L.splitSubagents(subs);
  assert.deepEqual(r.active.map((s) => s.id), ['n1', 'r1', 'r2']);
  assert.deepEqual(r.failed.map((s) => s.id), ['s1', 'f1']);
  assert.deepEqual(r.done.map((s) => s.id), ['d2', 'd1']);
  assert.deepEqual(L.splitSubagents(undefined), { active: [], failed: [], done: [] });
});

test('subModelLabel: modelLabel of the model, nothing when it is left out', async () => {
  const L = await load();
  assert.equal(L.subModelLabel({ model: 'claude-haiku-4-5-20251001' }), 'Haiku 4.5');
  assert.equal(L.subModelLabel({ model: 'opus' }), 'Opus');
  assert.equal(L.subModelLabel({}), '');
});

test('subDoing: needs you beats the tool; only running subagents show a tool', async () => {
  const L = await load();
  assert.equal(L.subDoing(sub('a', { tool: 'Grep', detail: 'verifyToken' })), 'Grep verifyToken');
  assert.equal(L.subDoing(sub('a', { tool: 'Read' })), 'Read');
  assert.equal(L.subDoing(sub('a', { tool: 'Grep', needsYou: true })), 'needs you');
  assert.equal(L.subDoing(sub('a', { state: 'done', tool: 'Grep' })), '');
  assert.equal(L.subDoing(sub('a')), '');
});

test('subElapsed: running counts to now, finished counts to its end', async () => {
  const L = await load();
  assert.equal(L.subElapsed(sub('a', { startedAt: 1000 }), 66000), '1m 05s');
  assert.equal(L.subElapsed(sub('a', { state: 'done', startedAt: 1000, endedAt: 15000 }), 999999), '14 s');
  assert.equal(L.subElapsed({ state: 'running' }), '');
});

test('cardLabel: type, title, state, model, tool and time in one sentence', async () => {
  const L = await load();
  const label = L.cardLabel(sub('a', { title: 'Find call sites', model: 'claude-haiku-4-5', tool: 'Grep', detail: 'x', startedAt: 1000 }), 13000);
  assert.equal(label, 'Explore subagent: Find call sites, running, model Haiku 4.5, using Grep x, 12 s');
  assert.match(L.cardLabel(sub('a', { needsYou: true }), 2000), /running, needs you, 1\.0 s$/);
  assert.doesNotMatch(L.cardLabel(sub('a'), 2000), /model/);
});

test('cardsKey changes with what the cards show, not with time', async () => {
  const L = await load();
  const a = [sub('a', { tool: 'Grep' })];
  assert.equal(L.cardsKey(a), L.cardsKey([sub('a', { tool: 'Grep', updatedAt: 99999 })]));
  assert.notEqual(L.cardsKey(a), L.cardsKey([sub('a', { tool: 'Read' })]));
  assert.notEqual(L.cardsKey(a), L.cardsKey([sub('a', { tool: 'Grep', model: 'haiku' })]));
  assert.notEqual(L.cardsKey(a), L.cardsKey([sub('a', { tool: 'Grep', state: 'done' })]));
});

test('summaryLine', async () => {
  const L = await load();
  assert.equal(L.summaryLine([sub('a'), sub('b', { needsYou: true }), sub('c', { state: 'done' }), sub('d', { state: 'done' }), sub('e', { state: 'failed' })]), '2 running · 1 needs you · ✓ 2 done · ✗ 1 failed');
  assert.equal(L.summaryLine([]), '');
});
