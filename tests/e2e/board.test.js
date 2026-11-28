// @ts-check
'use strict';
/** End-to-end: the Board view against the dev mock core. Linux: xvfb-run -a npm run test:e2e */
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
const cols = () => app.evaluate(`Object.fromEntries([...document.querySelectorAll('.board-col')].map((c) => [c.dataset.col, [...c.querySelectorAll('.board-card')].map((x) => x.dataset.agent).sort()]))`);

test.before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-board-'));
  mock = await startMockCore({ home, static: true });
  app = await launchApp({ env: { CC_HOME: home }, size: '1280x800' });
  await app.waitFor(`document.querySelectorAll('.agent-card').length > 0`, 15000);
});

test.after(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
});

test('Ctrl+Shift+B shows the Board: Needs you / Working / Done / Stopped, all spaces', async () => {
  await app.press('B', { ctrl: true, shift: true, code: 'KeyB' });
  await app.waitFor(`window.__cc.snapshot().view === 'board' && document.querySelectorAll('.board-col').length === 4`);
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('.board-col-head .bch-label')].map((e) => e.textContent)`), ['Needs you', 'Working', 'Done', 'Stopped']);
  assert.deepEqual(await cols(), {
    needs: ['etl-retry', 'refactor-auth'],
    working: ['api-client', 'fix-flaky-tests', 'landing-copy'], // starting counts as working
    done: ['docs-pass', 'perf-audit'],
    stopped: ['old-spike'],
  });
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('.bch-count')].map((e) => e.textContent)`), ['2', '4', '4', '1']); // the three outside sessions of the mock count too: 1 working, 2 idle
});

test('cards show role badge, name, space, activity, context % and open the agent on click', async () => {
  const card = await app.evaluate(`(() => { const c = document.querySelector('.board-card[data-agent="refactor-auth"]'); return { role: c.querySelector('.role-badge').textContent, name: c.querySelector('.bc-name').textContent, space: c.querySelector('.bc-space').textContent, activity: c.querySelector('.bc-activity').textContent, pct: c.querySelector('.gauge-pct').textContent, time: c.querySelector('.bc-time').textContent }; })()`);
  assert.equal(card.role, '👑Main');
  assert.equal(card.name, 'refactor-auth');
  assert.equal(card.space, 'cc-dashboard');
  assert.match(card.activity, /Allow Bash/);
  assert.match(card.pct, /^~?\d+(?:\.\d)?[kM]? \/ \d+(?:\.\d)?[kM] \(~?\d+%\)$/);
  assert.match(card.time, /m$/);
  assert.equal(await app.evaluate(`document.querySelector('.board-card[data-agent="old-spike"] .role-badge').textContent`), '🔭Research');
  await app.click('.board-card[data-agent="docs-pass"]');
  await app.waitFor(`window.__cc.snapshot().view === 'terminals' && document.querySelector('.tab[data-agent="docs-pass"].active')`);
  await app.press('B', { ctrl: true, shift: true, code: 'KeyB' });
  await app.waitFor(`window.__cc.snapshot().view === 'board'`);
});

test('cards move between columns when the state changes', async () => {
  mock.setStatus('fix-flaky-tests', { state: 'needs_you', message: 'Pick one', needsSince: Date.now() });
  await app.waitFor(`document.querySelector('.col-needs .board-card[data-agent="fix-flaky-tests"]')`);
  mock.setStatus('fix-flaky-tests', { state: 'exited' });
  await app.waitFor(`document.querySelector('.col-stopped .board-card[data-agent="fix-flaky-tests"]')`);
  mock.setStatus('fix-flaky-tests', { state: 'working' });
  await app.waitFor(`document.querySelector('.col-working .board-card[data-agent="fix-flaky-tests"]')`);
});

test('the filter switches between all spaces and the current space; picking a space keeps the Board', async () => {
  await app.click('.space[data-space="cc-dashboard"]');
  assert.equal(await app.evaluate(`window.__cc.snapshot().view`), 'board');
  await app.click('#board-space');
  await app.waitFor(`document.querySelectorAll('.board-card').length === 5`);
  assert.equal(await app.evaluate(`document.querySelector('.board-card[data-agent="etl-retry"]')`), null);
  await app.click('.space[data-space="data-pipeline"]');
  await app.waitFor(`document.querySelectorAll('.board-card').length === 1 && document.querySelector('.board-card[data-agent="etl-retry"]')`);
  assert.equal(await app.evaluate(`window.__cc.snapshot().view`), 'board', 'a space click on the Board does not leave it');
  await app.click('#board-all');
  await app.waitFor(`document.querySelectorAll('.board-card').length === 8`);
});

test('right-click a board card opens the agent menu', async () => {
  const ok = await app.evaluate(`(() => { const el = document.querySelector('.board-card[data-agent="perf-audit"]'); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 })); return document.querySelector('.ctx-menu') && document.querySelector('.ctx-menu').dataset.agent; })()`);
  assert.equal(ok, 'perf-audit');
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('.ctx-menu')`);
  await sleep(50);
});
