// @ts-check
'use strict';
/**
 * End-to-end: Allow / Always / Deny without opening the terminal, and the Inbox, in the real
 * Electron app against the dev mock core (which checks promptId like the real core).
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
const until = async (/** @type {() => any} */ fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout'); };
const q = (/** @type {string} */ sel) => JSON.stringify(sel);
const approveCalls = () => mock.calls.filter((c) => c.method === 'agents.approve' || c.method === 'agents.deny');

/** @param {string} id @param {string} key @param {string} label @param {string} kind */
const opt = (key, label, kind) => ({ key, label, kind });
/** A readable prompt as the core would send it. */
function prompt(id, tool, detail, always = true) {
  return {
    id, tool, detail, question: 'Do you want to proceed?',
    options: [opt('1', 'Yes', 'allow'), ...(always ? [opt('2', `Yes, and don't ask again for: ${detail} *`, 'allow_always')] : []),
      opt(always ? '3' : '2', 'Yes, and switch to auto mode', 'allow_other'), opt(always ? '4' : '3', 'No', 'deny')],
  };
}
/** Put an agent on a permission prompt (or an unreadable one with p = null). */
function ask(/** @type {string} */ id, /** @type {any} */ p) {
  const e = /** @type {any} */ (mock.state.agents.get(id));
  e.running = true;
  if (e.status.state === 'needs_you') mock.setStatus(id, { state: 'working', prompt: undefined });
  mock.setStatus(id, { state: 'needs_you', permission: true, message: `Wants to use ${p ? p.tool : 'Bash'}`, tool: p ? p.tool : 'Bash', prompt: p || undefined });
}
const toasts = () => app.evaluate(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).join('|')`);
const snapshot = () => app.evaluate('window.__cc.snapshot()');

test.before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-appr-'));
  mock = await startMockCore({ home, static: true });
  app = await launchApp({ env: { CC_HOME: home }, size: '1280x800' });
  await app.waitFor(`document.querySelectorAll('.agent-card').length === 5`, 20000);
});

test.after(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
});

test('Allow on the sidebar card answers the prompt shown, without opening the agent', async () => {
  const card = '.agent-card[data-agent="refactor-auth"]';
  await app.waitFor(`document.querySelector(${q(`${card} .approval.compact .appr-allow`)})`);
  const labels = await app.evaluate(`[...document.querySelectorAll(${q(`${card} .appr-btn`)})].map((b) => b.textContent)`);
  assert.deepEqual(labels, ['Allow', 'Always', 'Deny']);
  assert.equal(await app.evaluate(`document.querySelector(${q(`${card} .appr-always`)}).title`), "Yes, and don't ask again for: npm install *");
  assert.match(await app.evaluate(`document.querySelector(${q(`${card} .appr-what`)}).textContent`), /Bash.*npm install jsonwebtoken@9/);
  const before = await snapshot();
  await app.click(`${card} .appr-allow`);
  await until(() => mock.presses.length === 1);
  assert.deepEqual(mock.presses, [{ id: 'refactor-auth', key: '1' }]);
  assert.deepEqual(approveCalls().at(-1)?.params, { id: 'refactor-auth', promptId: 'p-refactor-auth-1', choice: 'allow' });
  await app.waitFor(`!document.querySelector(${q(`${card} .approval`)})`);
  const after = await snapshot();
  assert.deepEqual(after.tabs, before.tabs, 'the click must not open the agent');
  assert.equal(after.view, before.view);
});

test('Always on the pane header picks the "don\'t ask again" option by kind', async () => {
  await app.click('.agent-card[data-agent="docs-pass"]');
  await app.waitFor(`document.querySelector('.tab[data-agent="docs-pass"].active')`);
  ask('docs-pass', { ...prompt('p-docs-1', 'Edit', 'README.md'), options: [opt('1', 'Yes', 'allow'), opt('2', 'Yes, allow all edits during this session (shift+tab)', 'allow_always'), opt('3', 'No', 'deny')] });
  await app.waitFor(`document.querySelector('.pane-head .approval[data-prompt="p-docs-1"] .appr-always')`);
  assert.equal(await app.evaluate(`document.querySelector('.pane-head .appr-always').title`), 'Yes, allow all edits during this session (shift+tab)');
  const n = mock.presses.length;
  await app.click('.pane-head .appr-always');
  await until(() => mock.presses.length === n + 1);
  assert.deepEqual(mock.presses.at(-1), { id: 'docs-pass', key: '2' });
  assert.deepEqual(approveCalls().at(-1)?.params, { id: 'docs-pass', promptId: 'p-docs-1', choice: 'allow_always' });
  await app.waitFor(`!document.querySelector('.pane-head .approval')`);
});

test('no Always button when the prompt has no such option', async () => {
  ask('docs-pass', prompt('p-docs-2', 'Bash', 'ls -la', false));
  await app.waitFor(`document.querySelector('.pane-head .approval[data-prompt="p-docs-2"]')`);
  const labels = await app.evaluate(`[...document.querySelectorAll('.pane-head .appr-btn')].map((b) => b.textContent)`);
  assert.deepEqual(labels, ['Allow', 'Deny']);
  assert.doesNotMatch(await app.evaluate(`document.querySelector('.pane-head .approval').textContent`), /null|undefined/);
});

test('the prompt changed before the click: a toast, no key sent, the new prompt renders', async () => {
  ask('docs-pass', prompt('p-docs-3', 'Bash', 'npm test'));
  await app.waitFor(`document.querySelector('.pane-head .approval[data-prompt="p-docs-3"]')`);
  // Claude redraws the prompt; the app has not heard about it yet.
  /** @type {any} */ (mock.state.agents.get('docs-pass')).status.prompt = prompt('p-docs-4', 'Bash', 'rm -rf build');
  const n = mock.presses.length;
  await app.click('.pane-head .appr-allow');
  await until(async () => /The prompt changed: check it again/.test(await toasts()));
  assert.equal(mock.presses.length, n, 'no key may be pressed');
  assert.equal(approveCalls().at(-1)?.params.promptId, 'p-docs-3');
  mock.setStatus('docs-pass', {}); // the status update with the new prompt arrives
  await app.waitFor(`document.querySelector('.pane-head .approval[data-prompt="p-docs-4"]')`);
  assert.match(await app.evaluate(`document.querySelector('.pane-head .appr-what').textContent`), /rm -rf build/);
  // Buttons are usable again after the refused answer.
  assert.equal(await app.evaluate(`document.querySelector('.pane-head .appr-allow').disabled`), false);
});

test('an unreadable prompt shows only Open (no guessing); Open opens the terminal', async () => {
  ask('api-client', null);
  const card = '.agent-card[data-agent="api-client"]';
  await app.waitFor(`document.querySelector(${q(`${card} .approval.unreadable`)})`);
  assert.equal(await app.evaluate(`document.querySelectorAll(${q(`${card} .appr-btn`)}).length`), 0);
  assert.doesNotMatch(await app.evaluate(`document.querySelector(${q(`${card} .approval`)}).textContent`), /null|undefined/);
  assert.equal(await app.evaluate(`document.querySelector(${q(`${card} .approval button`)}).textContent`), 'Open');
  await app.click(`${card} .appr-open`);
  await app.waitFor(`document.querySelector('.tab[data-agent="api-client"].active')`);
  await app.waitFor(`document.querySelector('.pane-head .approval.unreadable')`);
});

test('the Inbox lists everyone waiting, longest-waiting first, across spaces; Deny there', async () => {
  // docs-pass waits (p-docs-4 since the test above), api-client (unreadable), etl-retry (a question).
  ask('perf-audit', prompt('p-perf-1', 'WebFetch', 'https://example.com'));
  await app.press('A', { ctrl: true, shift: true, code: 'KeyA' });
  await app.waitFor(`window.__cc.snapshot().view === 'inbox' && !document.querySelector('.view-inbox').hidden`);
  await app.waitFor(`document.querySelectorAll('.inbox-row').length === 4`);
  const rows = await app.evaluate(`[...document.querySelectorAll('.inbox-row')].map((r) => r.dataset.agent)`);
  assert.deepEqual(rows, ['etl-retry', 'docs-pass', 'api-client', 'perf-audit']);
  const etl = await app.evaluate(`document.querySelector('.inbox-row[data-agent="etl-retry"]').textContent`);
  assert.match(etl, /Which retry policy/);
  assert.match(etl, /data-pipeline/);
  assert.equal(await app.evaluate(`!!document.querySelector('.inbox-row[data-agent="etl-retry"] .appr-btn')`), false);
  assert.equal(await app.evaluate(`!!document.querySelector('.inbox-row[data-agent="etl-retry"] .inbox-open')`), true);
  assert.match(await app.evaluate(`document.querySelector('.inbox-row[data-agent="perf-audit"]').textContent`), /WebFetch.*https:\/\/example\.com/);
  assert.equal(await app.evaluate(`document.querySelector('.inbox-row[data-agent="perf-audit"] .role-badge').dataset.role`), 'reviewer');
  const n = mock.presses.length;
  await app.click('.inbox-row[data-agent="perf-audit"] .appr-deny');
  await until(() => mock.presses.length === n + 1);
  assert.deepEqual(mock.presses.at(-1), { id: 'perf-audit', key: '\x1b' });
  assert.deepEqual(approveCalls().at(-1), { method: 'agents.deny', params: { id: 'perf-audit', promptId: 'p-perf-1' } });
  await app.waitFor(`document.querySelectorAll('.inbox-row').length === 3`);
});

test('Inbox keyboard: J/K move, A allow, S always, D deny, Enter open', async () => {
  ask('fix-flaky-tests', prompt('p-fix-1', 'Bash', 'npm test -- --repeat 20'));
  ask('landing-copy', prompt('p-land-1', 'Edit', 'pages/index.tsx'));
  await app.waitFor(`document.querySelectorAll('.inbox-row').length === 5`);
  const order = await app.evaluate(`[...document.querySelectorAll('.inbox-row')].map((r) => r.dataset.agent)`);
  assert.deepEqual(order, ['etl-retry', 'docs-pass', 'api-client', 'fix-flaky-tests', 'landing-copy']);
  const sel = () => app.evaluate(`document.querySelector('.inbox-row.sel')?.dataset.agent`);
  assert.equal(await sel(), 'etl-retry');
  await app.press('j');
  assert.equal(await sel(), 'docs-pass');
  await app.press('j');
  await app.press('j');
  assert.equal(await sel(), 'fix-flaky-tests');
  await app.press('k');
  assert.equal(await sel(), 'api-client');
  // A on an unreadable prompt does nothing but say so.
  let n = mock.presses.length;
  await app.press('a');
  await until(async () => /Open it to answer/.test(await toasts()));
  assert.equal(mock.presses.length, n);
  await app.press('j');
  assert.equal(await sel(), 'fix-flaky-tests');
  await app.press('a');
  await until(() => mock.presses.length === n + 1);
  assert.deepEqual(mock.presses.at(-1), { id: 'fix-flaky-tests', key: '1' });
  assert.deepEqual(approveCalls().at(-1)?.params, { id: 'fix-flaky-tests', promptId: 'p-fix-1', choice: 'allow' });
  // The answered row leaves; the selection stays in place (now landing-copy).
  await app.waitFor(`!document.querySelector('.inbox-row[data-agent="fix-flaky-tests"]')`);
  assert.equal(await sel(), 'landing-copy');
  await app.press('s');
  await until(() => mock.presses.length === n + 2);
  assert.deepEqual(mock.presses.at(-1), { id: 'landing-copy', key: '2' });
  assert.deepEqual(approveCalls().at(-1)?.params, { id: 'landing-copy', promptId: 'p-land-1', choice: 'allow_always' });
  await app.waitFor(`!document.querySelector('.inbox-row[data-agent="landing-copy"]')`);
  // S without a "don't ask again" option is refused in the app; D denies.
  ask('landing-copy', prompt('p-land-2', 'Bash', 'ls', false));
  await app.waitFor(`document.querySelector('.inbox-row[data-agent="landing-copy"]')`);
  while ((await sel()) !== 'landing-copy') await app.press('j');
  n = mock.presses.length;
  await app.press('s');
  await until(async () => /no "don't ask again" option/.test(await toasts()));
  assert.equal(mock.presses.length, n);
  await app.press('d');
  await until(() => mock.presses.length === n + 1);
  assert.deepEqual(mock.presses.at(-1), { id: 'landing-copy', key: '\x1b' });
  // Keys typed into a text field are not shortcuts.
  await app.evaluate(`(() => { const i = document.createElement('input'); i.id = 'kbd-probe'; document.querySelector('.view-inbox').append(i); i.focus(); })()`);
  n = mock.presses.length;
  const before = approveCalls().length;
  await app.press('a');
  await app.press('d');
  await sleep(300);
  assert.equal(mock.presses.length, n);
  assert.equal(approveCalls().length, before);
  await app.evaluate(`document.getElementById('kbd-probe').remove(); document.querySelector('.inbox-list').focus()`);
  // Enter opens the selected agent in the Terminals view.
  await app.press('k');
  const target = await sel();
  await app.press('Enter');
  await app.waitFor(`window.__cc.snapshot().view === 'terminals'`);
  await app.waitFor(`document.querySelector('.tab[data-agent=${JSON.stringify(target)}].active')`);
});

test('Inbox empty state', async () => {
  for (const id of ['etl-retry', 'docs-pass', 'api-client']) mock.setStatus(id, { state: 'idle' });
  await app.press('A', { ctrl: true, shift: true, code: 'KeyA' });
  await app.waitFor(`window.__cc.snapshot().view === 'inbox'`);
  await app.waitFor(`document.querySelector('.inbox-empty') && /Nothing needs you/.test(document.querySelector('.inbox-empty').textContent)`);
  assert.equal(await app.evaluate(`document.querySelectorAll('.inbox-row').length`), 0);
});
