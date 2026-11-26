// @ts-check
'use strict';
/**
 * End-to-end: where the milestone-2 tracks meet. Dialogs vs shortcuts, one answer for one prompt in every
 * place that shows it, names and roles agreeing everywhere, terminals handed between views.
 * Dev mock core. Linux: xvfb-run -a npm run test:e2e
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
const answers = () => mock.calls.filter((c) => c.method === 'agents.approve' || c.method === 'agents.deny');
const q = (/** @type {string} */ s) => JSON.stringify(s);
const goView = async (/** @type {string} */ v) => { await app.click(`.view-switch button[data-view="${v}"]`); await app.waitFor(`window.__cc.snapshot().view === ${q(v)}`); };
const view = () => app.evaluate('window.__cc.snapshot().view');
const modals = () => app.evaluate(`[...document.querySelectorAll('[data-modal]')].map((m) => m.dataset.modal)`);
const F2 = { code: 'F2', keyCode: 113 };
const CTRL_COMMA = { ctrl: true, code: 'Comma', keyCode: 188 };
const shiftCtrl = (/** @type {string} */ k) => ({ ctrl: true, shift: true, code: `Key${k.toUpperCase()}` });
const opt = (/** @type {string} */ key, /** @type {string} */ label, /** @type {string} */ kind) => ({ key, label, kind });
/** @param {string} id @param {string} pid @param {string} [detail] */
function ask(id, pid, detail = 'npm test') {
  const e = /** @type {any} */ (mock.state.agents.get(id));
  e.running = true;
  if (e.status.state === 'needs_you') mock.setStatus(id, { state: 'working', prompt: undefined });
  mock.setStatus(id, { state: 'needs_you', permission: true, message: 'Wants Bash', tool: 'Bash', prompt: { id: pid, tool: 'Bash', detail, question: 'Do you want to proceed?', options: [opt('1', 'Yes', 'allow'), opt('2', `Yes, and don't ask again for: ${detail}`, 'allow_always'), opt('3', 'No', 'deny')] } });
}

test.before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-m2seams-'));
  mock = await startMockCore({ home, static: true });
  app = await launchApp({ env: { CC_HOME: home }, size: '1400x900' });
  await app.waitFor(`document.querySelectorAll('.agent-card').length === 5`, 20000);
});

test.after(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
});

test('shortcuts stay out of the Dashboards and Library dialogs', async () => {
  await goView('dashboards');
  await app.waitFor(`document.getElementById('dash-add')`);
  await app.click('#dash-add');
  await app.waitFor(`document.querySelector('[data-modal="dash-add"]')`);
  for (const [key, mods] of [['F2', F2], [',', CTRL_COMMA], ['g', shiftCtrl('g')], ['t', { ctrl: true }], ['k', { ctrl: true }]]) {
    await app.press(/** @type {string} */ (key), /** @type {any} */ (mods));
  }
  await sleep(150);
  assert.deepEqual(await modals(), ['dash-add'], 'no second dialog on top');
  assert.equal(await view(), 'dashboards', 'the view did not change under the dialog');
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
  // the same for a Library dialog
  await goView('library');
  await app.waitFor(`document.querySelector('.plugin-card')`);
  await app.click('.plugin-card[data-plugin="figma@claude-plugins-official"]');
  await app.waitFor(`document.querySelector('.lib-detail [data-act="configure"]')`);
  await app.click('.lib-detail [data-act="configure"]');
  await app.waitFor(`document.querySelector('[data-modal="lib-configure"]')`);
  await app.press('g', shiftCtrl('g'));
  await app.press('F2', F2);
  await sleep(150);
  assert.deepEqual(await modals(), ['lib-configure']);
  assert.equal(await view(), 'library');
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
});

test('Inbox letters are plain text in the rename dialog and in Settings', async () => {
  ask('docs-pass', 'p-docs-a');
  ask('fix-flaky-tests', 'p-fix-a');
  await goView('inbox');
  await app.waitFor(`document.querySelector('.inbox-row[data-agent="docs-pass"]')`);
  const before = answers().length;
  // F2 on a focused Inbox row edits that agent; the keys typed into its name field are not shortcuts
  await app.click('.inbox-row[data-agent="docs-pass"]');
  await app.waitFor(`document.querySelector('.inbox-row.sel').dataset.agent === 'docs-pass'`);
  await app.press('F2', F2);
  await app.waitFor(`document.querySelector('[data-modal="agent-edit"]')`);
  assert.equal(await app.evaluate(`document.getElementById('ae-name').value`), 'docs-pass');
  await app.evaluate(`(() => { const n = document.getElementById('ae-name'); n.value = ''; n.focus(); })()`);
  for (const k of ['a', 's', 'd', 'j', 'k']) await app.press(k);
  assert.equal(await app.evaluate(`document.getElementById('ae-name').value`), 'asdjk');
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
  // Settings
  await app.press(',', CTRL_COMMA);
  await app.waitFor(`document.querySelector('[data-modal="settings"]')`);
  await app.evaluate(`document.getElementById('set-font-family').focus()`);
  for (const k of ['a', 's', 'd']) await app.press(k);
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
  await sleep(100);
  assert.equal(answers().length, before, 'no prompt was answered by typing');
  assert.equal(await app.evaluate(`document.querySelectorAll('.inbox-row').length`), 4);
});

test('Inbox letters do not reach a terminal, and a terminal does not trigger them', async () => {
  await app.click('.inbox-row[data-agent="docs-pass"] .inbox-open');
  await app.waitFor(`window.__cc.snapshot().view === 'terminals' && document.querySelector('.term-slot[data-agent="docs-pass"] textarea')`);
  await app.evaluate(`document.querySelector('.term-slot[data-agent="docs-pass"] textarea').focus()`);
  const n = answers().length;
  mock.inputs.length = 0;
  await app.press('a'); await app.press('d'); await app.press('s');
  await until(() => mock.inputs.join('') === 'ads');
  assert.equal(answers().length, n);
  // and back in the Inbox the keys act on the list, not the (hidden) terminal
  await goView('inbox');
  mock.inputs.length = 0;
  await app.press('j');
  await sleep(150);
  assert.deepEqual(mock.inputs, []);
});

test('one prompt, answered in one place: the sidebar, the pane header and the grid tile all follow', async () => {
  ask('refactor-auth', 'p-ra-1', 'npm install x');
  await app.click('.agent-card[data-agent="refactor-auth"]');
  await app.waitFor(`document.querySelector('.pane-head .approval[data-prompt="p-ra-1"]') && document.querySelector('.agent-card[data-agent="refactor-auth"] .approval[data-prompt="p-ra-1"]')`);
  const n = answers().length;
  // two quick clicks on the same button: one answer
  await app.evaluate(`(() => { const b = document.querySelector('.agent-card[data-agent="refactor-auth"] .appr-allow'); b.click(); b.click(); })()`);
  await until(() => answers().length === n + 1);
  await sleep(200);
  assert.equal(answers().length, n + 1);
  await app.waitFor(`!document.querySelector('.pane-head .approval') && !document.querySelector('.agent-card[data-agent="refactor-auth"] .approval')`);
  // next prompt: the grid tile and the board card, one click each prompt
  ask('refactor-auth', 'p-ra-2', 'npm install y');
  await goView('grid');
  await app.waitFor(`document.querySelector('.tile[data-agent="refactor-auth"] .approval[data-prompt="p-ra-2"]')`);
  const m = answers().length;
  await app.evaluate(`(() => { const b = document.querySelector('.tile[data-agent="refactor-auth"] .appr-deny'); b.click(); b.click(); })()`);
  await until(() => answers().length === m + 1);
  await sleep(200);
  assert.equal(answers().length, m + 1);
  assert.equal(calls('agents.deny').at(-1).params.promptId, 'p-ra-2');
  await app.waitFor(`!document.querySelector('.tile[data-agent="refactor-auth"] .approval')`);
  ask('refactor-auth', 'p-ra-3', 'npm install z');
  await goView('board');
  await app.waitFor(`document.querySelector('.board-card[data-agent="refactor-auth"] .approval[data-prompt="p-ra-3"]')`);
  const k = answers().length;
  await app.click('.board-card[data-agent="refactor-auth"] .appr-always');
  await until(() => answers().length === k + 1);
  assert.deepEqual(answers().at(-1).params, { id: 'refactor-auth', promptId: 'p-ra-3', choice: 'allow_always' });
  await app.waitFor(`!document.querySelector('.board-card[data-agent="refactor-auth"] .approval')`);
});

test('a rename and a role change show up everywhere: tab, pane, sidebar, grid, board, inbox, quick switcher', async () => {
  await app.click('.agent-card[data-agent="docs-pass"]');
  await app.waitFor(`window.__cc.snapshot().view === 'terminals' && document.querySelector('.tab[data-agent="docs-pass"].active')`);
  await app.press('F2', F2);
  await app.waitFor(`document.querySelector('[data-modal="agent-edit"]')`);
  assert.equal(await app.evaluate(`document.getElementById('ae-name').value`), 'docs-pass');
  await app.evaluate(`document.getElementById('ae-name').value = 'readme-polish'`);
  await app.click('.role-chip[data-role="reviewer"]');
  await app.click('#ae-save');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
  const check = async (/** @type {string} */ where, /** @type {string} */ nameSel, /** @type {string} */ badgeSel) => {
    await app.waitFor(`(document.querySelector(${q(nameSel)}) || {}).textContent === 'readme-polish'`, 4000).catch(() => { throw new Error(`${where}: name not updated`); });
    assert.equal(await app.evaluate(`document.querySelector(${q(badgeSel)}).dataset.role`), 'reviewer', `${where}: role`);
  };
  await check('tab', '.tab[data-agent="docs-pass"] .tab-name', '.tab[data-agent="docs-pass"] .role-badge');
  await check('pane', '.pane-title', '.pane-head .role-badge');
  await check('sidebar', '.agent-card[data-agent="docs-pass"] .agent-name', '.agent-card[data-agent="docs-pass"] .role-badge');
  await app.press('k', { ctrl: true });
  await app.waitFor(`document.querySelector('[data-modal="quick-switch"]')`);
  await app.evaluate(`(() => { const i = document.getElementById('qs-input'); i.value = 'readme'; i.dispatchEvent(new Event('input')); })()`);
  await check('quick switcher', '.qs-item[data-agent="docs-pass"] .qs-name', '.qs-item[data-agent="docs-pass"] .role-badge');
  await app.press('Escape');
  await goView('grid');
  await check('grid', '.tile[data-agent="docs-pass"] .tile-name', '.tile[data-agent="docs-pass"] .role-badge');
  await goView('board');
  await check('board', '.board-card[data-agent="docs-pass"] .bc-name', '.board-card[data-agent="docs-pass"] .role-badge');
  ask('docs-pass', 'p-docs-r');
  await goView('inbox');
  await check('inbox', '.inbox-row[data-agent="docs-pass"] .inbox-name', '.inbox-row[data-agent="docs-pass"] .role-badge');
});

test('switching views quickly leaves one terminal element per agent and no leaked attach', async () => {
  const open = ['docs-pass', 'refactor-auth'];
  for (const id of open) { await app.click(`.agent-card[data-agent="${id}"]`); await app.waitFor(`document.querySelector('.tab[data-agent="${id}"].active')`); }
  const views = ['grid', 'terminals', 'board', 'grid', 'dashboards', 'terminals', 'grid', 'inbox', 'grid', 'library', 'terminals', 'grid', 'terminals'];
  for (let round = 0; round < 3; round++) {
    for (const v of views) await app.evaluate(`document.querySelector('.view-switch button[data-view="${v}"]').click()`);
  }
  await app.waitFor(`window.__cc.snapshot().view === 'terminals'`);
  await sleep(500);
  const counts = await app.evaluate(`Object.fromEntries([...new Set([...document.querySelectorAll('.term-slot')].map((t) => t.dataset.agent))].map((id) => [id, document.querySelectorAll('.term-slot[data-agent="' + id + '"]').length]))`);
  for (const [id, n] of Object.entries(counts)) assert.equal(n, 1, `${id} has ${n} terminal elements`);
  assert.deepEqual(Object.keys(counts), ['refactor-auth'], 'only the focused pane\'s terminal is in the page; background tabs are parked');
  assert.deepEqual((await app.evaluate('window.__cc.liveTerminals()')).sort(), open.slice().sort());
  const attached = (/** @type {string} */ id) => calls('agents.attach').filter((c) => c.params.id === id).length - calls('agents.detach').filter((c) => c.params.id === id).length;
  for (const id of [...mock.state.agents.keys()]) assert.equal(attached(id), open.includes(id) ? 1 : 0, `${id}: attaches minus detaches`);
  // both pane terminals are visible and sized
  await app.waitFor(`document.querySelector('.pane .term-slot').getBoundingClientRect().width > 100`);
});
