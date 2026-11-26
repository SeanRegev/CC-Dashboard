// @ts-check
'use strict';
/**
 * End-to-end: one realistic session through every milestone-2 feature at once (sidebar -> Grid ->
 * approvals -> roles -> rename -> theme -> Library -> Dashboards -> Terminals), then the core
 * connection drops and comes back. Dev mock core. Linux: xvfb-run -a npm run test:e2e
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
const calls = (/** @type {string} */ m) => mock.calls.filter((c) => c.method === m);
const q = (/** @type {string} */ s) => JSON.stringify(s);
const view = () => app.evaluate('window.__cc.snapshot().view');
const goView = async (/** @type {string} */ v) => { await app.click(`.view-switch button[data-view="${v}"]`); await app.waitFor(`window.__cc.snapshot().view === ${q(v)}`); };
const slots = (/** @type {string} */ id) => app.evaluate(`document.querySelectorAll('.term-slot[data-agent=${q(id)}]').length`);
const contextMenu = (/** @type {string} */ sel) => app.evaluate(`(() => { const el = document.querySelector(${q(sel)}); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 })); })()`);
const tileIds = () => app.evaluate(`[...document.querySelectorAll('.tile')].map((t) => t.dataset.agent)`);
/** attaches minus detaches the app made for an agent so far (what the core still holds open for it) */
const netAttach = (/** @type {string} */ id) => calls('agents.attach').filter((c) => c.params.id === id).length - calls('agents.detach').filter((c) => c.params.id === id).length;
const F2 = { code: 'F2', keyCode: 113 };

test.before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-m2flow-'));
  mock = await startMockCore({ home, static: true });
  app = await launchApp({ env: { CC_HOME: home }, size: '1400x900' });
  await app.waitFor(`document.querySelectorAll('.agent-card').length === 5`, 20000);
});

test.after(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
});

test('1. a space in the sidebar opens its Grid; the Inbox knows who waits', async () => {
  await app.click('.space[data-space="cc-dashboard"]');
  await app.waitFor(`window.__cc.snapshot().view === 'grid' && document.querySelectorAll('.tile').length === 5`);
  assert.deepEqual(await tileIds(), ['refactor-auth', 'fix-flaky-tests', 'api-client', 'docs-pass', 'old-spike']);
  await goView('inbox');
  await app.waitFor(`document.querySelectorAll('.inbox-row').length === 2`);
  assert.ok(await app.evaluate(`!!document.querySelector('.inbox-row[data-agent="refactor-auth"] .appr-allow')`));
  await goView('grid');
});

test('2. Allow on a grid tile answers once; the Inbox entry goes away, the other waiter stays', async () => {
  const sel = '.tile[data-agent="refactor-auth"] .appr-allow';
  await app.waitFor(`document.querySelector(${q(sel)})`);
  await app.click(sel);
  await until(() => mock.presses.length === 1);
  assert.deepEqual(mock.presses, [{ id: 'refactor-auth', key: '1' }]);
  assert.equal(calls('agents.approve').length, 1);
  await app.waitFor(`!document.querySelector('.tile[data-agent="refactor-auth"] .approval')`);
  await goView('inbox');
  await app.waitFor(`document.querySelectorAll('.inbox-row').length === 1 && !document.querySelector('.inbox-row[data-agent="refactor-auth"]')`);
  assert.ok(await app.evaluate(`!!document.querySelector('.inbox-row[data-agent="etl-retry"]')`));
  await goView('grid');
});

test('3. right-click Make Main moves the crown and the grid order', async () => {
  await contextMenu('.tile[data-agent="docs-pass"]');
  await app.waitFor(`document.querySelector('.ctx-menu [data-action="make-main"]')`);
  await app.click('.ctx-menu [data-action="make-main"]');
  await until(async () => (await tileIds())[0] === 'docs-pass');
  assert.deepEqual(calls('agents.update').pop().params, { id: 'docs-pass', role: { id: 'main' } });
  assert.equal(await app.evaluate(`document.querySelector('.tile[data-agent="refactor-auth"] .role-badge').dataset.role`), 'worker');
  assert.equal(await app.evaluate(`document.querySelectorAll('.tile .role-badge[data-role="main"]').length`), 1);
  assert.equal(await app.evaluate(`document.querySelectorAll('.agent-card .role-badge[data-role="main"]').length`), 1);
});

test('4. F2 on the focused tile renames it and sets its role; the Board shows both', async () => {
  await app.evaluate(`document.querySelector('.tile[data-agent="fix-flaky-tests"]').focus()`);
  await app.press('F2', F2);
  await app.waitFor(`document.querySelector('[data-modal="agent-edit"]')`);
  assert.equal(await app.evaluate(`document.getElementById('ae-name').value`), 'fix-flaky-tests', 'F2 edits the tile that has the focus');
  await app.evaluate(`document.getElementById('ae-name').value = 'flake-hunt'`);
  await app.click('.role-chip[data-role="debug"]');
  await app.click('#ae-save');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
  await goView('board');
  await app.waitFor(`document.querySelector('.board-col[data-col="working"] .board-card[data-agent="fix-flaky-tests"]')`);
  const card = '.board-col[data-col="working"] .board-card[data-agent="fix-flaky-tests"]';
  assert.equal(await app.evaluate(`document.querySelector(${q(`${card} .bc-name`)}).textContent`), 'flake-hunt');
  assert.equal(await app.evaluate(`document.querySelector(${q(`${card} .role-badge`)}).dataset.role`), 'debug');
});

test('5. light theme in Settings reaches every view', async () => {
  await app.press(',', { ctrl: true, code: 'Comma', keyCode: 188 });
  await app.waitFor(`document.querySelector('[data-modal="settings"]')`);
  await app.click('[data-name="theme"] [data-value="light"]');
  await app.waitFor(`document.documentElement.dataset.theme === 'light'`);
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
  assert.equal(await view(), 'board');
  assert.equal(await app.evaluate(`getComputedStyle(document.body).backgroundColor`), 'rgb(236, 231, 226)');
});

test('6. Library: switch a plugin off, Try it on a skill prefills New agent', async () => {
  await goView('library');
  await app.waitFor(`document.querySelectorAll('.plugin-card').length >= 4`);
  const id = 'engineering@claude-plugins-official';
  const sw = `.plugin-card[data-plugin="${id}"] .switch`;
  assert.equal(await app.evaluate(`document.querySelector(${q(sw)}).getAttribute('aria-checked')`), 'true');
  await app.click(sw);
  await app.waitFor(`document.querySelector(${q(sw)}).getAttribute('aria-checked') === 'false'`);
  assert.deepEqual(calls('library.pluginAction').pop().params, { id, action: 'disable' });
  await app.click('.lib-tab[data-tab="skills"]');
  await app.waitFor(`document.querySelector('.skill-row[data-skill="user:session-start-hook"]')`);
  await app.click('.skill-row[data-skill="user:session-start-hook"]');
  await app.waitFor(`document.querySelector('.lib-detail [data-act="try"]')`);
  await app.click('.lib-detail [data-act="try"]');
  await app.waitFor(`document.querySelector('[data-modal="new-agent"]')`);
  assert.equal(await app.evaluate(`document.querySelector('#na-prompt').value`), '/session-start-hook ');
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
});

test('7. Dashboards: the CodeBurn terminal opens and Back returns; its terminal is not an agent terminal', async () => {
  await goView('dashboards');
  await app.waitFor(`document.querySelector('.dash-card[data-dash="codeburn-terminal"] .dash-open')`);
  await app.click('.dash-card[data-dash="codeburn-terminal"] .dash-open');
  await until(async () => /Total\s+\$42\.18/.test(await app.evaluate(`(document.querySelector('.dash-term .xterm-rows') || {}).textContent || ''`)));
  assert.equal(await app.evaluate(`document.querySelectorAll('.dash-term .term-slot').length`), 1);
  await app.click('[data-act="stop"]');
  await app.click('[data-act="back"]');
  await app.waitFor(`document.querySelectorAll('.dash-card').length >= 5 && !document.querySelector('.dash-term')`);
  assert.ok(calls('dashboards.detach').some((c) => c.params.id === 'codeburn-terminal'));
});

test('8. Terminals: an agent opened from the sidebar has exactly one terminal, wherever it was shown before', async () => {
  // docs-pass was a live grid tile earlier; now it opens as a tab
  await app.click('.agent-card[data-agent="docs-pass"]');
  await app.waitFor(`window.__cc.snapshot().view === 'terminals' && document.querySelector('.tab[data-agent="docs-pass"].active')`);
  await app.waitFor(`document.querySelector('.term-slot[data-agent="docs-pass"] .xterm-rows')`);
  await until(async () => /README/.test(await app.evaluate(`window.__cc.termText('docs-pass') || ''`)));
  assert.equal(await slots('docs-pass'), 1);
  assert.equal(await app.evaluate(`document.querySelectorAll('.pane .term-slot[data-agent="docs-pass"]').length`), 1);
  await goView('grid');
  await app.waitFor(`document.querySelector('.tile[data-agent="docs-pass"][data-live="true"]')`);
  assert.equal(await slots('docs-pass'), 1, 'the terminal moved into the tile, it was not copied');
  await goView('terminals');
  await app.waitFor(`document.querySelector('.pane .term-slot[data-agent="docs-pass"]')`);
  assert.equal(await slots('docs-pass'), 1);
  assert.ok(netAttach('docs-pass') <= 1, `core holds ${netAttach('docs-pass')} attaches for docs-pass`);
  for (const id of ['refactor-auth', 'fix-flaky-tests', 'api-client', 'old-spike']) {
    assert.ok(netAttach(id) <= 0, `${id}: attach leaked (${netAttach(id)})`);
    assert.equal(await slots(id), 0, `${id} has no terminal element left behind`);
  }
});

test('9. everything still works after the core connection drops and comes back', async () => {
  mock.dropClients();
  await app.waitFor(`window.__cc.snapshot().conn === 'open'`, 15000);
  // the open terminal got its replay again and still takes keys
  await until(async () => /README/.test(await app.evaluate(`window.__cc.termText('docs-pass') || ''`)), 10000);
  assert.equal(await slots('docs-pass'), 1);
  await app.evaluate(`document.querySelector('.term-slot[data-agent="docs-pass"] textarea').focus()`);
  await app.insertText('after reconnect');
  await app.press('Enter');
  await until(() => mock.inputs.join('').includes('after reconnect\r'));
  // statuses, approvals, grid, board and roles are live again
  mock.setStatus('old-spike', { state: 'needs_you', permission: true, message: 'Wants Bash', tool: 'Bash', prompt: { id: 'p-spike', tool: 'Bash', detail: 'ls', question: 'Do you want to proceed?', options: [{ key: '1', label: 'Yes', kind: 'allow' }, { key: '2', label: 'No', kind: 'deny' }] } });
  mock.state.agents.get('old-spike').running = true;
  await goView('grid');
  await app.waitFor(`document.querySelector('.tile[data-agent="old-spike"] .appr-allow')`);
  const n = mock.presses.length;
  await app.click('.tile[data-agent="old-spike"] .appr-allow');
  await until(() => mock.presses.length === n + 1);
  assert.deepEqual(mock.presses.at(-1), { id: 'old-spike', key: '1' });
  await contextMenu('.tile[data-agent="refactor-auth"]');
  await app.waitFor(`document.querySelector('.ctx-menu [data-action="make-main"]')`);
  await app.click('.ctx-menu [data-action="make-main"]');
  await until(async () => (await tileIds())[0] === 'refactor-auth');
  await goView('board');
  await app.waitFor(`document.querySelector('.board-card[data-agent="refactor-auth"] .role-badge[data-role="main"]')`);
  // never two terminals for one agent, never a leaked attach
  for (const id of await app.evaluate('window.__cc.liveTerminals()')) assert.ok(await slots(id) <= 1, id);
  await app.screenshot(path.join(__dirname, '..', '..', 'test-results', 'm2-flow-end.png'));
});
