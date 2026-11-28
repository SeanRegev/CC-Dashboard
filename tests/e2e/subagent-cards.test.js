// @ts-check
'use strict';
/**
 * End-to-end: subagent cards (M4 track C) in the real Electron app against the dev mock core
 * (static data: refactor-auth has 2 subagents, fix-flaky-tests 3 (running, done, failed), landing-copy 1; the
 * mock's models: Explore -> Haiku 4.5, Plan -> Opus 4.1, general -> its session's model).
 * Sidebar child cards, grid row, Terminals pane bar, click -> drawer on that subagent, keyboard, both themes.
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
const RA_SUB2 = 'a1f0c2e9d1b7a0002'; // refactor-auth: "Update middleware tests" (general-purpose, running, needs you)
const FF = 'fix-flaky-tests'; // "Map checkout fixtures" (Explore, running), "Plan the retry fix" (Plan, done), one failed
const FF_SUB1 = 'b2e1d3f0c2a8b0001';

/** Runs in the page: contrast of every text node inside the subagent cards against the background behind it. */
const AUDIT = `(() => {
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
  const bgOf = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base); return base; };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent.trim() || !el.closest('.sub-card, .sub-group, .sub-pill, .sub-done-toggle')) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    const a = lum(over(fg, bg)), b = lum(bg);
    out.push({ text: n.textContent.trim().slice(0, 40), cls: String(el.className).slice(0, 40), ratio: Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100 });
  }
  return out;
})()`;

test.before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-subcards-'));
  mock = await startMockCore({ home, static: true });
  app = await launchApp({ env: { CC_HOME: home }, size: '1024x768' });
  await app.waitFor(`document.querySelectorAll('.agent-card').length === 5`, 20000);
  await app.waitFor(`document.querySelector('.agent-card[data-agent="refactor-auth"]')`, 10000);
  await app.waitFor(`document.querySelector('.sub-group[data-agent="refactor-auth"] .sub-card')`, 10000);
});

test.after(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
});

test('sidebar: child cards under the session with emoji, title, model, tool, time and state', async () => {
  const group = '.sub-group[data-agent="refactor-auth"]';
  assert.equal(await count(`${group} .sub-card`), 1, 'the running one; the done one is folded');
  assert.match(await text(`${group} .sub-card`), /🔧/);
  assert.match(await text(`${group} .sub-card .sub-card-title`), /Update middleware tests/);
  assert.match(await text(`${group} .sub-card .sub-card-tool`), /needs you/);
  assert.match(await text(`${group} .sub-card .sub-card-time`), /\d/);
  assert.equal(await count(`${group} .sub-card.needs`), 1, 'needs-you stands out');
  assert.equal(await text(`${group} .sub-done-toggle`), '▸ ✓ 1 done');
  assert.equal(await count('.sub-group[data-agent="docs-pass"]'), 0, 'no subagents, no group');
  // it sits under its own agent card
  assert.equal(await app.evaluate(`document.querySelector(${q(group)}).previousElementSibling.dataset.agent`), 'refactor-auth');
  // models: Explore -> Haiku 4.5 (running one of fix-flaky-tests), general -> the session's model
  const ff = `.sub-group[data-agent="${FF}"]`;
  assert.equal(await text(`${ff} .sub-card.st-running .sub-card-model`), 'Haiku 4.5');
  assert.equal(await count(`${ff} .sub-card.st-failed`), 1, 'a failed subagent keeps its card');
});

test('sidebar: "✓ N done" expands and folds; the group collapses; both are remembered after a re-render', async () => {
  const group = '.sub-group[data-agent="refactor-auth"]';
  await app.click(`${group} .sub-done-toggle`);
  await app.waitFor(`document.querySelectorAll(${q(`${group} .sub-card`)}).length === 2`);
  assert.equal(await text(`${group} .sub-done-toggle`), '▾ ✓ 1 done');
  assert.match(await text(`${group} .sub-card.st-done .sub-card-title`), /Find token call sites/);
  assert.equal(await app.evaluate(`document.querySelector(${q(`${group} .sub-card.st-done .sub-card-state`)}).textContent`), '✓');
  await app.click(`${group} .sub-done-toggle`);
  await app.waitFor(`document.querySelectorAll(${q(`${group} .sub-card`)}).length === 1`);

  assert.equal(await app.evaluate(`document.querySelector(${q(`${group} .sub-group-head`)}).getAttribute('aria-expanded')`), 'true');
  await app.click(`${group} .sub-group-head`);
  await app.waitFor(`document.querySelector(${q(group)}).classList.contains('collapsed')`);
  assert.equal(await count(`${group} .sub-card`), 0);
  assert.match(await text(`${group} .sub-group-sum`), /1 running · 1 needs you · ✓ 1 done/, 'the summary stays on the head, with the needs-you count');
  // a re-render (switch spaces and back) keeps it collapsed; the choice lives in this window's storage
  assert.match(await app.evaluate(`localStorage.getItem('cc.sidebar.subagentsCollapsed')`), /refactor-auth/);
  await app.evaluate(`document.querySelector('#agents-all-spaces').click()`);
  await app.waitFor(`document.querySelector(${q(group)})`);
  assert.equal(await app.evaluate(`document.querySelector(${q(group)}).classList.contains('collapsed')`), true);
  await app.evaluate(`document.querySelector('#agents-this-space').click()`);
  await app.waitFor(`document.querySelector(${q(group)})`);
  await app.click(`${group} .sub-group-head`);
  await app.waitFor(`!document.querySelector(${q(group)}).classList.contains('collapsed')`);
  assert.equal(await count(`${group} .sub-card`), 1);
});

test('clicking a sidebar card opens the drawer on that subagent, not the agent', async () => {
  await app.click(`.sub-group[data-agent="refactor-auth"] .sub-card`);
  await app.waitFor(`!document.getElementById('activity-drawer').hidden`);
  assert.deepEqual(await drawerFor(), { agentId: 'refactor-auth', subagentId: RA_SUB2 });
  await app.waitFor(`document.querySelector('#activity-drawer .act-item.on[data-filter="${RA_SUB2}"]')`);
  await app.evaluate(`document.querySelector('.act-close').click()`);
  await app.waitFor(`document.getElementById('activity-drawer').hidden`);
});

test('cards are real buttons with a readable label, reachable by keyboard', async () => {
  const sel = '.sub-group[data-agent="refactor-auth"] .sub-card';
  assert.equal(await app.evaluate(`document.querySelector(${q(sel)}).tagName`), 'BUTTON');
  const label = await app.evaluate(`document.querySelector(${q(sel)}).getAttribute('aria-label')`);
  assert.match(label, /^General subagent: Update middleware tests, running, model Opus 4.1, needs you, /);
  await app.evaluate(`document.querySelector(${q(sel)}).focus()`);
  assert.equal(await app.evaluate(`document.activeElement.className.includes('sub-card')`), true);
  await app.press('Enter');
  await app.waitFor(`!document.getElementById('activity-drawer').hidden`);
  assert.deepEqual(await drawerFor(), { agentId: 'refactor-auth', subagentId: RA_SUB2 });
  await app.evaluate(`document.querySelector('.act-close').click()`);
  await app.waitFor(`document.getElementById('activity-drawer').hidden`);
});

test('grid: a row of cards under the tile header; fits 1024x768; done folded; click opens the drawer', async () => {
  await app.press('G', { ctrl: true, shift: true, code: 'KeyG' });
  const tile = `.tile[data-agent="${FF}"]`;
  await app.waitFor(`document.querySelector(${q(`${tile} .tile-subs .sub-card`)})`);
  assert.equal(await app.evaluate(`document.querySelector(${q(`${tile} .tile-subs`)}).previousElementSibling.className`), 'tile-head', 'right under the header');
  assert.equal(await count(`${tile} .sub-card.st-running`), 1);
  assert.equal(await count(`${tile} .sub-card.st-failed`), 1);
  assert.equal(await text(`${tile} .sub-pill.done`), '✓ 1 done');
  assert.equal(await text(`${tile} .sub-card.st-running .sub-card-model`), 'Haiku 4.5');
  assert.equal(await count(`${tile} .sub-chip`), 0, 'the M3 chips are gone');
  assert.equal(await app.evaluate(`document.querySelector('.tile[data-agent="docs-pass"] .tile-subs').hidden`), true, 'no subagents, no row');
  // 1024x768: no horizontal page overflow, the row stays inside its tile and the tiles keep a usable terminal height
  const fit = await app.evaluate(`(() => {
    const t = document.querySelector(${q(tile)}); const r = document.querySelector(${q(`${tile} .tile-subs`)}); const tr = t.getBoundingClientRect(); const rr = r.getBoundingClientRect();
    const tiles = [...document.querySelectorAll('.tile')].filter((x) => x.offsetParent);
    return { pageOverflow: document.documentElement.scrollWidth > innerWidth, rowInside: rr.left >= tr.left - 1 && rr.right <= tr.right + 1, rowH: Math.round(rr.height), termH: Math.round(t.querySelector('.tile-term').getBoundingClientRect().height), tiles: tiles.length, w: innerWidth, h: innerHeight };
  })()`);
  assert.equal(fit.pageOverflow, false);
  assert.equal(fit.rowInside, true);
  assert.ok(fit.rowH <= 56, `the row is compact (${fit.rowH}px)`);
  assert.ok(fit.termH >= 60, `the terminal keeps room (${fit.termH}px)`);
  await app.click(`${tile} .sub-card.st-running`);
  await app.waitFor(`!document.getElementById('activity-drawer').hidden`);
  assert.deepEqual(await drawerFor(), { agentId: FF, subagentId: FF_SUB1 });
  assert.equal((await app.evaluate('window.__cc.snapshot()')).view, 'grid');
  await app.evaluate(`document.querySelector('.act-close').click()`);
  await app.waitFor(`document.getElementById('activity-drawer').hidden`);
  await app.click(`${tile} .sub-pill.done`);
  await app.waitFor(`!document.getElementById('activity-drawer').hidden`);
  assert.deepEqual(await drawerFor(), { agentId: FF }, 'the done pill opens the whole log');
  await app.evaluate(`document.querySelector('.act-close').click()`);
  await app.waitFor(`document.getElementById('activity-drawer').hidden`);
});

test('grid: a new subagent shows at once, and its elapsed time ticks', async () => {
  const tile = `.tile[data-agent="${FF}"]`;
  const subs = mock.activity.subagents.get(FF);
  const startedAt = Date.now() - 5000;
  subs.push({ id: 'b2e1d3f0c2a8b0009', agentId: FF, title: 'Scan the pricing page', type: 'Plan', model: 'opus', state: 'running', background: false, counts: { tools: 0, errors: 0 }, startedAt, updatedAt: startedAt });
  mock.broadcast('subagent.updated', { agentId: FF, subagent: { ...subs[subs.length - 1] } });
  await app.waitFor(`document.querySelectorAll(${q(`${tile} .sub-card.st-running`)}).length === 2`);
  const card = `${tile} .sub-card[data-sub="b2e1d3f0c2a8b0009"]`;
  assert.match(await text(`${card} .sub-card-title`), /Scan the pricing page/);
  assert.equal(await text(`${card} .sub-card-model`), 'Opus');
  const t1 = await text(`${card} .sub-card-time`);
  await app.waitFor(`document.querySelector(${q(`${card} .sub-card-time`)}).textContent !== ${q(t1)}`, 4000);
  subs.pop(); // leave the seed as it was
  mock.broadcast('subagent.updated', { agentId: FF, subagent: { ...subs[0] } });
});

test('Terminals pane: a bar under the pane header with the same cards; hidden for a session without subagents', async () => {
  await app.press('T', { ctrl: true, shift: true, code: 'KeyT' });
  await app.evaluate(`document.querySelector('.agent-card[data-agent="refactor-auth"]').click()`);
  await app.waitFor(`document.querySelector('.pane-sub .sub-card')`, 10000);
  assert.equal(await app.evaluate(`document.querySelector('.pane-sub').previousElementSibling.className`), 'pane-head');
  assert.match(await text('.pane-sub .sub-card .sub-card-title'), /Update middleware tests/);
  assert.equal(await text('.pane-sub .sub-pill.done'), '✓ 1 done');
  await app.click('.pane-sub .sub-card');
  await app.waitFor(`!document.getElementById('activity-drawer').hidden`);
  assert.deepEqual(await drawerFor(), { agentId: 'refactor-auth', subagentId: RA_SUB2 });
  await app.evaluate(`document.querySelector('.act-close').click()`);
  await app.waitFor(`document.getElementById('activity-drawer').hidden`);
  await app.evaluate(`document.querySelector('.agent-card[data-agent="docs-pass"]').click()`);
  await app.waitFor(`!document.querySelector('.pane-sub .sub-card')`, 10000);
  assert.equal(await app.evaluate(`getComputedStyle(document.querySelector('.pane-sub')).display`), 'none');
});

test('outside sessions show their subagents in the sidebar too', async () => {
  await app.evaluate(`document.querySelector('.space[data-space="cc-dashboard"]').click()`);
  await app.waitFor(`document.querySelector('.ext-block .sub-group .sub-card')`, 10000);
  assert.match(await text('.ext-block .sub-group .sub-card .sub-card-title'), /Collect review threads/);
  assert.equal(await text('.ext-block .sub-group .sub-card .sub-card-model'), 'Haiku 4.5');
  await app.click('.ext-block .sub-group .sub-card');
  await app.waitFor(`!document.getElementById('activity-drawer').hidden`);
  const f = await drawerFor();
  assert.match(f.agentId, /^ext:/);
  assert.ok(f.subagentId);
  await app.evaluate(`document.querySelector('.act-close').click()`);
  await app.waitFor(`document.getElementById('activity-drawer').hidden`);
});

for (const theme of ['dark', 'light']) {
  test(`cards are readable in the ${theme} theme (sidebar, grid, pane bar)`, async () => {
    await app.press(',', { ctrl: true, code: 'Comma', keyCode: 188 });
    await app.waitFor(`document.querySelector('[data-modal="settings"]')`);
    await app.click(`[data-name="theme"] [data-value="${theme}"]`);
    await app.waitFor(`document.documentElement.dataset.theme === ${q(theme)}`);
    await app.press('Escape');
    await app.waitFor(`!document.querySelector('[data-modal]')`);
    for (const view of ['terminals', 'grid']) {
      await app.press(view === 'grid' ? 'G' : 'T', { ctrl: true, shift: true, code: view === 'grid' ? 'KeyG' : 'KeyT' });
      await app.waitFor(`window.__cc.snapshot().view === ${q(view)}`);
      await app.waitFor(`document.querySelector('.sub-group .sub-card')`);
      await app.evaluate(`document.querySelector('.sub-done-toggle') && document.querySelector('.sub-done-toggle').getAttribute('aria-expanded') === 'false' && document.querySelector('.sub-done-toggle').click()`);
      await sleep(300);
      /** @type {Array<{text:string, cls:string, ratio:number}>} */
      const rows = await app.evaluate(AUDIT);
      assert.ok(rows.length > 10, 'the audit saw the cards');
      const bad = rows.filter((r) => r.ratio < 4.5);
      assert.deepEqual(bad.map((r) => `${r.text} (${r.cls}) ${r.ratio}`), [], `${theme} ${view}: unreadable text`);
    }
  });
}
