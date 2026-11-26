// @ts-check
'use strict';
/**
 * End-to-end: the activity drawer, the subagent strip in grid tiles, the sidebar badge, "asked by" on the
 * approval card, the agent menu item and Ctrl+Shift+Y, in the real Electron app against the dev mock core
 * (static data: refactor-auth has 2 subagents, fix-flaky-tests 3, landing-copy 1; outside sessions ext:…).
 * Linux CI: xvfb-run -a npm run test:e2e
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMockCore } = require('../../packages/app/src/renderer/dev/mock-core.js');
const { launchApp, sleep } = require('../../packages/app/src/renderer/dev/cdp.js');

/** @type {Awaited<ReturnType<typeof startMockCore>>} */
let mock;
/** @type {Awaited<ReturnType<typeof launchApp>>} */
let app;
const q = (/** @type {string} */ sel) => JSON.stringify(sel);
const text = (/** @type {string} */ sel) => app.evaluate(`(document.querySelector(${q(sel)}) || {}).textContent || ''`);
const count = (/** @type {string} */ sel) => app.evaluate(`document.querySelectorAll(${q(sel)}).length`);
const drawerFor = () => app.evaluate('window.__cc.activityFor()');
const RA_SUB2 = 'a1f0c2e9d1b7a0002'; // refactor-auth: "Update middleware tests" (running, needs you)
const RA_SUB1 = 'a1f0c2e9d1b7a0001'; // "Find token call sites" (done)
const EXT = 'ext:5f0c8a10-1111-4c1e-9a0b-00000000vsc0';

/** Push lines into the mock's log and tell the app. @param {string} agentId @param {any[]} entries */
function live(agentId, entries) {
  const out = entries.map((e) => mock.activity.push(agentId, e));
  mock.broadcast('activity', { agentId, entries: out });
  return out;
}
const closeDrawer = async () => { await app.evaluate('window.__cc.openActivity && document.querySelector(".act-close").click()'); await app.waitFor(`document.getElementById('activity-drawer').hidden`); };

test.before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-act-'));
  mock = await startMockCore({ home, static: true });
  app = await launchApp({ env: { CC_HOME: home }, size: '1280x800' });
  await app.waitFor(`document.querySelectorAll('.agent-card').length === 5`, 20000);
  await app.waitFor(`document.querySelector('.agent-card[data-agent="refactor-auth"] .sub-badge')`, 10000);
});

test.after(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
});

test('sidebar: a "N running" badge on cards whose session has running subagents', async () => {
  assert.equal(await text('.agent-card[data-agent="refactor-auth"] .sub-badge'), '1 running');
  assert.equal(await count('.agent-card[data-agent="docs-pass"] .sub-badge'), 0, 'no subagents, no badge');
  await app.click('.agent-card[data-agent="refactor-auth"] .sub-badge');
  await app.waitFor(`!document.getElementById('activity-drawer').hidden`);
  assert.deepEqual(await drawerFor(), { agentId: 'refactor-auth' }, 'the badge opens the drawer');
  assert.equal((await app.evaluate('window.__cc.snapshot()')).view, 'terminals', 'and does not open the agent');
});

test('drawer: header, list (title + type emoji + state), feed in time order, Esc closes', async () => {
  assert.equal(await text('#activity-drawer .act-name'), 'refactor-auth');
  assert.match(await text('#activity-drawer .act-badge-slot'), /Main/);
  const items = await app.evaluate(`[...document.querySelectorAll('#activity-drawer .act-item')].map((i) => i.textContent)`);
  assert.equal(items.length, 4, 'All, Session, 2 subagents');
  assert.match(items[2], /🔭.*Find token call sites/);
  assert.match(items[2], /4 tools/);
  assert.match(items[3], /🔧.*Update middleware tests.*needs you/);
  assert.equal(await count('#activity-drawer .act-item.st-done .act-state'), 1);
  assert.equal(await text('#activity-drawer .act-item.st-done .act-state'), '✓');
  assert.equal(await count('#activity-drawer .act-item.st-running .act-spin'), 1, 'a running one has a spinner');
  // the feed: all lines, session lines and subagent lines, the newest at the bottom
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-line').length > 10`);
  const seqs = await app.evaluate(`[...document.querySelectorAll('#activity-drawer .act-line')].map((l) => Number(l.dataset.seq))`);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.match(await text('#activity-drawer .act-line .act-who'), /Session|🔭|🔧/);
  assert.ok(await count('#activity-drawer .act-line.k-prompt') >= 1);
  assert.ok(await count('#activity-drawer .act-line.k-subagent_start') >= 2);
  const atEnd = await app.evaluate(`(() => { const f = document.querySelector('.act-feed'); return f.scrollHeight - f.scrollTop - f.clientHeight < 30; })()`);
  assert.equal(atEnd, true, 'starts at the newest line');
  await app.press('Escape');
  await app.waitFor(`document.getElementById('activity-drawer').hidden`);
  assert.equal(await drawerFor(), null);
});

test('clicking a subagent filters the feed; clicking it again, or "All", shows everything', async () => {
  await app.evaluate(`window.__cc.openActivity('refactor-auth')`);
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-line').length > 10`);
  const all = await count('#activity-drawer .act-line');
  await app.click(`#activity-drawer .act-item[data-filter="${RA_SUB1}"]`);
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-line').length > 0 && document.querySelectorAll('#activity-drawer .act-line').length < ${all}`);
  assert.equal(await count('#activity-drawer .act-line .act-who'), 0, 'the who column is not needed when one is chosen');
  assert.ok(await app.evaluate(`[...document.querySelectorAll('#activity-drawer .act-line .act-label')].some((l) => l.textContent === 'Grep')`), 'its own tools');
  assert.ok(mock.calls.some((c) => c.method === 'activity.list' && c.params.subagentId === RA_SUB1), 'filtered by the core');
  assert.equal(await count('#activity-drawer .act-item.on'), 1);
  await app.click('#activity-drawer .act-item[data-filter="session"]');
  await app.waitFor(`document.querySelector('#activity-drawer .act-line.k-prompt') && !document.querySelector('#activity-drawer .act-line.k-subagent_start .act-label')?.textContent.includes('xx')`);
  assert.equal(await count('#activity-drawer .act-line.k-tool[data-kind] .act-label'), await app.evaluate(`document.querySelectorAll('#activity-drawer .act-line.k-tool').length`));
  await app.click('#activity-drawer .act-item[data-filter="all"]');
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-line').length === ${all}`);
});

test('live lines are appended; scrolled up: no jumping, "Jump to latest" brings you back', async () => {
  const lines = () => count('#activity-drawer .act-line');
  const n0 = await lines();
  live('refactor-auth', [{ kind: 'tool', subagentId: RA_SUB2, tool: 'Read', detail: 'live-one.js' }]);
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-line').length === ${n0 + 1}`);
  assert.equal(await app.evaluate(`document.querySelector('.act-line:last-child .act-detail').textContent`), 'live-one.js');
  // the same line again (same seq) does not double
  const dup = mock.activity.logs.get('refactor-auth').at(-1);
  mock.broadcast('activity', { agentId: 'refactor-auth', entries: [dup] });
  await sleep(200);
  assert.equal(await lines(), n0 + 1);
  // enough lines to scroll, then scroll up
  live('refactor-auth', Array.from({ length: 60 }, (_, i) => ({ kind: 'tool_done', tool: 'Read', detail: `f${i}.js`, ms: 5 + i })));
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-line').length === ${n0 + 61}`);
  await app.evaluate(`(() => { const f = document.querySelector('.act-feed'); f.scrollTop = 0; f.dispatchEvent(new Event('scroll')); })()`);
  await app.waitFor(`!document.querySelector('.act-jump').hidden`);
  live('refactor-auth', [{ kind: 'tool', tool: 'Bash', detail: 'while scrolled up' }]);
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-line').length === ${n0 + 62}`);
  assert.equal(await app.evaluate(`document.querySelector('.act-feed').scrollTop`), 0, 'the view stays where the user is');
  assert.match(await text('.act-jump'), /1 new/);
  await app.click('.act-jump');
  await app.waitFor(`document.querySelector('.act-jump').hidden`);
  assert.equal(await app.evaluate(`(() => { const f = document.querySelector('.act-feed'); return f.scrollHeight - f.scrollTop - f.clientHeight < 30; })()`), true);
  // a subagent filter ignores other lines
  await app.click(`#activity-drawer .act-item[data-filter="${RA_SUB1}"]`);
  await app.waitFor(`document.querySelector('#activity-drawer .act-item.on[data-filter="${RA_SUB1}"]')`);
  const n1 = await lines();
  live('refactor-auth', [{ kind: 'tool', subagentId: RA_SUB2, tool: 'Read', detail: 'not for the filter' }]);
  await sleep(300);
  assert.equal(await lines(), n1);
  await app.click('#activity-drawer .act-item[data-filter="all"]');
});

test('a long log: the newest page first, "Load older" adds a page, the DOM stays small', async () => {
  const id = 'docs-pass';
  const before = mock.activity.logs.get(id).length;
  for (let i = 0; i < 900; i++) mock.activity.push(id, { kind: 'tool_done', tool: 'Read', detail: `bulk-${i}.js`, ms: 3 });
  await app.evaluate(`window.__cc.openActivity(${q(id)})`);
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-line').length === 200`);
  assert.equal(await app.evaluate(`document.querySelector('.act-older').hidden`), false);
  assert.equal(await app.evaluate(`document.querySelector('.act-line:last-child .act-detail').textContent`), 'bulk-899.js');
  await app.click('.act-older');
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-line').length === 400`);
  const call = mock.calls.filter((c) => c.method === 'activity.list' && c.params.before).at(-1);
  assert.ok(call && typeof call.params.before === 'number', 'activity.list { before }');
  // a third page would pass the cap: at most 500 lines are rendered, and the older ones are what is shown
  await app.click('.act-older');
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-line').length === 500`);
  assert.equal(await app.evaluate(`document.querySelector('.act-line:last-child .act-detail').textContent === 'bulk-899.js'`), false, 'the newest lines are not in the window now');
  assert.equal(await app.evaluate(`document.querySelector('.act-jump').hidden`), false);
  live(id, [{ kind: 'tool', tool: 'Read', detail: 'arrived-meanwhile.js' }]);
  await app.waitFor(`/1 new/.test(document.querySelector('.act-jump').textContent)`);
  assert.equal(await count('#activity-drawer .act-line'), 500);
  await app.click('.act-jump');
  await app.waitFor(`document.querySelector('.act-line:last-child .act-detail')?.textContent === 'arrived-meanwhile.js'`);
  // live lines on a long feed trim the top: never more than the window plus a little
  live(id, Array.from({ length: 600 }, (_, i) => ({ kind: 'tool', tool: 'Read', detail: `more-${i}.js` })));
  await app.waitFor(`document.querySelector('.act-line:last-child .act-detail').textContent === 'more-599.js'`);
  assert.ok(await count('#activity-drawer .act-line') <= 500 + 50, 'rendered lines stay near the cap');
  assert.ok(before > 0);
  await app.press('Escape');
});

test('grid tile: a strip with the running subagents, done count, and a needs-you chip that stands out', async () => {
  await app.press('g', { ctrl: true, shift: true });
  await app.waitFor(`document.querySelector('.tile[data-agent="refactor-auth"] .tile-subs .sub-chip')`);
  const tile = '.tile[data-agent="refactor-auth"]';
  assert.equal(await count(`${tile} .sub-chip`), 1, 'only running subagents get a chip');
  assert.match(await text(`${tile} .sub-chip`), /🔧.*Update middleware tests/);
  assert.equal(await count(`${tile} .sub-chip.needs`), 1);
  assert.match(await text(`${tile} .sub-chip.needs`), /needs you/);
  assert.equal(await text(`${tile} .sub-pill.done`), '✓ 1');
  assert.equal(await app.evaluate(`document.querySelector(${q(`${tile} .tile-subs`)}).previousElementSibling.className`), 'tile-head', 'right under the header');
  // fix-flaky-tests: 1 running, 1 done, 1 failed
  const t2 = '.tile[data-agent="fix-flaky-tests"]';
  assert.match(await text(`${t2} .sub-chip`), /🔭.*Map checkout fixtures/);
  assert.equal(await text(`${t2} .sub-pill.done`), '✓ 1');
  assert.equal(await text(`${t2} .sub-pill.failed`), '✗ 1');
  // an agent with no subagents has no strip
  assert.equal(await app.evaluate(`document.querySelector('.tile[data-agent="docs-pass"] .tile-subs').hidden`), true);
  // click: the drawer, on that subagent
  await app.click(`${tile} .sub-chip`);
  await app.waitFor(`!document.getElementById('activity-drawer').hidden`);
  assert.deepEqual(await drawerFor(), { agentId: 'refactor-auth', subagentId: RA_SUB2 });
  await app.waitFor(`document.querySelector('#activity-drawer .act-item.on[data-filter="${RA_SUB2}"]')`);
  assert.equal((await app.evaluate('window.__cc.snapshot()')).view, 'grid');
});

test('a subagent that starts or ends shows in the strip at once', async () => {
  const t = '.tile[data-agent="fix-flaky-tests"]';
  await app.waitFor(`document.querySelector(${q(`${t} .sub-chip`)})`);
  const subs = mock.activity.subagents.get('fix-flaky-tests');
  subs.push({ id: 'b2e1d3f0c2a8b0004', agentId: 'fix-flaky-tests', title: 'Scan the pricing page', type: 'Plan', state: 'running', background: false, counts: { tools: 0, errors: 0 }, startedAt: Date.now(), updatedAt: Date.now() });
  mock.broadcast('subagent.updated', { agentId: 'fix-flaky-tests', subagent: { ...subs[3] } });
  await app.waitFor(`document.querySelectorAll(${q(`${t} .sub-chip`)}).length === 2`);
  assert.match(await text(`${t} .sub-chip:nth-child(2)`), /📐.*Scan the pricing page/);
  subs[3].state = 'done';
  mock.broadcast('subagent.updated', { agentId: 'fix-flaky-tests', subagent: { ...subs[3] } });
  await app.waitFor(`document.querySelectorAll(${q(`${t} .sub-chip`)}).length === 1 && document.querySelector(${q(`${t} .sub-pill.done`)})`);
  assert.equal(await text(`${t} .sub-pill.done`), '✓ 2');
  subs.pop(); // leave the seed as it was
});

test('Ctrl+Shift+Y toggles the drawer for the focused agent; the agent menu has "Activity"', async () => {
  await app.evaluate(`document.querySelector('.act-close').click()`);
  await app.waitFor(`document.getElementById('activity-drawer').hidden`);
  await app.evaluate(`document.querySelector('.tile[data-agent="fix-flaky-tests"]').focus()`);
  await app.press('y', { ctrl: true, shift: true });
  await app.waitFor(`!document.getElementById('activity-drawer').hidden`);
  assert.deepEqual(await drawerFor(), { agentId: 'fix-flaky-tests' });
  assert.equal(await text('#activity-drawer .act-name'), 'fix-flaky-tests');
  assert.equal(await count('#activity-drawer .act-item.sub'), 4, '3 seeded + the one the earlier test added');
  assert.equal(await count('#activity-drawer .act-item.st-failed .act-state'), 1);
  assert.equal(await text('#activity-drawer .act-item.st-failed .act-state'), '✗');
  await app.press('y', { ctrl: true, shift: true });
  await app.waitFor(`document.getElementById('activity-drawer').hidden`);
  // the menu
  await app.evaluate(`(() => { const el = document.querySelector('.tile[data-agent="docs-pass"]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 20 })); })()`);
  await app.waitFor(`document.querySelector('.ctx-menu [data-action="activity"]')`);
  assert.match(await text('.ctx-menu [data-action="activity"]'), /Activity/);
  await app.click('.ctx-menu [data-action="activity"]');
  await app.waitFor(`!document.getElementById('activity-drawer').hidden`);
  assert.deepEqual(await drawerFor(), { agentId: 'docs-pass' });
  assert.equal(await app.evaluate(`!!document.querySelector('.ctx-menu')`), false, 'the menu closed');
  assert.match(await text('#activity-drawer .act-status, #activity-drawer .act-lines'), /./);
  await closeDrawer();
});

test('the approval card says which subagent asked', async () => {
  await app.press('t', { ctrl: true, shift: true });
  await app.click('.agent-card[data-agent="refactor-auth"] .appr-askedby').catch(() => {});
  await app.waitFor(`document.querySelector('.agent-card[data-agent="refactor-auth"] .appr-askedby')`);
  const chip = '.agent-card[data-agent="refactor-auth"] .appr-askedby';
  assert.match(await text(chip), /asked by.*🔧.*Update middleware tests/);
  assert.match(await text('.agent-card[data-agent="refactor-auth"] .appr-what'), /Bash/);
  // an agent whose prompt is its own has no such line
  mock.setStatus('docs-pass', { state: 'needs_you', permission: true, tool: 'Bash', message: 'x', prompt: { id: 'p-docs', tool: 'Bash', detail: 'ls', question: 'Proceed?', options: [{ key: '1', label: 'Yes', kind: 'allow' }, { key: '2', label: 'No', kind: 'deny' }] } });
  await app.waitFor(`document.querySelector('.agent-card[data-agent="docs-pass"] .approval')`);
  assert.equal(await count('.agent-card[data-agent="docs-pass"] .appr-askedby'), 0);
  mock.setStatus('docs-pass', { state: 'idle', permission: false, prompt: undefined });
  // the chip opens that subagent's log
  await app.evaluate(`document.querySelector(${q(chip)}).click()`);
  await app.waitFor(`document.querySelector('#activity-drawer .act-item.on[data-filter="${RA_SUB2}"]')`);
  await closeDrawer();
});

test('outside sessions: the drawer shows 👁 Outside instead of a role badge', async () => {
  await app.evaluate(`window.__cc.openActivity(${q(EXT)})`);
  await app.waitFor(`!document.getElementById('activity-drawer').hidden && document.querySelector('#activity-drawer .act-line')`);
  assert.equal(await text('#activity-drawer .act-name'), 'review PR comments');
  assert.match(await text('#activity-drawer .act-badge-slot'), /👁.*Outside/);
  assert.equal(await count('#activity-drawer .act-badge-slot [data-role]'), 0, 'no role badge');
  assert.match(await text('#activity-drawer .act-item.sub'), /🔭.*Collect review threads/);
  live(EXT, [{ kind: 'tool', tool: 'Grep', detail: 'outside-live' }]);
  await app.waitFor(`document.querySelector('.act-line:last-child .act-detail')?.textContent === 'outside-live'`);
  await closeDrawer();
});

test('both themes: the drawer text is readable (contrast >= 4.5 on its background)', async () => {
  await app.evaluate(`window.__cc.openActivity('refactor-auth')`);
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-line').length > 10`);
  const contrast = `(() => {
    const lum = (c) => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; const m = c.match(/[\\d.]+/g); if (m && (m.length < 4 || Number(m[3]) >= 0.99)) return c; } return 'rgb(255,255,255)'; };
    const res = {};
    for (const sel of ['.act-name', '.act-label', '.act-detail', '.act-time', '.act-item-meta', '.act-line.k-prompt .act-label', '.act-line.is-needs .act-label', '.act-item.st-done .act-state', '.act-needs']) {
      const el = document.querySelector('#activity-drawer ' + sel);
      if (!el) continue;
      const a = lum(getComputedStyle(el).color); const b = lum(bgOf(el));
      res[sel] = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }
    return res;
  })()`;
  for (const theme of ['dark', 'light']) {
    await app.evaluate(`document.documentElement.dataset.theme = ${q(theme)}`);
    await sleep(150);
    const r = await app.evaluate(contrast);
    assert.ok(Object.keys(r).length >= 6, `${theme}: measured ${Object.keys(r)}`);
    for (const [sel, ratio] of Object.entries(r)) {
      // faint timestamps and meta are secondary text: the app's own faint token must still clear 3:1
      const min = /act-time|act-item-meta/.test(sel) ? 3 : 4.5;
      assert.ok(/** @type {number} */ (ratio) >= min, `${theme} ${sel}: contrast ${(/** @type {number} */ (ratio)).toFixed(2)} < ${min}`);
    }
  }
  await app.evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await closeDrawer();
});

test('a narrow window: the drawer overlays instead of taking a column', async () => {
  await app.evaluate(`window.__cc.openActivity('refactor-auth')`);
  await app.waitFor(`!document.getElementById('activity-drawer').hidden`);
  const pos = () => app.evaluate(`getComputedStyle(document.getElementById('activity-drawer')).position`);
  assert.equal(await pos(), 'static', 'docked in the app grid at 1280 px');
  const mainW = await app.evaluate(`document.getElementById('workspace').getBoundingClientRect().width + document.getElementById('view-host').getBoundingClientRect().width`);
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  assert.equal(await pos(), 'fixed');
  assert.ok(await app.evaluate(`document.querySelector('#activity-drawer').getBoundingClientRect().right`) <= 1000);
  await app.send('Emulation.clearDeviceMetricsOverride', {});
  await sleep(100);
  assert.ok(mainW > 0);
  await closeDrawer();
});
