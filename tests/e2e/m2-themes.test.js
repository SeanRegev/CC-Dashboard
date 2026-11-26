// @ts-check
'use strict';
/**
 * End-to-end: every view and dialog in the dark and the light theme. Saves a screenshot of each to
 * test-results/theme-<theme>-<view>.png and fails when visible text is nearly unreadable against its
 * background (contrast ratio under 3:1; the muted greys are meant to stay above 4.5:1 but are only
 * reported). Dev mock core.
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
const RESULTS = path.join(__dirname, '..', '..', 'test-results');
const q = (/** @type {string} */ s) => JSON.stringify(s);
const goView = async (/** @type {string} */ v) => { await app.click(`.view-switch button[data-view="${v}"]`); await app.waitFor(`window.__cc.snapshot().view === ${q(v)}`); await sleep(250); };

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

/** @type {Set<string>} */
const WEAK = new Set();

/** @param {string} name */
async function audit(name) {
  await app.screenshot(path.join(RESULTS, `theme-${name}.png`));
  /** @type {Array<{text:string, cls:string, ratio:number, op:number}>} */
  const rows = await app.evaluate(AUDIT);
  // needs-you amber (badges, pill, counts) carries meaning: hold it to 4:1 in both themes
  const bad = rows.filter((r) => r.ratio < (/needs|(^|\s)count|inbox-count|tab-needs/.test(r.cls) ? 4 : 3));
  const weak = rows.filter((r) => r.ratio >= 3 && r.ratio < 4.5);
  for (const r of weak) WEAK.add(`${name.split('-')[0]} ${r.cls || '(text)'} ${r.ratio}`);
  assert.deepEqual(bad.map((r) => `${r.text} (${r.cls}) ${r.ratio}`), [], `${name}: unreadable text`);
}

test.before(async () => {
  fs.mkdirSync(RESULTS, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-themes-'));
  mock = await startMockCore({ home, static: true });
  app = await launchApp({ env: { CC_HOME: home }, size: '1400x900' });
  await app.waitFor(`document.querySelectorAll('.agent-card').length === 5`, 20000);
});

test.after(async () => {
  if (process.env.CC_THEME_REPORT) console.log([...WEAK].sort().join('\n'));
  if (app) await app.close();
  if (mock) await mock.close();
});

for (const theme of ['dark', 'light']) {
  test(`${theme}: every view and dialog is readable`, async () => {
    await app.evaluate(`document.documentElement.dataset.theme = ${q(theme)}`);
    // (the Settings dialog is the real switch; this also covers a stylesheet that keys off the attribute alone)
    await app.press(',', { ctrl: true, code: 'Comma', keyCode: 188 });
    await app.waitFor(`document.querySelector('[data-modal="settings"]')`);
    await app.click(`[data-name="theme"] [data-value="${theme}"]`);
    await app.waitFor(`document.documentElement.dataset.theme === ${q(theme)}`);
    await sleep(200);
    await audit(`${theme}-settings`);
    await app.press('Escape');
    await app.waitFor(`!document.querySelector('[data-modal]')`);

    await app.click('.agent-card[data-agent="docs-pass"]');
    await app.waitFor(`document.querySelector('.tab[data-agent="docs-pass"].active')`);
    await sleep(300);
    await audit(`${theme}-terminals`);
    await app.click('.agent-card[data-agent="refactor-auth"]');
    await app.waitFor(`document.querySelector('.pane-head .approval')`);
    await audit(`${theme}-terminals-approval`);

    await goView('grid');
    await audit(`${theme}-grid`);
    await goView('board');
    await audit(`${theme}-board`);
    await goView('inbox');
    await audit(`${theme}-inbox`);
    await goView('library');
    await app.click('.lib-tab[data-tab="plugins"]');
    await app.waitFor(`document.querySelectorAll('.plugin-card').length >= 4`);
    await audit(`${theme}-library-plugins`);
    for (const t of ['skills', 'browse', 'marketplaces']) {
      await app.click(`.lib-tab[data-tab="${t}"]`);
      await sleep(250);
      if (t === 'skills') { await app.click('.skill-row'); await sleep(200); }
      await audit(`${theme}-library-${t}`);
    }
    await goView('dashboards');
    await app.waitFor(`document.querySelectorAll('.dash-card').length >= 5`);
    await audit(`${theme}-dashboards`);
    await app.click('.dash-card[data-dash="codeburn-terminal"] .dash-open');
    await app.waitFor(`document.querySelector('.dash-term .xterm-rows')`);
    await sleep(300);
    await audit(`${theme}-dashboards-terminal`);
    await app.click('[data-act="stop"]');
    await app.click('[data-act="back"]');
    // dialogs
    await app.click('#dash-add');
    await app.waitFor(`document.querySelector('[data-modal="dash-add"]')`);
    await audit(`${theme}-dialog-dash-add`);
    await app.press('Escape');
    await goView('grid');
    await app.evaluate(`(() => { const el = document.querySelector('.tile'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 })); })()`);
    await app.waitFor(`document.querySelector('.ctx-menu')`);
    await audit(`${theme}-context-menu`);
    await app.press('Escape');
    await app.press('k', { ctrl: true });
    await app.waitFor(`document.querySelector('[data-modal="quick-switch"]')`);
    await audit(`${theme}-quick-switcher`);
    await app.press('Escape');
    await app.press('t', { ctrl: true });
    await app.waitFor(`document.querySelector('[data-modal="new-agent"]')`);
    await audit(`${theme}-dialog-new-agent`);
    await app.press('Escape');
    await app.waitFor(`!document.querySelector('[data-modal]')`);
    await app.click('.view-switch button[data-view="terminals"]');
    await app.click('.agent-card[data-agent="docs-pass"]');
    await app.press('F2', { code: 'F2', keyCode: 113 });
    await app.waitFor(`document.querySelector('[data-modal="agent-edit"]')`);
    await audit(`${theme}-dialog-agent-edit`);
    await app.press('Escape');
    await app.waitFor(`!document.querySelector('[data-modal]')`);
  });
}
