// @ts-check
'use strict';
// Pure helpers of the activity drawer / subagent strip, and the copy of SUBAGENT_TYPES.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const proto = require('../../packages/shared/protocol.js');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'app', 'src', 'renderer', 'components', 'activity-logic.js')).href);

test('renderer SUBAGENT_TYPES is an exact copy of protocol.js', async () => {
  const L = await load();
  assert.deepEqual(JSON.parse(JSON.stringify(L.SUBAGENT_TYPES)), JSON.parse(JSON.stringify(proto.SUBAGENT_TYPES)));
  assert.equal(L.SUBAGENT_DEFAULT_EMOJI, proto.SUBAGENT_DEFAULT_EMOJI);
});

test('typeInfo / subagentTitle: known types, plugin types, missing title', async () => {
  const L = await load();
  assert.deepEqual(L.typeInfo('Explore'), { emoji: '🔭', label: 'Explore' });
  assert.deepEqual(L.typeInfo('my-plugin:reviewer'), { emoji: '🤖', label: 'my-plugin:reviewer' });
  assert.equal(L.typeInfo(undefined).emoji, '🤖');
  assert.equal(L.subagentTitle({ title: ' Find token call sites ', type: 'Explore' }), 'Find token call sites');
  assert.equal(L.subagentTitle({ title: '', type: 'Plan' }), 'Plan');
});

test('formatDuration', async () => {
  const L = await load();
  assert.equal(L.formatDuration(12), '12 ms');
  assert.equal(L.formatDuration(1234), '1.2 s');
  assert.equal(L.formatDuration(14000), '14 s');
  assert.equal(L.formatDuration(245000), '4m 05s');
  assert.equal(L.formatDuration(3720000), '1h 02m');
  assert.equal(L.formatDuration(-1), '');
  assert.equal(L.formatDuration(undefined), '');
  assert.equal(L.formatDuration(NaN), '');
});

test('subagentDuration: running counts to now, finished stops at endedAt', async () => {
  const L = await load();
  assert.equal(L.subagentDuration({ state: 'running', startedAt: 1000 }, 66000), '1m 05s');
  assert.equal(L.subagentDuration({ state: 'done', startedAt: 1000, endedAt: 5000 }, 99999999), '4.0 s');
  assert.equal(L.subagentDuration({ state: 'running', startedAt: 0 }, 5), '');
});

test('formatTime is HH:MM:SS local', async () => {
  const L = await load();
  const d = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(L.formatTime(d.getTime()), '03:04:05');
});

test('mergeEntries: by seq, no duplicates, sorted, newest kept, inputs untouched', async () => {
  const L = await load();
  const a = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
  const b = [{ seq: 3, x: 1 }, { seq: 4 }, { seq: 0 }];
  const m = L.mergeEntries(a, b);
  assert.deepEqual(m.map((e) => e.seq), [0, 1, 2, 3, 4]);
  assert.equal(m.find((e) => e.seq === 3).x, 1, 'incoming wins');
  assert.equal(a.length, 3);
  assert.deepEqual(L.mergeEntries(m, b).map((e) => e.seq), [0, 1, 2, 3, 4], 'merging twice changes nothing');
  assert.deepEqual(L.mergeEntries(a, [{ seq: 4 }, { seq: 5 }], 3).map((e) => e.seq), [3, 4, 5]);
  assert.deepEqual(L.mergeEntries([], []), []);
});

test('filterEntries / listParams: null = all, "" = the session, id = one subagent', async () => {
  const L = await load();
  const es = [{ seq: 1, subagentId: '' }, { seq: 2, subagentId: 'a' }, { seq: 3, subagentId: 'b' }, { seq: 4 }];
  assert.equal(L.filterEntries(es, null).length, 4);
  assert.deepEqual(L.filterEntries(es, '').map((e) => e.seq), [1, 4]);
  assert.deepEqual(L.filterEntries(es, 'a').map((e) => e.seq), [2]);
  assert.deepEqual(L.listParams(null), {});
  assert.deepEqual(L.listParams(''), { subagentId: '' });
  assert.deepEqual(L.listParams('a'), { subagentId: 'a' });
  assert.equal(L.initialFilter({ agentId: 'x', subagentId: 'a' }), 'a');
  assert.equal(L.initialFilter({ agentId: 'x' }), null);
});

test('toggleTarget: open, switch, close', async () => {
  const L = await load();
  assert.deepEqual(L.toggleTarget(null, 'a'), { agentId: 'a' });
  assert.deepEqual(L.toggleTarget({ agentId: 'a' }, 'b'), { agentId: 'b' });
  assert.equal(L.toggleTarget({ agentId: 'a' }, 'a'), null);
  assert.equal(L.toggleTarget({ agentId: 'a', subagentId: 's' }, 'a'), null);
  assert.equal(L.toggleTarget({ agentId: 'a' }, null), null);
  assert.equal(L.toggleTarget(null, null), null);
});

test('describeEntry: tools, errors, permission, subagent lines, who column', async () => {
  const L = await load();
  const subs = { s1: { id: 's1', title: 'Find token call sites', type: 'Explore' } };
  const lookup = (/** @type {string} */ id) => subs[id] || null;
  const t = L.describeEntry({ seq: 1, at: 0, subagentId: '', kind: 'tool', tool: 'Bash', detail: 'npm test' }, lookup);
  assert.equal(t.who, 'Session');
  assert.equal(t.label, 'Bash');
  assert.equal(t.detail, 'npm test');
  assert.equal(t.dur, '');
  const d = L.describeEntry({ seq: 2, at: 0, subagentId: 's1', kind: 'tool_done', tool: 'Bash', detail: 'npm test', ms: 4200 }, lookup);
  assert.equal(d.who, '🔭 Find token call sites');
  assert.equal(d.dur, '4.2 s');
  assert.equal(d.error, false);
  const err = L.describeEntry({ seq: 3, at: 0, subagentId: '', kind: 'tool_error', tool: 'Bash', detail: 'npm test', ms: 90, text: 'exit 1' });
  assert.equal(err.error, true);
  assert.equal(err.detail, 'npm test: exit 1');
  assert.equal(L.describeEntry({ seq: 4, at: 0, subagentId: '', kind: 'permission', tool: 'Bash' }).needs, true);
  assert.equal(L.describeEntry({ seq: 5, at: 0, subagentId: 'zz', kind: 'subagent_start', text: 'Plan it', type: 'Plan' }).detail, '"Plan it" (Plan)');
  assert.match(L.describeEntry({ seq: 6, at: 0, subagentId: 'zz', kind: 'tool' }).who, /^🤖 subagent$/, 'unknown subagent');
  assert.equal(L.describeEntry({ seq: 7, at: 0, subagentId: '', kind: 'prompt', text: 'Fix it' }).detail, 'Fix it');
  assert.equal(L.describeEntry({ seq: 8, at: 0, subagentId: '', kind: 'weird' }).icon, '·');
});

test('atBottom, windowOf', async () => {
  const L = await load();
  assert.equal(L.atBottom({ scrollTop: 500, clientHeight: 400, scrollHeight: 910 }), true);
  assert.equal(L.atBottom({ scrollTop: 100, clientHeight: 400, scrollHeight: 910 }), false);
  const many = Array.from({ length: 800 }, (_, i) => ({ seq: i + 1 }));
  assert.equal(L.windowOf(many).length, L.MAX_LINES);
  assert.equal(L.windowOf(many)[L.MAX_LINES - 1].seq, 800, 'the newest are kept');
  assert.equal(L.windowOf(many.slice(0, 3)).length, 3);
});

test('stripModel: running first (needs-you before the rest), +N, done and failed counts', async () => {
  const L = await load();
  const subs = [
    { id: '1', state: 'done', startedAt: 1 }, { id: '2', state: 'running', startedAt: 5 }, { id: '3', state: 'running', startedAt: 3 },
    { id: '4', state: 'running', startedAt: 9, needsYou: true }, { id: '5', state: 'running', startedAt: 2 }, { id: '6', state: 'failed', startedAt: 1 }, { id: '7', state: 'stopped' },
  ];
  const m = L.stripModel(subs, 3);
  assert.deepEqual(m.chips.map((s) => s.id), ['4', '5', '3']);
  assert.equal(m.more, 1);
  assert.equal(m.done, 1);
  assert.equal(m.failed, 1);
  assert.equal(m.needs, 1);
  assert.notEqual(L.stripKey(subs), L.stripKey(subs.map((s) => (s.id === '3' ? { ...s, tool: 'Read' } : s))), 'a changed tool on a visible chip changes the key');
  assert.deepEqual(L.stripModel([]), { chips: [], more: 0, done: 0, failed: 0, needs: 0 });
});

test('badgeCount prefers the live list, falls back to status.subagents', async () => {
  const L = await load();
  assert.equal(L.badgeCount([{ state: 'running' }, { state: 'done' }, { state: 'running' }], undefined), 2);
  assert.equal(L.badgeCount([], { subagents: { running: 3, total: 4 } }), 3);
  assert.equal(L.badgeCount([], {}), 0);
});

test('askedByInfo: the subagent a prompt came from', async () => {
  const L = await load();
  const subs = [{ id: 'a', title: 'Update middleware tests', type: 'general-purpose' }];
  assert.deepEqual(L.askedByInfo(subs, 'a'), { id: 'a', emoji: '🔧', title: 'Update middleware tests' });
  assert.deepEqual(L.askedByInfo(subs, 'zz'), { id: 'zz', emoji: '🤖', title: '' });
  assert.equal(L.askedByInfo(subs, ''), null);
  assert.equal(L.askedByInfo(subs, undefined), null);
});
