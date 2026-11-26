// @ts-check
'use strict';
/**
 * End-to-end: settings (theme, terminal font, persistence), the agent edit dialog (F2, roles),
 * the New agent role picker and "Quit and stop all agents", against the dev mock core.
 * Linux CI: xvfb-run -a node --test "tests/e2e/**\/*.test.js"
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
let home = '';
const until = async (/** @type {() => any} */ fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout'); };
const comma = { ctrl: true, code: 'Comma', keyCode: 188 };
const savedSettings = () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'ui-settings.json'), 'utf8')); } catch { return null; } };
const theme = (/** @type {string} */ id) => app.evaluate(`(() => { const e = document.querySelector('.term-slot[data-agent="${id}"] .xterm-viewport'); return e ? getComputedStyle(e).backgroundColor : null; })()`);
const rowFont = (/** @type {string} */ id) => app.evaluate(`(() => { const e = document.querySelector('.term-slot[data-agent="${id}"] .xterm-rows'); return e ? getComputedStyle(e).fontSize : null; })()`);

test.before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-settings-'));
  mock = await startMockCore({ home, static: true });
  app = await launchApp({ env: { CC_HOME: home }, size: '1280x800' });
  await app.waitFor(`document.querySelectorAll('.agent-card').length >= 3`);
});

test.after(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
});

test('defaults: dark theme, 13px terminal, nothing saved yet', async () => {
  await app.click('.agent-card[data-agent="docs-pass"]');
  await app.waitFor(`document.querySelector('.term-slot[data-agent="docs-pass"] .xterm-rows')`);
  assert.equal(await app.evaluate('document.documentElement.dataset.theme'), 'dark');
  assert.equal(await rowFont('docs-pass'), '13px');
  assert.equal(await theme('docs-pass'), 'rgb(29, 27, 26)');
});

test('Ctrl+, opens Settings; Light changes the page and every terminal', async () => {
  await app.press(',', comma);
  await app.waitFor(`document.querySelector('[data-modal="settings"]')`);
  const text = await app.evaluate(`document.querySelector('[data-modal="settings"]').textContent`);
  for (const w of ['Appearance', 'Terminal', 'Notifications', 'About', 'Quit and stop all agents', 'Only when an agent needs me']) assert.match(text, new RegExp(w));
  await app.click('[data-name="theme"] [data-value="light"]');
  await app.waitFor(`document.documentElement.dataset.theme === 'light'`);
  await app.waitFor(`getComputedStyle(document.body).backgroundColor === 'rgb(236, 231, 226)'`);
  await until(async () => (await theme('docs-pass')) === 'rgb(250, 248, 246)');
  await until(() => (savedSettings() || {}).theme === 'light');
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
});

test('font size applies to the terminals and the preview', async () => {
  await app.press(',', comma);
  await app.waitFor(`document.querySelector('[data-modal="settings"]')`);
  await app.evaluate(`(() => { const r = document.getElementById('set-font-size'); r.value = '18'; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await app.waitFor(`document.getElementById('font-preview').style.fontSize === '18px'`);
  await until(async () => (await rowFont('docs-pass')) === '18px');
  await app.evaluate(`(() => { const f = document.getElementById('set-font-family'); f.value = 'Courier New, monospace'; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(() => (savedSettings() || {}).terminalFontFamily === 'Courier New, monospace');
  assert.equal((savedSettings() || {}).terminalFontSize, 18);
  await app.waitFor(`getComputedStyle(document.querySelector('.term-slot[data-agent="docs-pass"] .xterm-rows')).fontFamily.includes('Courier New')`);
  // a terminal opened later gets the same look
  await app.press('Escape');
  await app.click('.agent-card[data-agent="old-spike"]');
  await app.waitFor(`document.querySelector('.term-slot[data-agent="old-spike"] .xterm-rows')`);
  await until(async () => (await rowFont('old-spike')) === '18px');
  assert.equal(await theme('old-spike'), 'rgb(250, 248, 246)');
});

test('settings persist across an app restart', async () => {
  await app.close();
  app = await launchApp({ env: { CC_HOME: home }, size: '1280x800' });
  await app.waitFor(`document.documentElement.dataset.theme === 'light'`);
  await app.waitFor(`document.querySelector('.space[data-space="cc-dashboard"]')`);
  await app.click('.space[data-space="cc-dashboard"]');
  await app.waitFor(`document.querySelector('.agent-card[data-agent="docs-pass"]')`);
  await app.click('.agent-card[data-agent="docs-pass"]');
  await app.waitFor(`document.querySelector('.term-slot[data-agent="docs-pass"] .xterm-rows')`);
  await until(async () => (await rowFont('docs-pass')) === '18px');
  assert.equal(await theme('docs-pass'), 'rgb(250, 248, 246)');
  await app.press(',', comma);
  await app.waitFor(`document.querySelector('[data-modal="settings"]')`);
  assert.equal(await app.evaluate(`document.querySelector('[data-name="theme"] .seg.on').dataset.value`), 'light');
  assert.equal(await app.evaluate(`document.getElementById('set-font-size').value`), '18');
  // back to dark, and the notification choice
  await app.click('[data-name="theme"] [data-value="dark"]');
  await app.click('[data-name="notifications"] [data-value="needs_you"]');
  await until(() => { const s = savedSettings(); return s && s.theme === 'dark' && s.notifications === 'needs_you'; });
  await app.press('Escape');
});

test('F2 renames the focused agent and changes its role', async () => {
  await app.click('.agent-card[data-agent="docs-pass"]');
  await app.waitFor(`document.querySelector('.tab[data-agent="docs-pass"].active')`);
  await app.press('F2', { code: 'F2', keyCode: 113 });
  await app.waitFor(`document.querySelector('[data-modal="agent-edit"]')`);
  assert.equal(await app.evaluate(`document.getElementById('ae-name').value`), 'docs-pass');
  await app.evaluate(`(() => { const n = document.getElementById('ae-name'); n.value = 'docs-polish'; })()`);
  await app.click('.role-chip[data-role="reviewer"]');
  await app.click('#ae-save');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
  const call = mock.calls.filter((c) => c.method === 'agents.update').pop();
  assert.deepEqual(call.params, { id: 'docs-pass', name: 'docs-polish', role: { id: 'reviewer', label: 'Reviewer', emoji: '🔍' } });
  await app.waitFor(`document.querySelector('.tab[data-agent="docs-pass"] .tab-name').textContent === 'docs-polish'`);
  await app.waitFor(`document.querySelector('.agent-card[data-agent="docs-pass"] .role-badge').dataset.role === 'reviewer'`);
});

test('a custom role takes a label and an emoji', async () => {
  await app.press('F2', { code: 'F2', keyCode: 113 });
  await app.waitFor(`document.querySelector('[data-modal="agent-edit"]')`);
  await app.click('.role-chip[data-role="custom"]');
  await app.click('#ae-save');
  assert.match(await app.evaluate(`document.querySelector('.form-error').textContent`), /label/);
  await app.evaluate(`(() => { const l = document.getElementById('role-custom-label'); l.value = 'Release'; l.dispatchEvent(new Event('input', { bubbles: true })); const e = document.getElementById('role-custom-emoji'); e.value = '🚀'; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await app.click('#ae-save');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
  const call = mock.calls.filter((c) => c.method === 'agents.update').pop();
  assert.deepEqual(call.params.role, { id: 'custom', label: 'Release', emoji: '🚀' });
  await app.waitFor(`document.querySelector('.agent-card[data-agent="docs-pass"] .role-badge').textContent === '🚀Release'`);
});

test('Make Main through the dialog moves the crown', async () => {
  const mains = () => app.evaluate(`[...document.querySelectorAll('.agent-card')].filter((c) => c.querySelector('.role-badge').dataset.role === 'main').map((c) => c.dataset.agent)`);
  assert.deepEqual(await mains(), ['refactor-auth']);
  await app.press('F2', { code: 'F2', keyCode: 113 });
  await app.waitFor(`document.querySelector('[data-modal="agent-edit"]')`);
  await app.click('.role-chip[data-role="main"]');
  assert.match(await app.evaluate(`document.querySelector('.role-note').textContent`), /Moves 👑 Main from refactor-auth to this agent/);
  await app.click('#ae-save');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
  await until(async () => JSON.stringify(await mains()) === '["docs-pass"]');
  assert.equal(await app.evaluate(`document.querySelector('.agent-card[data-agent="refactor-auth"] .role-badge').dataset.role`), 'worker');
});

test('New agent: the role picker defaults to Worker here, and a chosen role is sent', async () => {
  await app.press('t', { ctrl: true });
  await app.waitFor(`document.querySelector('[data-modal="new-agent"]')`);
  assert.equal(await app.evaluate(`document.querySelector('.role-chip.on').dataset.role`), 'worker');
  assert.equal(await app.evaluate(`document.querySelectorAll('.new-agent-modal .role-chip').length`), 9);
  await app.evaluate(`document.getElementById('na-name').value = 'role-agent'`);
  await app.click('.new-agent-modal .role-chip[data-role="tests"]');
  await app.click('#na-create');
  await app.waitFor(`document.querySelector('.tab[data-agent="role-agent"].active')`);
  const create = mock.calls.filter((c) => c.method === 'agents.create').pop();
  assert.deepEqual(create.params.role, { id: 'tests', label: 'Tests', emoji: '🧪' });
  await app.waitFor(`document.querySelector('.agent-card[data-agent="role-agent"] .role-badge').dataset.role === 'tests'`);
});

test('New agent: picking Main says which agent it moves it from', async () => {
  await app.press('t', { ctrl: true });
  await app.waitFor(`document.querySelector('[data-modal="new-agent"]')`);
  await app.click('.new-agent-modal .role-chip[data-role="main"]');
  assert.match(await app.evaluate(`document.querySelector('.new-agent-modal .role-note').textContent`), /Moves 👑 Main from docs-polish/);
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
});

test('the ⋯ menu offers Settings and Quit; quitting asks first and calls core.shutdown', async () => {
  await app.click('#btn-menu');
  await app.waitFor(`document.getElementById('app-menu')`);
  assert.match(await app.evaluate(`document.getElementById('app-menu').textContent`), /Quit and stop all agents/);
  await app.click('#menu-quit-all');
  await app.waitFor(`document.querySelector('[data-modal="confirm"]')`);
  const q = await app.evaluate(`document.querySelector('[data-modal="confirm"] .modal-title').textContent`);
  assert.match(q, /^Stop \d+ running agents? and quit\?$/);
  // cancel: nothing happens
  await app.click('#confirm-cancel');
  await app.waitFor(`!document.querySelector('[data-modal]')`);
  assert.equal(mock.calls.some((c) => c.method === 'core.shutdown'), false);
  // via the Settings dialog this time
  await app.press(',', comma);
  await app.waitFor(`document.querySelector('[data-modal="settings"]')`);
  await app.click('#set-quit-all');
  await app.waitFor(`document.querySelector('[data-modal="confirm"]')`);
  await app.click('#confirm-ok');
  await until(() => mock.calls.some((c) => c.method === 'core.shutdown'), 10000);
  // the app quits itself afterwards (the mock core keeps the socket open, so this waits out the short grace)
  await until(() => app.proc.exitCode !== null, 15000);
});
