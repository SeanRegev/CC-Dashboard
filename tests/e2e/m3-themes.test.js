// @ts-check
'use strict';
/**
 * End-to-end: the M3 surfaces (subagent strip, activity drawer, outside tiles, take-over dialog, sidebar badge) in
 * the dark and the light theme at 1024x768 (the clamped CI window) and 1440x900. Saves screenshots to
 * $CC_SHOT_DIR (default test-results/) and fails when visible text is nearly unreadable (contrast under 3:1,
 * 4:1 for "needs you" amber). Dev mock core.
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
const VSC = 'ext:5f0c8a10-1111-4c1e-9a0b-00000000vsc0';

/** Runs in the page: every visible text node's colour against the first opaque background above it. */
const AUDIT = `(() => {
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const bgOf = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base); return base; };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent.trim()) continue;
    seen.add(el);
    if (el.closest('.xterm, [hidden], script, style, .sr-only')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight) continue;
    // an element hidden by an ancestor's opacity or clipping is not interesting
    let hidden = false; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || Number(s.opacity) === 0 || e.hidden) { hidden = true; break; } }
    if (hidden) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    const eff = over(fg, bg);
    const a = lum(eff), b = lum(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const op = (() => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; })();
    out.push({ text: n.textContent.trim().slice(0, 40), cls: (el.className && el.className.baseVal === undefined ? el.className : '').toString().slice(0, 50), ratio: Math.round(ratio * 100) / 100 * (op < 1 ? 1 : 1), op });
  }
  return out;
})()`;


for (const size of ['1024x768', '1440x900']) {
  test(`M3 surfaces are readable in both themes at ${size}`, { timeout: 120000 }, async (t) => {
    fs.mkdirSync(OUT, { recursive: true });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-m3themes-'));
    const mock = await startMockCore({ home, static: true });
    const app = await launchApp({ env: { CC_HOME: home }, size });
    t.after(async () => { await app.close(); await mock.close(); });
    await app.waitFor(`document.querySelectorAll('.agent-card').length === 5`, 20000);

    /** @param {string} name */
    async function audit(name) {
      await app.screenshot(path.join(OUT, `m3-${name}-${size}.png`));
      /** @type {Array<{text:string, cls:string, ratio:number}>} */
      const rows = await app.evaluate(AUDIT);
      const bad = rows.filter((r) => r.ratio < (/needs|(^|\s)count|tab-needs/.test(r.cls) ? 4 : 3));
      assert.deepEqual(bad.map((r) => `${r.text} (${r.cls}) ${r.ratio}`), [], `${name} ${size}: unreadable text`);
    }

    for (const theme of ['dark', 'light']) {
      await app.press(',', { ctrl: true, code: 'Comma', keyCode: 188 });
      await app.waitFor(`document.querySelector('[data-modal="settings"]')`);
      await app.click(`[data-name="theme"] [data-value="${theme}"]`);
      await app.waitFor(`document.documentElement.dataset.theme === ${q(theme)}`);
      await app.press('Escape');
      await app.waitFor(`!document.querySelector('[data-modal]')`);

      await app.click('.space[data-space="cc-dashboard"]');
      await app.waitFor(`window.__cc.snapshot().view === 'grid' && document.querySelector('.tile-subs .sub-chip') && document.querySelector('.ext-tile')`, 15000);
      await sleep(300);
      await audit(`${theme}-grid-strip-outside`);

      // the drawer on a session with subagents, then filtered to one
      await app.evaluate(`window.__cc.openActivity('refactor-auth')`);
      await app.waitFor(`!document.getElementById('activity-drawer').hidden && document.querySelectorAll('#activity-drawer .act-line').length > 3`);
      await sleep(300);
      await audit(`${theme}-drawer`);
      await app.click('#activity-drawer .act-item.sub.needs');
      await sleep(250);
      await audit(`${theme}-drawer-subagent`);
      await app.evaluate(`window.__cc.openActivity(${q(VSC)})`);
      await app.waitFor(`document.querySelector('#activity-drawer.is-outside')`);
      await sleep(300);
      await audit(`${theme}-drawer-outside`);
      await app.press('Escape');
      await app.waitFor(`document.getElementById('activity-drawer').hidden`);

      // take-over dialogs: idle, and the working warning
      await app.click(`.ext-tile.st-idle .ext-takeover`);
      await app.waitFor(`document.querySelector('.eo-modal')`);
      await sleep(500); // the dialog fades in
      await audit(`${theme}-takeover`);
      await app.press('Escape');
      await app.waitFor(`!document.querySelector('.eo-modal')`);
      await app.click(`.ext-tile[data-ext=${q(VSC)}] .ext-takeover`);
      await app.waitFor(`document.querySelector('.eo-warn')`);
      await sleep(500);
      await audit(`${theme}-takeover-working`);
      await app.press('Escape');
      await app.waitFor(`!document.querySelector('.eo-modal')`);

      // sidebar: badge, outside block
      await app.waitFor(`document.querySelector('.agent-card .sub-badge') && document.querySelector('.ext-block')`);
      await audit(`${theme}-sidebar`);
    }
  });
}
