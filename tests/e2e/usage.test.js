// @ts-check
'use strict';
/**
 * End-to-end: the usage UI (top-bar meter, Usage view, context gauges, New agent warning) against the dev mock
 * core, in both themes at 1024x768 (the clamped CI window) and 1440x900. Text in these pieces must have a contrast
 * of at least 4.5:1. Screenshots go to $CC_SHOT_DIR (default test-results/).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMockCore } = require('../../packages/app/src/renderer/dev/mock-core.js');
const { launchApp, sleep } = require('../../packages/app/src/renderer/dev/cdp.js');

const OUT = process.env.CC_SHOT_DIR || path.join(__dirname, '..', '..', 'test-results');
const q = (/** @type {string} */ s) => JSON.stringify(s);

/** Runs in the page: contrast of every visible text node inside the usage pieces. */
const AUDIT = `(() => {
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const bgOf = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base); return base; };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !n.textContent.trim() || !el.closest('.usage-view, .usage-meter, .limit-warning, .gauge, .tile-ctx, .bc-ctx, .foot-total')) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width < 2 || r.height < 2) continue;
    let hidden = false; for (let e = el; e; e = e.parentElement) { if (getComputedStyle(e).display === 'none') { hidden = true; break; } }
    if (hidden) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    const a = lum(over(fg, bg)), b = lum(bg);
    out.push({ text: n.textContent.trim().slice(0, 40), cls: String(el.className).slice(0, 40), ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100 });
  }
  return out;
})()`;

/** Visible text of the meter ('' when absent). */
const METER = `(() => { const m = document.getElementById('usage-meter'); return m ? m.innerText : null; })()`;

/** @param {{usage?:'normal'|'high'|'none', size:string}} o */
async function boot(o, t) {
  fs.mkdirSync(OUT, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-usage-'));
  const mock = await startMockCore({ home, static: true, usage: o.usage });
  const app = await launchApp({ env: { CC_HOME: home }, size: o.size });
  t.after(async () => { await app.close(); await mock.close(); });
  await app.waitFor(`document.querySelectorAll('.agent-card').length === 5`, 20000);
  if (o.usage !== 'none') await app.waitFor(`document.getElementById('usage-meter')`, 10000);
  return { app, mock };
}

/** @param {any} app @param {string} theme */
async function setTheme(app, theme) {
  await app.press(',', { ctrl: true, code: 'Comma', keyCode: 188 });
  await app.waitFor(`document.querySelector('[data-modal="settings"]')`);
  await app.click(`[data-name="theme"] [data-value="${theme}"]`);
  await app.waitFor(`document.documentElement.dataset.theme === ${q(theme)}`);
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
}

/** @param {any} app @param {string} name */
async function audit(app, name, size) {
  await app.screenshot(path.join(OUT, `usage-${name}-${size}.png`));
  const rows = await app.evaluate(AUDIT);
  assert.ok(rows.length > 0, `${name}: nothing to audit`);
  const bad = rows.filter((/** @type {any} */ r) => r.ratio < 4.5);
  assert.deepEqual(bad.map((/** @type {any} */ r) => `${r.text} (${r.cls}) ${r.ratio}`), [], `${name} ${size}: text under 4.5:1`);
}

for (const size of ['1024x768', '1440x900']) {

  test(`usage: meter, gauges, Usage view and New agent warning, both themes, ${size}`, { timeout: 150000 }, async (t) => {
    const { app, mock } = await boot({ size }, t);

    // meter: normal limits; fits beside the view buttons
    const text = await app.evaluate(METER);
    const iw = await app.evaluate('innerWidth');
    if (iw > 1400) assert.match(text, /^5h 62% · resets \d\d:\d\d \/ week 31%$/);
    else assert.equal(text, iw <= 1100 ? '5h 62%' : '5h 62% / wk 31%');
    const tip = await app.evaluate(`document.getElementById('usage-meter').title`);
    assert.match(tip, /as of \d\d:\d\d \(reported by fix-flaky-tests\)/);
    const fit = await app.evaluate(`(() => {
      const m = document.getElementById('usage-meter').getBoundingClientRect(), v = document.querySelector('.view-switch').getBoundingClientRect(), a = document.querySelector('.top-actions').getBoundingClientRect();
      const btns = [...document.querySelectorAll('.view-switch button')].map((b) => b.getBoundingClientRect());
      return { overlap: m.right > v.left + 0.5, inside: m.left >= a.left - 0.5 && Math.max(...btns.map((b) => b.right)) <= a.right + 0.5, right: a.right, width: innerWidth, nBtns: btns.length, pr: parseFloat(getComputedStyle(document.querySelector('.topbar')).paddingRight) || 0, clipped: document.getElementById('usage-meter').scrollWidth > document.getElementById('usage-meter').clientWidth };
    })()`);
    assert.equal(fit.nBtns, 7);
    assert.equal(fit.overlap, false, 'meter overlaps the view buttons');
    assert.equal(fit.inside, true);
    assert.ok(fit.right <= fit.width - fit.pr + 0.5, 'top bar overflows into the window controls ' + JSON.stringify(fit));
    assert.equal(fit.clipped, false, 'meter text is clipped');

    // the context gauge in the grid: text and bar agree
    await app.click('.space[data-space="cc-dashboard"]');
    await app.waitFor(`window.__cc.snapshot().view === 'grid' && document.querySelector('.tile-ctx .gauge-pct')`, 15000);
    const gauges = await app.evaluate(`[...document.querySelectorAll('.tile-ctx')].map((c) => ({ text: c.querySelector('.gauge-pct').textContent, width: c.querySelector('.gauge-fill').style.width }))`);
    assert.ok(gauges.length > 0);
    for (const g of gauges) {
      const m = /^(~?)(\d+(?:\.\d)?[kM]?) \/ (\d+(?:\.\d)?[kM]) \((~?)(\d+)%\)$/.exec(g.text);
      assert.ok(m, `gauge text ${g.text}`);
      assert.equal(m[1], m[4]);
      assert.equal(g.width, `${m[5]}%`, `bar and text agree for ${g.text}`);
    }
    assert.ok(gauges.some((g) => g.text.startsWith('~')), 'a stopped agent shows an estimate');
    assert.ok(gauges.some((g) => !g.text.startsWith('~')), 'a live agent shows the exact value');

    // board cards use the same text
    await app.click('.view-switch button[data-view="board"]');
    await app.waitFor(`document.querySelector('.bc-ctx .gauge-pct')`);
    const board = await app.evaluate(`[...document.querySelectorAll('.bc-ctx .gauge-pct')].map((e) => e.textContent)`);
    assert.ok(board.length > 0 && board.every((/** @type {string} */ s) => /\/ .*\(~?\d+%\)$/.test(s)), `board gauges ${board}`);

    for (const theme of ['dark', 'light']) {
      await setTheme(app, theme);
      await app.click('.view-switch button[data-view="grid"]');
      await app.waitFor(`document.querySelector('.tile-ctx')`);
      await audit(app, `${theme}-grid`, size);

      // Usage view, by shortcut
      await app.press('u', { ctrl: true, shift: true });
      await app.waitFor(`window.__cc.snapshot().view === 'usage' && document.querySelector('.usage-table')`, 10000);
      const view = await app.evaluate(`document.querySelector('.usage-view').innerText`);
      assert.match(view, /API-equivalent estimate/);
      assert.match(view, /old-migration/, 'a removed agent shows under its saved name');
      assert.match(view, /removed/);
      const blocks = await app.evaluate(`[...document.querySelectorAll('.usage-block')].map((b) => b.dataset.block + ':' + b.querySelectorAll('tbody tr').length)`);
      assert.equal(blocks.length, 3);
      assert.ok(blocks.every((/** @type {string} */ b) => Number(b.split(':')[1]) > 0), `blocks ${blocks}`);
      await audit(app, `${theme}-view`, size);

      // amber and red meter, New agent warning
      mock.usage.setLimits({ fiveHour: { usedPct: 80, resetsAt: Date.now() + 3600e3 }, sevenDay: { usedPct: 10, resetsAt: Date.now() + 86400e3 }, updatedAt: Date.now(), fromAgentId: 'refactor-auth' });
      await app.waitFor(`document.querySelector('#usage-meter.lvl-mid')`);
      await audit(app, `${theme}-amber`, size);
      mock.usage.setLimits({ fiveHour: { usedPct: 93, resetsAt: Date.now() + 3600e3 }, sevenDay: { usedPct: 78, resetsAt: Date.now() + 86400e3 }, updatedAt: Date.now() });
      await app.waitFor(`document.querySelector('#usage-meter.lvl-high')`);
      assert.doesNotMatch(await app.evaluate(`document.getElementById('usage-meter').title`), /reported by/, 'no agent: omitted');
      await audit(app, `${theme}-red`, size);
      await app.press('t', { ctrl: true });
      await app.waitFor(`document.querySelector('[data-modal] .limit-warning')`);
      assert.match(await app.evaluate(`document.querySelector('.limit-warning').innerText`), /5-hour limit is 93% used/);
      await sleep(400);
      await audit(app, `${theme}-warning`, size);
      await app.press('Escape');
      await app.waitFor(`!document.querySelector('[data-modal]')`);
      mock.usage.setLimits({ fiveHour: { usedPct: 62, resetsAt: Date.now() + 3600e3 }, sevenDay: { usedPct: 31, resetsAt: Date.now() + 86400e3 }, updatedAt: Date.now() - 40e3, fromAgentId: 'fix-flaky-tests' });
      await app.waitFor(`document.querySelector('#usage-meter.lvl-low')`);
    }
  });
}

test('usage: no warning below 90%, a passed reset time shows "reset", the meter is hidden without limits', { timeout: 90000 }, async (t) => {
  const { app, mock } = await boot({ size: '1440x900' }, t);
  await app.press('t', { ctrl: true });
  await app.waitFor(`document.querySelector('[data-modal]')`);
  assert.equal(await app.evaluate(`!!document.querySelector('.limit-warning')`), false);
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal]')`);

  mock.usage.setLimits({ fiveHour: { usedPct: 97, resetsAt: Date.now() - 1000 }, sevenDay: { usedPct: 31, resetsAt: Date.now() + 86400e3 }, updatedAt: Date.now() - 3600e3 });
  await app.waitFor(`(${METER}) && (${METER}).startsWith('5h reset')`);
  assert.doesNotMatch(await app.evaluate(METER), /97/);
  await app.press('t', { ctrl: true });
  await app.waitFor(`document.querySelector('[data-modal]')`);
  assert.equal(await app.evaluate(`!!document.querySelector('.limit-warning')`), false, 'a stale 97% does not warn');
  await app.press('Escape');

  mock.usage.setLimits({ updatedAt: 0 });
  await app.waitFor(`!document.getElementById('usage-meter')`);
});

test('usage: the pane footer labels the session total and the gauge shows context / window', { timeout: 60000 }, async (t) => {
  const { app } = await boot({ size: '1440x900' }, t);
  await app.click('.agent-card');
  await app.waitFor(`document.querySelector('.pane-foot .gauge-text')`, 15000);
  const foot = await app.evaluate(`({ gauge: document.querySelector('.pane-foot .gauge-text').textContent, total: document.querySelector('.pane-foot .foot-total').innerText, tip: document.querySelector('.pane-foot .foot-total').title })`);
  assert.match(foot.gauge, /^~?\d+(?:\.\d)?[kM]? \/ \d+(?:\.\d)?[kM] \(~?\d+%\)$/);
  assert.match(foot.total, /session total$/);
  assert.match(foot.tip, /whole session.*not the context size/);
});

test('usage: the Usage view with no totals shows an empty state', { timeout: 60000 }, async (t) => {
  fs.mkdirSync(OUT, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-usage-empty-'));
  const mock = await startMockCore({ home, static: true, empty: true, usage: 'none' });
  const app = await launchApp({ env: { CC_HOME: home }, size: '1440x900' });
  t.after(async () => { await app.close(); await mock.close(); });
  await app.waitFor(`document.querySelector('.view-switch')`, 20000);
  assert.equal(await app.evaluate(`!!document.getElementById('usage-meter')`), false);
  mock.usage.usage.byAgent = {}; mock.usage.usage.bySpace = {}; mock.usage.usage.byDay = {};
  mock.usage.setLimits({ updatedAt: 0 });
  await app.click('.view-switch button[data-view="usage"]');
  await app.waitFor(`document.querySelector('.usage-empty')`);
  const t0 = await app.evaluate(`document.querySelector('.usage-view').innerText`);
  assert.match(t0, /API-equivalent estimate/);
  assert.match(t0, /No usage recorded yet/);
  assert.equal(await app.evaluate(`!!document.querySelector('.usage-table')`), false);
});
