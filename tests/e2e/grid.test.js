// @ts-check
'use strict';
/**
 * End-to-end: the Grid view (10 agents in one space), the sidebar's "All spaces" mode and the agent
 * context menu, against the dev mock core. Linux: xvfb-run -a npm run test:e2e
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
const until = async (/** @type {() => any} */ fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout'); };
const termText = (/** @type {string} */ id) => app.evaluate(`window.__cc.termText(${JSON.stringify(id)}) || ''`);
const tileSel = (/** @type {string} */ id) => `.tile[data-agent="${id}"]`;
const live = () => app.evaluate(`[...document.querySelectorAll('.tile')].map((t) => t.dataset.live === 'true')`);
const scrollTo = (/** @type {number|string} */ top) => app.evaluate(`(() => { const s = document.querySelector('.grid-scroll'); s.scrollTop = ${top}; return s.scrollTop; })()`);
const contextMenu = (/** @type {string} */ sel) => app.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 20 })); return !!document.querySelector('.ctx-menu'); })()`);

const ORDER = ['agent-01', 'agent-03', 'agent-08', 'agent-06', 'agent-04', 'agent-09', 'agent-02', 'agent-07', 'agent-05', 'agent-10'];

test.before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-grid-'));
  mock = await startMockCore({ home, static: true, many: 10 });
  // GRID_SIZE: e.g. 1024x740 to check a small window (Windows CI clamps the window to its 1024x768 screen).
  app = await launchApp({ env: { CC_HOME: home }, size: process.env.GRID_SIZE || '1280x800' });
  await app.waitFor(`document.querySelectorAll('.agent-card').length > 0`, 15000);
});

test.after(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
});

test('clicking a space selects it and shows the Grid: Main first, then needs you, working, starting, done, stopped', async () => {
  await app.click('.space[data-space="big-project"]');
  await app.waitFor(`window.__cc.snapshot().view === 'grid' && document.querySelectorAll('.tile').length === 10`);
  assert.equal(await app.evaluate(`window.__cc.snapshot().currentSpace`), 'big-project');
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('.tile')].map((t) => t.dataset.agent)`), ORDER);
  // role badges on the tiles; the Main session is the one with the crown
  const badges = await app.evaluate(`Object.fromEntries([...document.querySelectorAll('.tile')].map((t) => [t.dataset.agent, t.querySelector('.role-badge').textContent]))`);
  assert.equal(badges['agent-01'], '👑Main');
  assert.equal(Object.values(badges).filter((b) => b.includes('Main')).length, 1);
  assert.match(await app.evaluate(`document.querySelector('${tileSel('agent-03')}').textContent`), /Which option\?/);
});

test('exactly four tiles fill the visible area; scrolling reveals the rest', async () => {
  const geo = await app.evaluate(`(() => {
    const s = document.querySelector('.grid-scroll').getBoundingClientRect();
    const rects = [...document.querySelectorAll('.tile')].map((t) => { const r = t.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });
    return { s: { top: s.top, bottom: s.bottom, left: s.left, right: s.right }, rects };
  })()`);
  const inside = (/** @type {any} */ r) => r.top >= geo.s.top - 1 && r.bottom <= geo.s.bottom + 1 && r.left >= geo.s.left - 1 && r.right <= geo.s.right + 1;
  assert.deepEqual(geo.rects.map(inside), [true, true, true, true, false, false, false, false, false, false]);
  // two columns, two rows
  assert.ok(Math.abs(geo.rects[0].top - geo.rects[1].top) < 1 && geo.rects[1].left > geo.rects[0].right - 1);
  assert.ok(Math.abs(geo.rects[2].top - geo.rects[0].bottom) < 12);
  assert.ok(Math.abs(geo.rects[3].bottom - geo.s.bottom) < 2, 'four tiles fill the area exactly');
  assert.ok(geo.rects[4].top >= geo.s.bottom - 1);
  const top = await scrollTo(100000);
  assert.ok(top > 0);
  const last = await app.evaluate(`(() => { const t = document.querySelector('${tileSel('agent-10')}').getBoundingClientRect(); const s = document.querySelector('.grid-scroll').getBoundingClientRect(); return t.bottom <= s.bottom + 1 && t.top >= s.top - 1; })()`);
  assert.equal(last, true, 'the last tile can be scrolled fully into view');
  await scrollTo(0);
});

test('only tiles in or near the viewport hold a live terminal; the others show a snapshot', async () => {
  await scrollTo(0);
  await until(async () => (await live()).filter(Boolean).length === 6);
  assert.deepEqual(await live(), [true, true, true, true, true, true, false, false, false, false]);
  const terms = await app.evaluate('window.__cc.liveTerminals()');
  assert.deepEqual([...terms].sort(), ORDER.slice(0, 6).sort());
  assert.equal(await app.evaluate(`document.querySelectorAll('.term-slot').length`), 6);
  // let the first tiles' terminals fill up, then scroll them away
  await until(async () => /Task 1/.test(await termText('agent-01')));
  await scrollTo(100000);
  await until(async () => (await live()).join() === [false, false, false, false, true, true, true, true, true, true].join());
  const terms2 = await app.evaluate('window.__cc.liveTerminals()');
  assert.deepEqual([...terms2].sort(), ORDER.slice(4).sort());
  assert.ok(mock.calls.some((c) => c.method === 'agents.detach' && c.params.id === 'agent-01'), 'released terminals detach');
  // the released tile shows what the terminal showed, as plain text
  const snap = await app.evaluate(`(() => { const p = document.querySelector('${tileSel('agent-01')} .tile-snap'); return { text: p.textContent, hidden: p.hidden, tag: p.tagName, term: !!document.querySelector('${tileSel('agent-01')} .term-slot') }; })()`);
  assert.equal(snap.tag, 'PRE');
  assert.equal(snap.hidden, false);
  assert.equal(snap.term, false);
  assert.match(snap.text, /Task 1/);
  // scrolling back brings the live terminal (and its content) back
  await scrollTo(0);
  await until(async () => (await live())[0]);
  await until(async () => /Task 1/.test(await termText('agent-01')));
});

test('each live terminal is fitted to its tile and the PTY is resized to it', async () => {
  await until(() => mock.calls.some((c) => c.method === 'agents.resize' && c.params.id === 'agent-03'));
  const size = await app.evaluate(`window.__cc.termSize('agent-03')`);
  // Half the grid's width: well under a full-width terminal, but still a usable terminal at small window sizes.
  assert.ok(size.cols >= 25 && size.cols < 90 && size.rows >= 8 && size.rows < 40, JSON.stringify(size));
  const fits = await app.evaluate(`(() => { const t = document.querySelector('${tileSel('agent-03')} .tile-term').getBoundingClientRect(); const x = document.querySelector('${tileSel('agent-03')} .term-slot').getBoundingClientRect(); return x.bottom <= t.bottom + 1 && x.right <= t.right + 1; })()`);
  assert.equal(fits, true);
});

test('clicking a tile focuses it: typing reaches that agent', async () => {
  await scrollTo(0);
  await app.click(`${tileSel('agent-03')} .tile-term`);
  // a click on the tile body focuses the terminal
  await app.evaluate(`document.querySelector('${tileSel('agent-03')}').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await app.waitFor(`document.activeElement && document.activeElement.closest('.tile') && document.activeElement.closest('.tile').dataset.agent === 'agent-03'`);
  assert.equal(await app.evaluate(`document.querySelector('${tileSel('agent-03')}').classList.contains('focused')`), true);
  const before = mock.inputs.length;
  await app.insertText('hello grid');
  await app.press('Enter');
  await until(() => mock.inputs.slice(before).join('').includes('hello grid\r'));
  await until(async () => /GOT: hello grid/.test(await termText('agent-03')));
  assert.equal(/GOT: hello grid/.test(await termText('agent-01')), false, 'other agents do not get the keys');
});

test('double-click, Enter and the button expand a tile to the whole view; Esc and Back return', async () => {
  const dbl = (/** @type {string} */ id) => app.evaluate(`document.querySelector('${tileSel(id)} .tile-head').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  const tileCols = await app.evaluate(`(window.__cc.termSize('agent-06') || {}).cols || 0`);
  await dbl('agent-06');
  await app.waitFor(`document.querySelector('${tileSel('agent-06')}').classList.contains('expanded')`);
  const geo = await app.evaluate(`(() => {
    const s = document.querySelector('.grid-scroll').getBoundingClientRect(); const t = document.querySelector('${tileSel('agent-06')}').getBoundingClientRect();
    return { w: Math.abs(t.width - s.width), h: Math.abs(t.height - s.height), others: [...document.querySelectorAll('.tile')].filter((x) => x.dataset.agent !== 'agent-06' && x.offsetParent !== null).length };
  })()`);
  assert.ok(geo.w < 2 && geo.h < 2, JSON.stringify(geo));
  assert.equal(geo.others, 0);
  await app.waitFor(`document.querySelector('${tileSel('agent-06')}').dataset.live === 'true'`);
  // fitted to the whole view: much wider than the tile (absolute widths depend on the window and the font)
  await app.waitFor(`window.__cc.termSize('agent-06').cols >= ${Math.max(60, Math.floor(tileCols * 1.7))}`);
  await app.waitFor(`document.activeElement && document.activeElement.tagName === 'TEXTAREA'`); // expand gives the terminal the keyboard
  // Esc with the keyboard on the tile (not in the terminal, where Esc belongs to Claude Code)
  await app.evaluate(`document.querySelector('${tileSel('agent-06')}').focus()`);
  await app.press('Escape');
  await app.waitFor(`document.querySelectorAll('.tile.expanded').length === 0 && document.querySelector('${tileSel('agent-10')}').offsetParent !== null`);
  await app.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'); // collapse hands the keyboard back to the tile on the next frame
  assert.equal(await app.evaluate(`document.activeElement === document.querySelector('${tileSel('agent-06')}')`), true);
  // Enter on a focused tile expands it, the Back button collapses it
  await app.evaluate(`document.querySelector('${tileSel('agent-03')}').focus()`);
  await app.press('Enter');
  await app.waitFor(`document.querySelector('${tileSel('agent-03')}').classList.contains('expanded')`);
  await app.click('#grid-back');
  await app.waitFor(`document.querySelectorAll('.tile.expanded').length === 0`);
  // the terminal's Esc is not swallowed: it reaches the agent
  await app.click(`${tileSel('agent-03')} .tile-term`);
  await app.evaluate(`document.querySelector('${tileSel('agent-03')}').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await app.waitFor(`document.querySelector('${tileSel('agent-03')}').classList.contains('expanded') && document.activeElement && document.activeElement.tagName === 'TEXTAREA' && document.activeElement.closest('.tile')`);
  const before = mock.inputs.length;
  await app.press('Escape');
  await until(() => mock.inputs.slice(before).includes('\x1b'));
  assert.equal(await app.evaluate(`document.querySelector('${tileSel('agent-03')}').classList.contains('expanded')`), true);
  await app.click('#grid-back');
  await app.waitFor(`document.querySelectorAll('.tile.expanded').length === 0`);
});

test('right-click a tile: Make Main moves the crown', async () => {
  assert.equal(await contextMenu(tileSel('agent-05')), true);
  const items = await app.evaluate(`[...document.querySelectorAll('.ctx-item')].map((b) => b.dataset.action)`);
  assert.deepEqual(items, ['open', 'edit', 'make-main', 'resume', 'restart', 'remove']);
  await app.click('.ctx-item[data-action="make-main"]');
  await until(() => mock.calls.some((c) => c.method === 'agents.update' && c.params.id === 'agent-05' && c.params.role.id === 'main'));
  await app.waitFor(`document.querySelector('.tile').dataset.agent === 'agent-05'`);
  const badges = await app.evaluate(`Object.fromEntries([...document.querySelectorAll('.tile')].map((t) => [t.dataset.agent, t.querySelector('.role-badge').textContent]))`);
  assert.equal(badges['agent-05'], '👑Main');
  assert.equal(badges['agent-01'], '🔧Worker');
  assert.equal(await app.evaluate(`!document.querySelector('.ctx-menu')`), true);
  // Resume / Restart / Stop go to the core
  await contextMenu(tileSel('agent-05'));
  await app.click('.ctx-item[data-action="restart"]');
  await until(() => mock.calls.some((c) => c.method === 'agents.restart' && c.params.id === 'agent-05'));
  // Esc closes the menu
  await contextMenu(tileSel('agent-02'));
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('.ctx-menu')`);
  // Rename / change role opens the edit dialog of the Settings track (if it is wired) and closes the menu
  await contextMenu(tileSel('agent-02'));
  await app.click('.ctx-item[data-action="open"]');
  await app.waitFor(`window.__cc.snapshot().view === 'terminals' && window.__cc.snapshot().tabs.includes('agent-02')`);
});

test('a terminal open in a tab moves into its tile while the Grid is shown, and back to its pane', async () => {
  // agent-02 is open in a tab and shown in the pane now
  const where = (/** @type {string} */ id) => app.evaluate(`[...document.querySelectorAll('.term-slot[data-agent="${id}"]')].map((el) => el.parentElement.className)`);
  assert.deepEqual(await where('agent-02'), ['term-host']);
  await app.press('G', { ctrl: true, shift: true, code: 'KeyG' });
  await app.waitFor(`window.__cc.snapshot().view === 'grid'`);
  // Only tiles near the screen are live: bring agent-02's tile into view, as a person would by scrolling.
  await app.evaluate(`document.querySelector('${tileSel('agent-02')}').scrollIntoView({ block: 'center' })`);
  await app.waitFor(`document.querySelector('${tileSel('agent-02')}').dataset.live === 'true'`);
  assert.deepEqual(await where('agent-02'), ['tile-term'], 'one element, in the tile');
  assert.equal(await app.evaluate(`document.querySelectorAll('.term-slot').length`), await app.evaluate(`window.__cc.liveTerminals().length`));
  await app.press('T', { ctrl: true, shift: true, code: 'KeyT' });
  await app.waitFor(`window.__cc.snapshot().view === 'terminals' && document.querySelector('.term-slot[data-agent="agent-02"]')`);
  assert.deepEqual(await where('agent-02'), ['term-host'], 'one element, back in the pane');
  // leaving the grid let go of every terminal that no tab shows
  assert.deepEqual(await app.evaluate('window.__cc.liveTerminals()'), ['agent-02']);
  // typing in the pane still works after the round trip
  const before = mock.inputs.length;
  await app.evaluate(`document.querySelector('.term-slot[data-agent="agent-02"] textarea').focus()`);
  await app.insertText('x');
  await until(() => mock.inputs.slice(before).includes('x'));
  await app.press('G', { ctrl: true, shift: true, code: 'KeyG' });
  await app.waitFor(`window.__cc.snapshot().view === 'grid'`);
});

test('sidebar: All spaces groups every agent by space, needs-you first, and names are not truncated', async () => {
  await app.click('#agents-all-spaces');
  await app.waitFor(`document.querySelectorAll('.agent-group').length === 4`);
  const groups = await app.evaluate(`[...document.querySelectorAll('.agent-group')].map((g) => g.dataset.space)`);
  // agent-03 was answered earlier in this file: three spaces wait for you with one agent each (space order), storefront has none
  assert.deepEqual(groups, ['cc-dashboard', 'data-pipeline', 'big-project', 'storefront']);
  const trunc = await app.evaluate(`(() => { const n = document.querySelector('.agent-card[data-agent="refactor-auth"] .agent-name'); return { full: n.scrollWidth <= n.clientWidth, text: n.textContent }; })()`);
  assert.deepEqual(trunc, { full: true, text: 'refactor-auth' });
  const roleLine = await app.evaluate(`(() => { const c = document.querySelector('.agent-card[data-agent="refactor-auth"]'); return !!c.querySelector('.card-meta .role-badge') && !!c.querySelector('.card-meta .needs-badge') && c.getAttribute('role') === 'button' && c.tagName === 'DIV'; })()`);
  assert.equal(roleLine, true);
  // clicking an agent card still opens it in Terminals
  await app.click('.agent-card[data-agent="landing-copy"]');
  await app.waitFor(`window.__cc.snapshot().view === 'terminals' && document.querySelector('.tab[data-agent="landing-copy"].active')`);
  // right-click on a sidebar card gives the same menu
  assert.equal(await contextMenu('.agent-card[data-agent="perf-audit"]'), true);
  assert.equal(await app.evaluate(`document.querySelector('.ctx-menu').dataset.agent`), 'perf-audit');
  await app.press('Escape');
  await app.click('#agents-this-space');
  await app.waitFor(`document.querySelectorAll('.agent-group').length === 0`);
});

test('an empty space shows "No agents in this space" with a New agent button (Remove asks first)', async () => {
  await app.click('.space[data-space="storefront"]');
  await app.waitFor(`window.__cc.snapshot().view === 'grid' && document.querySelectorAll('.tile').length === 2`);
  for (const id of ['landing-copy', 'perf-audit']) {
    await contextMenu(tileSel(id));
    await app.click('.ctx-item[data-action="remove"]');
    await app.waitFor(`document.querySelector('.ctx-menu [data-action="confirm-remove"]')`);
    if (id === 'landing-copy') {
      // Cancel keeps the agent
      await app.click('.ctx-menu [data-action="cancel"]');
      await app.waitFor(`document.querySelector('.ctx-menu [data-action="remove"]')`);
      assert.ok(!mock.calls.some((c) => c.method === 'agents.remove'));
      await app.click('.ctx-item[data-action="remove"]');
    }
    await app.click('.ctx-menu [data-action="confirm-remove"]');
    await until(() => mock.calls.some((c) => c.method === 'agents.remove' && c.params.id === id));
  }
  await app.waitFor(`document.querySelectorAll('.tile').length === 0 && !document.querySelector('.grid-empty').hidden`);
  assert.match(await app.evaluate(`document.querySelector('.grid-empty').textContent`), /No agents in this space/);
  await app.click('#grid-empty-new');
  await app.waitFor(`document.querySelector('[data-modal="new-agent"]')`);
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
});
