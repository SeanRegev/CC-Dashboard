// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { STATES } = require('../../packages/shared/protocol.js');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'app', 'src', 'renderer', 'logic.js')).href);

/** @param {string} name @param {string} state @param {any} [extra] */
const entry = (name, state, extra = {}) => ({
  agent: { id: name, name, spaceId: extra.spaceId || 'sp', createdAt: 0 },
  status: { agentId: name, state, updatedAt: extra.updatedAt || 0, needsSince: extra.needsSince, ...extra.status },
  running: true,
});

test('state order matches the protocol', async () => {
  const L = await load();
  assert.deepEqual([...L.STATE_ORDER], [...STATES]);
  for (const s of STATES) assert.match(L.stateColor(s), /^#[0-9A-F]{6}$/i);
});

test('status colours follow the palette', async () => {
  const L = await load();
  assert.equal(L.stateColor('needs_you'), '#F0B44C');
  assert.equal(L.stateColor('working'), '#86CF86');
  assert.equal(L.stateColor('idle'), '#B7ACF2');
  assert.equal(L.stateColor('nonsense'), L.stateColor('stopped'));
  assert.equal(L.stateLabel('idle'), 'Done');
  assert.equal(L.stateLabel('needs_you'), 'Needs you');
});

test('sortAgents: needs_you first (longest waiting first), then by state, then most recent', async () => {
  const L = await load();
  const sorted = L.sortAgents([
    entry('idle-old', 'idle', { updatedAt: 1 }),
    entry('working', 'working', { updatedAt: 5 }),
    entry('needs-new', 'needs_you', { needsSince: 200 }),
    entry('stopped', 'stopped', { updatedAt: 99 }),
    entry('idle-new', 'idle', { updatedAt: 9 }),
    entry('needs-old', 'needs_you', { needsSince: 100 }),
    entry('starting', 'starting'),
  ]);
  assert.deepEqual(sorted.map((e) => e.agent.name), ['needs-old', 'needs-new', 'working', 'starting', 'idle-new', 'idle-old', 'stopped']);
});

test('sortAgents does not mutate and tolerates missing status', async () => {
  const L = await load();
  const input = [entry('b', 'idle'), { agent: { id: 'a', name: 'a', spaceId: 'sp' } }];
  const copy = [...input];
  const out = L.sortAgents(input);
  assert.deepEqual(input, copy);
  assert.equal(out[out.length - 1].agent.name, 'a');
});

test('spaceCounts counts totals, needs and working per space', async () => {
  const L = await load();
  const c = L.spaceCounts([
    entry('a', 'needs_you', { spaceId: 'x' }), entry('b', 'working', { spaceId: 'x' }),
    entry('c', 'idle', { spaceId: 'x' }), entry('d', 'needs_you', { spaceId: 'y' }),
  ]);
  assert.deepEqual(c, { x: { total: 3, needs: 1, working: 1 }, y: { total: 1, needs: 1, working: 0 } });
});

test('formatRelativeTime', async () => {
  const L = await load();
  const now = 1_000_000_000;
  assert.equal(L.formatRelativeTime(undefined, now), '');
  assert.equal(L.formatRelativeTime(now - 3000, now), 'now');
  assert.equal(L.formatRelativeTime(now - 45_000, now), '45s');
  assert.equal(L.formatRelativeTime(now - 12 * 60_000, now), '12m');
  assert.equal(L.formatRelativeTime(now - 3 * 3600_000, now), '3h');
  assert.equal(L.formatRelativeTime(now - 3 * 86400_000, now), '3d');
  assert.equal(L.formatRelativeTime(now + 5000, now), 'now');
});

test('formatTokens', async () => {
  const L = await load();
  assert.equal(L.formatTokens(0), '0');
  assert.equal(L.formatTokens(undefined), '0');
  assert.equal(L.formatTokens(950), '950');
  assert.equal(L.formatTokens(1000), '1k');
  assert.equal(L.formatTokens(1234), '1.2k');
  assert.equal(L.formatTokens(48_200), '48k');
  assert.equal(L.formatTokens(1_340_000), '1.3M');
});

test('contextPercent and gaugeLevel', async () => {
  const L = await load();
  assert.equal(L.contextPercent(undefined), 0);
  assert.equal(L.contextPercent({ contextPct: 42.4 }), 42);
  assert.equal(L.contextPercent({ contextPct: 140 }), 100);
  assert.equal(L.contextPercent({ contextPct: -3 }), 0);
  assert.equal(L.contextPercent({ contextPct: NaN }), 0);
  assert.equal(L.gaugeLevel(10), 'low');
  assert.equal(L.gaugeLevel(70), 'mid');
  assert.equal(L.gaugeLevel(90), 'high');
});

test('modelLabel', async () => {
  const L = await load();
  assert.equal(L.modelLabel(''), 'Default');
  assert.equal(L.modelLabel(undefined), 'Default');
  assert.equal(L.modelLabel('opus'), 'Opus');
  assert.equal(L.modelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(L.modelLabel('claude-opus-4-1-20250805'), 'Opus 4.1');
  assert.equal(L.modelLabel('claude-haiku-4-5'), 'Haiku 4.5');
  assert.equal(L.modelLabel('claude-opus-4-20250514'), 'Opus 4');
  assert.equal(L.modelLabel('some-other-model'), 'some-other-model');
});

test('describeActivity and cardTime', async () => {
  const L = await load();
  assert.equal(L.describeActivity({ state: 'needs_you', message: 'Allow Bash?' }), 'Allow Bash?');
  assert.equal(L.describeActivity({ state: 'needs_you' }), 'Waiting for your input');
  assert.equal(L.describeActivity({ state: 'working', tool: 'Edit', detail: 'src/a.js' }), 'Edit · src/a.js');
  assert.equal(L.describeActivity({ state: 'working', tool: 'Grep' }), 'Grep');
  assert.equal(L.describeActivity({ state: 'working' }), 'Thinking…');
  assert.equal(L.describeActivity({ state: 'idle', lastPrompt: 'fix it' }), 'Done · fix it');
  assert.equal(L.describeActivity(undefined), 'No status yet');
  const now = 10_000_000;
  assert.equal(L.cardTime({ state: 'needs_you', needsSince: now - 120_000, updatedAt: now }, now), '2m');
  assert.equal(L.cardTime({ state: 'idle', updatedAt: now - 30_000 }, now), '30s');
});

/** @param {string} key @param {any} [m] */
const kev = (key, m = {}) => ({ key, code: m.code, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta });

test('shortcutFor: app shortcuts', async () => {
  const L = await load();
  assert.deepEqual(L.shortcutFor(kev('t', { ctrl: true, code: 'KeyT' })), { action: 'newAgent' });
  assert.deepEqual(L.shortcutFor(kev('w', { ctrl: true })), { action: 'closeTab' });
  assert.deepEqual(L.shortcutFor(kev('k', { ctrl: true })), { action: 'quickSwitch' });
  assert.deepEqual(L.shortcutFor(kev('Tab', { ctrl: true, code: 'Tab' })), { action: 'nextTab' });
  assert.deepEqual(L.shortcutFor(kev('Tab', { ctrl: true, shift: true, code: 'Tab' })), { action: 'prevTab' });
  assert.deepEqual(L.shortcutFor(kev('3', { ctrl: true, code: 'Digit3' })), { action: 'gotoTab', index: 2 });
  assert.deepEqual(L.shortcutFor(kev('&', { ctrl: true, code: 'Digit1' })), { action: 'gotoTab', index: 0 }); // AZERTY
  assert.deepEqual(L.shortcutFor(kev('\\', { ctrl: true, code: 'Backslash' })), { action: 'toggleSplit' });
  assert.deepEqual(L.shortcutFor(kev('T', { ctrl: true, code: 'KeyT' })), { action: 'newAgent' });
});

test('shortcutFor: terminal keys pass through untouched', async () => {
  const L = await load();
  for (const k of ['c', 'd', 'r', 'l', 'z', 'a', 'e', 'u', 'v', '0']) assert.equal(L.shortcutFor(kev(k, { ctrl: true })), null, `Ctrl+${k}`);
  assert.equal(L.shortcutFor(kev('t')), null);
  assert.equal(L.shortcutFor(kev('Enter')), null);
  assert.equal(L.shortcutFor(kev('Escape')), null);
  assert.equal(L.shortcutFor(kev('t', { ctrl: true, alt: true })), null); // AltGr combos
  assert.equal(L.shortcutFor(kev('Tab')), null);
  assert.equal(L.shortcutFor(kev('t', { meta: true })), null);
  assert.equal(L.shortcutFor(kev('T', { ctrl: true, shift: true })), null);
});

test('shortcutFor: copy/paste with Ctrl+Shift, Cmd on macOS', async () => {
  const L = await load();
  assert.deepEqual(L.shortcutFor(kev('C', { ctrl: true, shift: true, code: 'KeyC' })), { action: 'copy' });
  assert.deepEqual(L.shortcutFor(kev('V', { ctrl: true, shift: true, code: 'KeyV' })), { action: 'paste' });
  assert.deepEqual(L.shortcutFor(kev('t', { meta: true }), 'darwin'), { action: 'newAgent' });
  assert.equal(L.shortcutFor(kev('t', { ctrl: true }), 'darwin'), null);
  assert.equal(L.shortcutFor(kev('c', { ctrl: true }), 'darwin'), null);
});

test('cycleIndex wraps both ways', async () => {
  const L = await load();
  assert.equal(L.cycleIndex(0, 3, 1), 1);
  assert.equal(L.cycleIndex(2, 3, 1), 0);
  assert.equal(L.cycleIndex(0, 3, -1), 2);
  assert.equal(L.cycleIndex(-1, 3, 1), 0);
  assert.equal(L.cycleIndex(-1, 3, -1), 2);
  assert.equal(L.cycleIndex(0, 0, 1), -1);
});

test('filterAgents: name prefix ranks first, subsequence matches, empty query = sidebar order', async () => {
  const L = await load();
  const list = [entry('docs-pass', 'idle'), entry('refactor-auth', 'needs_you', { needsSince: 1 }), entry('fix-flaky', 'working'), entry('api', 'idle', { spaceId: 'storefront' })];
  assert.deepEqual(L.filterAgents('', list).map((e) => e.agent.name), ['refactor-auth', 'fix-flaky', 'api', 'docs-pass']);
  assert.deepEqual(L.filterAgents('fix', list).map((e) => e.agent.name), ['fix-flaky']);
  assert.deepEqual(L.filterAgents('rfa', list).map((e) => e.agent.name), ['refactor-auth']);
  assert.deepEqual(L.filterAgents('store', list, { storefront: { name: 'storefront' } }).map((e) => e.agent.name), ['api']);
  assert.deepEqual(L.filterAgents('zzz', list), []);
});

test('suggestAgentName avoids names taken in the space', async () => {
  const L = await load();
  assert.equal(L.suggestAgentName([], 's'), 'agent-1');
  assert.equal(L.suggestAgentName([entry('agent-1', 'idle', { spaceId: 's' }), entry('agent-2', 'idle', { spaceId: 's' })], 's'), 'agent-3');
  assert.equal(L.suggestAgentName([entry('agent-1', 'idle', { spaceId: 'other' })], 's'), 'agent-1');
});

test('backoffDelay grows exponentially, is capped, and jitters', async () => {
  const L = await load();
  const mid = () => 0.5;
  assert.equal(L.backoffDelay(0, {}, mid), 250);
  assert.equal(L.backoffDelay(1, {}, mid), 500);
  assert.equal(L.backoffDelay(3, {}, mid), 2000);
  assert.equal(L.backoffDelay(20, {}, mid), 5000);
  assert.equal(L.backoffDelay(0, { jitter: 0.2 }, () => 0), 200);
  assert.equal(L.backoffDelay(0, { jitter: 0.2 }, () => 1), 300);
});

test('split layout: toggle, show, close', async () => {
  const L = await load();
  let lay = { panes: ['a'], focused: 0 };
  lay = L.toggleSplit(lay, ['a', 'b', 'c']);
  assert.deepEqual(lay, { panes: ['a', 'b'], focused: 1 });
  lay = L.showInPane(lay, 'c');
  assert.deepEqual(lay, { panes: ['a', 'c'], focused: 1 });
  lay = L.showInPane(lay, 'a'); // already visible: focus moves instead of duplicating
  assert.deepEqual(lay, { panes: ['a', 'c'], focused: 0 });
  assert.deepEqual(L.toggleSplit(lay, ['a', 'b', 'c']), { panes: ['a'], focused: 0 });
  // split with a single tab gives an empty second pane
  assert.deepEqual(L.toggleSplit({ panes: ['a'], focused: 0 }, ['a']), { panes: ['a', null], focused: 1 });
  // closing a visible tab pulls in a tab that is not on screen
  assert.deepEqual(L.closeInLayout({ panes: ['a', 'c'], focused: 1 }, 'c', ['a', 'b']), { panes: ['a', 'b'], focused: 1 });
  // nothing left to show: the split collapses
  assert.deepEqual(L.closeInLayout({ panes: ['a', 'c'], focused: 1 }, 'c', ['a']), { panes: ['a'], focused: 0 });
  assert.deepEqual(L.closeInLayout({ panes: ['a', 'c'], focused: 0 }, 'a', ['c']), { panes: ['c'], focused: 0 });
  assert.deepEqual(L.closeInLayout({ panes: ['a'], focused: 0 }, 'a', []), { panes: [null], focused: 0 });
  // showing in an empty layout
  assert.deepEqual(L.showInPane({ panes: [null], focused: 0 }, 'x'), { panes: ['x'], focused: 0 });
});
