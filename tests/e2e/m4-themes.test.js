// @ts-check
'use strict';
/**
 * M4 contrast, both themes, at 1024x768 (the clamped CI window): every visible text in the usage meter (low, amber
 * and red), the Usage view, the context gauges (pane footer and grid tiles), the New agent limit warning and the
 * subagent cards (sidebar, grid row, pane bar) must reach 4.5:1 against what is behind it. Mock core (static data).
 * Screenshots go to $CC_SHOT_DIR (default test-results/).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMockCore } = require('../../packages/app/src/renderer/dev/mock-core.js');
const { launchApp, sleep } = require('../../packages/app/src/renderer/dev/cdp.js');

const OUT = process.env.CC_SHOT_DIR || path.join(__dirname, '..', '..', 'test-results');
const SIZE = '1024x768';
const SCOPE = '.usage-view, .usage-meter, .limit-warning, .gauge, .tile-ctx, .bc-ctx, .foot-total, .sub-card, .sub-group, .sub-pill, .sub-done-toggle, .pane-sub';

/** Runs in the page: contrast of every visible text node in the M4 pieces. */
const AUDIT = `(() => {
  const SCOPE = ${JSON.stringify(SCOPE)};
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const bgOf = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base); return base; };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !n.textContent.trim() || !el.closest(SCOPE)) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.visibility === 'hidden' || r.width < 2 || r.height < 2) continue;
    let hidden = false; for (let e = el; e; e = e.parentElement) { if (getComputedStyle(e).display === 'none') { hidden = true; break; } }
    if (hidden) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    const a = lum(over(fg, bg)), b = lum(bg);
    out.push({ text: n.textContent.trim().slice(0, 40), cls: String(el.className).slice(0, 40), ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100 });
  }
  return out;
})()`;

/** @param {any} app @param {string} name @param {string} expect a selector that must be among the audited texts */
async function audit(app, name, expect) {
  fs.mkdirSync(OUT, { recursive: true });
  await app.screenshot(path.join(OUT, `m4-${name}-${SIZE}.png`));
  /** @type {{text:string, cls:string, ratio:number}[]} */
  const rows = await app.evaluate(AUDIT);
  assert.ok(rows.length > 0, `${name}: nothing to audit`);
  assert.ok(await app.evaluate(`!!document.querySelector(${JSON.stringify(expect)})`), `${name}: ${expect} is not on screen`);
  const bad = rows.filter((r) => r.ratio < 4.5);
  assert.deepEqual(bad.map((r) => `${r.text} (${r.cls}) ${r.ratio}`), [], `${name}: text under 4.5:1`);
}

/** @param {any} app @param {string} theme */
async function setTheme(app, theme) {
  await app.press(',', { ctrl: true, code: 'Comma', keyCode: 188 });
  await app.waitFor(`document.querySelector('[data-modal="settings"]')`);
  await app.click(`[data-name="theme"] [data-value="${theme}"]`);
  await app.waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`);
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
}

test(`M4 contrast: meter, Usage view, gauges, limit warning and subagent cards, both themes, ${SIZE}`, { timeout: 180000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-m4-themes-'));
  const mock = await startMockCore({ home, static: true });
  const app = await launchApp({ env: { CC_HOME: home }, size: SIZE });
  t.after(async () => { await app.close(); await mock.close(); try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* locks */ } });
  await app.waitFor(`document.querySelectorAll('.agent-card').length === 5`, 20000);
  await app.waitFor(`document.getElementById('usage-meter')`, 10000);
  const limits = (/** @type {number} */ five, /** @type {number} */ week) => ({
    fiveHour: { usedPct: five, resetsAt: Date.now() + 3600e3 }, sevenDay: { usedPct: week, resetsAt: Date.now() + 86400e3 }, updatedAt: Date.now(), fromAgentId: 'refactor-auth',
  });

  for (const theme of ['dark', 'light']) {
    await setTheme(app, theme);

    // grid: tile gauges and the subagent row, plus the sidebar cards and the (low) meter
    await app.click('.space[data-space="cc-dashboard"]');
    await app.waitFor(`window.__cc.snapshot().view === 'grid' && document.querySelector('.tile-ctx .gauge-pct') && document.querySelector('.tile-subs .sub-card')`, 15000);
    await app.waitFor(`document.querySelector('#usage-meter.lvl-low')`);
    await audit(app, `${theme}-grid`, '.tile-subs .sub-card .sub-card-model');
    assert.ok(await app.evaluate(`!!document.querySelector('.sub-group .sub-card')`), 'sidebar cards are audited too');

    // Terminals: the pane footer gauge and the subagent bar
    await app.click('.agent-card[data-agent="refactor-auth"]');
    await app.waitFor(`window.__cc.snapshot().view === 'terminals' && document.querySelector('.pane-foot .gauge-pct') && document.querySelector('.pane-sub .sub-card')`, 15000);
    await audit(app, `${theme}-pane`, '.pane-foot .gauge-pct');

    // Usage view
    await app.press('u', { ctrl: true, shift: true });
    await app.waitFor(`window.__cc.snapshot().view === 'usage' && document.querySelector('.usage-table')`, 10000);
    await audit(app, `${theme}-usage-view`, '.usage-view .usage-table');

    // meter levels: amber, red, then the warning in the New agent dialog
    mock.usage.setLimits(limits(80, 10));
    await app.waitFor(`document.querySelector('#usage-meter.lvl-mid')`);
    await audit(app, `${theme}-meter-amber`, '#usage-meter.lvl-mid');
    mock.usage.setLimits(limits(93, 78));
    await app.waitFor(`document.querySelector('#usage-meter.lvl-high')`);
    await audit(app, `${theme}-meter-red`, '#usage-meter.lvl-high');
    await app.press('t', { ctrl: true });
    await app.waitFor(`document.querySelector('[data-modal] .limit-warning')`);
    await sleep(400);
    await audit(app, `${theme}-limit-warning`, '.limit-warning .limit-warning-text');
    await app.press('Escape');
    await app.waitFor(`!document.querySelector('[data-modal]')`);
    mock.usage.setLimits(limits(62, 31));
    await app.waitFor(`document.querySelector('#usage-meter.lvl-low')`);
    await audit(app, `${theme}-meter-low`, '#usage-meter.lvl-low');
  }
});
