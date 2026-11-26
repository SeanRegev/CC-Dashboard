// @ts-check
'use strict';
/**
 * End-to-end: the real Electron app against the dev mock core.
 * Linux CI: xvfb-run -a node --test "tests/e2e/**\/*.test.js"   (Windows/macOS: no xvfb needed)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMockCore } = require('../../packages/app/src/renderer/dev/mock-core.js');
const { launchApp, sleep } = require('../../packages/app/src/renderer/dev/cdp.js');
const { readCoreJson, isPidAlive, checkHealth } = require('../../packages/app/src/main/core-launcher.js');

const MOCK_ENTRY = path.join(__dirname, '..', '..', 'packages', 'app', 'src', 'renderer', 'dev', 'mock-core.js');

/** @type {Awaited<ReturnType<typeof startMockCore>>} */
let mock;
/** @type {Awaited<ReturnType<typeof launchApp>>} */
let app;
const until = async (/** @type {() => any} */ fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout'); };
const termText = (/** @type {string} */ id) => app.evaluate(`window.__cc.termText(${JSON.stringify(id)}) || ''`);
const focusTerm = (/** @type {string} */ id) => app.evaluate(`(() => { const t = document.querySelector('.term-slot[data-agent=${JSON.stringify(id)}] textarea'); if (!t) return false; t.focus(); return document.activeElement === t; })()`);

test.before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-'));
  mock = await startMockCore({ home, static: true });
  app = await launchApp({ env: { CC_HOME: home }, size: '1280x800' });
});

test.after(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
});

test('sidebar shows the spaces and agents, needs-you first', async () => {
  await app.waitFor(`document.querySelectorAll('[data-testid="sidebar"] .agent-card').length === 5`);
  const names = await app.evaluate(`[...document.querySelectorAll('.agent-card')].map((c) => c.dataset.agent)`);
  assert.equal(names[0], 'refactor-auth');
  assert.deepEqual([...names].sort(), ['api-client', 'docs-pass', 'fix-flaky-tests', 'old-spike', 'refactor-auth']);
  const first = await app.evaluate(`document.querySelector('.agent-card').textContent`);
  assert.match(first, /needs you/);
  const spaces = await app.evaluate(`[...document.querySelectorAll('.space')].map((s) => s.textContent)`);
  assert.equal(spaces.length, 3);
  assert.match(spaces[0], /cc-dashboard.*5/);
  const sidebar = await app.evaluate(`document.querySelector('[data-testid="sidebar"]').textContent`);
  assert.match(sidebar, /New agent/);
  assert.match(sidebar, /Add space/);
});

test('opening an agent attaches a terminal that shows the replay', async () => {
  await app.click('.agent-card[data-agent="docs-pass"]');
  await app.waitFor(`document.querySelector('.tab[data-agent="docs-pass"].active')`);
  await until(async () => /Update the README for the new CLI flags/.test(await termText('docs-pass')));
  assert.ok(mock.calls.some((c) => c.method === 'agents.attach' && c.params.id === 'docs-pass'));
  // fitted to the pane and reported to the core
  await until(() => mock.calls.some((c) => c.method === 'agents.resize' && c.params.id === 'docs-pass'));
  const size = await app.evaluate(`window.__cc.termSize('docs-pass')`);
  assert.ok(size.cols > 80 && size.rows > 20, JSON.stringify(size));
  // xterm paints the DOM rows on the next animation frame (and again after the resize), so wait for it
  const rendered = () => app.evaluate(`document.querySelector('.term-slot[data-agent="docs-pass"] .xterm-rows')?.textContent || ''`);
  await until(async () => /README/.test(await rendered())).catch(() => {});
  assert.match(await rendered(), /README/);
});

test('typing reaches the core, and Ctrl+C reaches the terminal', async () => {
  assert.equal(await focusTerm('docs-pass'), true);
  await app.insertText('hello');
  await app.press('Enter');
  await until(() => mock.inputs.join('').includes('hello\r'));
  await until(async () => /GOT: hello/.test(await termText('docs-pass')));
  await app.press('c', { ctrl: true });
  await until(() => mock.inputs.includes('\x03'));
});

test('status changes update the sidebar card and mark the tab', async () => {
  mock.setStatus('docs-pass', { state: 'needs_you', message: 'Pick a heading style' });
  await app.waitFor(`document.querySelector('.agent-card[data-agent="docs-pass"]').classList.contains('st-needs_you')`);
  await app.waitFor(`document.querySelector('.tab[data-agent="docs-pass"]').classList.contains('st-needs_you')`);
  const card = await app.evaluate(`document.querySelector('.agent-card[data-agent="docs-pass"]').textContent`);
  assert.match(card, /Pick a heading style/);
  mock.setStatus('docs-pass', { state: 'idle' });
  await app.waitFor(`document.querySelector('.agent-card[data-agent="docs-pass"]').classList.contains('st-idle')`);
});

test('Ctrl+T opens the new-agent dialog and creates an agent in a new tab', async () => {
  await focusTerm('docs-pass');
  await app.press('t', { ctrl: true });
  await app.waitFor(`document.querySelector('[data-modal="new-agent"]')`);
  assert.ok(!mock.inputs.some((d) => d === '\x14'), 'Ctrl+T must not reach the terminal');
  await app.evaluate(`(() => { const n = document.getElementById('na-name'); n.value = 'e2e-agent'; document.getElementById('na-prompt').value = 'say hi'; document.querySelector('[data-name="model"] [data-value="haiku"]').click(); })()`);
  await app.click('#na-create');
  await app.waitFor(`document.querySelector('.tab[data-agent="e2e-agent"].active')`);
  const create = mock.calls.find((c) => c.method === 'agents.create');
  assert.ok(create);
  assert.deepEqual(create.params, { spaceId: 'cc-dashboard', name: 'e2e-agent', prompt: 'say hi', model: 'haiku' });
  await until(async () => /say hi/.test(await termText('e2e-agent')));
  assert.equal(await app.evaluate(`!!document.querySelector('[data-modal]')`), false);
});

test('Ctrl+\\ splits into two panes, Ctrl+Tab and Ctrl+1 switch tabs', async () => {
  await app.press('\\', { ctrl: true });
  await app.waitFor(`document.querySelectorAll('.pane').length === 2`);
  let snap = await app.evaluate('window.__cc.snapshot()');
  assert.deepEqual(snap.layout.panes, ['e2e-agent', 'docs-pass']);
  await app.press('1', { ctrl: true });
  snap = await app.evaluate('window.__cc.snapshot()');
  assert.equal(snap.layout.panes[snap.layout.focused], 'docs-pass');
  await app.press('Tab', { ctrl: true });
  snap = await app.evaluate('window.__cc.snapshot()');
  assert.equal(snap.layout.panes[snap.layout.focused], 'e2e-agent');
  // both terminals are sized to their half
  const a = await app.evaluate(`window.__cc.termSize('docs-pass')`);
  assert.ok(a.cols > 30 && a.cols < 80, JSON.stringify(a));
  await app.press('\\', { ctrl: true });
  await app.waitFor(`document.querySelectorAll('.pane').length === 1`);
});

test('a dialog opened in the same frame as a tab switch keeps the keyboard', async () => {
  // Ctrl+<n> focuses the terminal on the next frame; Ctrl+K pressed before that frame must win,
  // or what the user types into the quick switcher goes to the agent.
  const snap = await app.evaluate('window.__cc.snapshot()');
  const cur = snap.layout.panes[snap.layout.focused];
  assert.equal(await focusTerm(cur), true);
  const n = snap.tabs.indexOf(cur) + 1;
  assert.ok(n > 0);
  await app.evaluate(`(() => {
    const key = (k, code) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, ctrlKey: true, bubbles: true, cancelable: true }));
    key('${n}', 'Digit${n}');
    key('k', 'KeyK');
  })()`);
  await app.waitFor(`document.querySelector('[data-modal="quick-switch"]')`);
  await app.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))');
  assert.equal(await app.evaluate('document.activeElement && document.activeElement.id'), 'qs-input');
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal="quick-switch"]')`);
});

test('Ctrl+K quick switcher opens an agent from another space', async () => {
  await app.press('k', { ctrl: true });
  await app.waitFor(`document.querySelector('[data-modal="quick-switch"]')`);
  await app.insertText('etl');
  await app.waitFor(`document.querySelector('.qs-item.sel') && document.querySelector('.qs-item.sel').dataset.agent === 'etl-retry'`);
  await app.press('Enter');
  await app.waitFor(`document.querySelector('.tab[data-agent="etl-retry"].active')`);
  const snap = await app.evaluate('window.__cc.snapshot()');
  assert.equal(snap.currentSpace, 'data-pipeline');
});

test('Ctrl+W closes the tab and detaches; the agent keeps running', async () => {
  await focusTerm('etl-retry');
  await app.press('w', { ctrl: true });
  await app.waitFor(`!document.querySelector('.tab[data-agent="etl-retry"]')`);
  await until(() => mock.calls.some((c) => c.method === 'agents.detach' && c.params.id === 'etl-retry'));
  assert.ok(!mock.calls.some((c) => c.method === 'agents.stop'));
  assert.equal(await app.evaluate(`!!document.querySelector('.agent-card[data-agent="etl-retry"]')`), true);
});

test('after the core connection drops, the app reconnects and re-attaches terminals', async () => {
  await app.click('.agent-card[data-agent="etl-retry"]');
  await until(async () => /retry policy/.test(await termText('etl-retry')));
  const attachesBefore = mock.calls.filter((c) => c.method === 'agents.attach' && c.params.id === 'etl-retry').length;
  mock.dropClients();
  await until(() => mock.calls.filter((c) => c.method === 'agents.attach' && c.params.id === 'etl-retry').length > attachesBefore);
  await app.waitFor(`window.__cc.snapshot().conn === 'open' && !document.querySelector('.conn-banner')`);
  // reattach clears the screen at once; xterm parses the replay asynchronously, so wait for it
  await until(async () => /retry policy/.test(await termText('etl-retry'))).catch(() => {});
  assert.match(await termText('etl-retry'), /retry policy/);
  // the replay was written once, not appended to the old screen
  const count = (await termText('etl-retry')).split('Add retries to the nightly ETL job').length - 1;
  assert.equal(count, 1);
});

test('the app starts a missing core detached, and closing the window leaves it running', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-spawn-'));
  const second = await launchApp({
    env: { CC_HOME: home, CC_CORE_NODE: process.execPath, CC_CORE_ENTRY: MOCK_ENTRY, MOCK_STATIC: '1' },
    size: '1100x700',
  });
  /** @type {number|undefined} */
  let pid;
  try {
    await second.waitFor(`document.querySelectorAll('.agent-card').length > 0`, 20000);
    const info = readCoreJson(home);
    assert.ok(info && info.pid);
    pid = info.pid;
    assert.notEqual(pid, second.proc.pid);
    await second.close();
    await sleep(300);
    assert.equal(isPidAlive(pid), true, 'core must outlive the window');
    assert.ok(await checkHealth(info));
  } finally {
    await second.close();
    if (pid) try { process.kill(pid); } catch { /* gone */ }
  }
});

test('role badges: 👑 Main on the space\'s first agent, other roles on the rest', async () => {
  await app.click('.space[data-space="cc-dashboard"]');
  // picking a space shows its agents as the Grid (M2); the sidebar cards stay where they are
  await app.waitFor(`window.__cc.snapshot().view === 'grid' && document.querySelectorAll('.tile').length >= 5`);
  await app.waitFor(`document.querySelector('.agent-card[data-agent="refactor-auth"] .role-badge')`);
  const roles = await app.evaluate(`Object.fromEntries([...document.querySelectorAll('.agent-card')].map((c) => [c.dataset.agent, c.querySelector('.role-badge').textContent]))`);
  assert.equal(roles['refactor-auth'], '👑Main');
  assert.equal(roles['fix-flaky-tests'], '🧪Tests');
  assert.equal(Object.values(roles).filter((r) => r.includes('Main')).length, 1, 'one Main per space');
});

test('views: the switcher and Ctrl+Shift+<letter> change the main area; opening an agent returns to Terminals', async () => {
  for (const [key, view] of [['L', 'library'], ['G', 'grid'], ['B', 'board'], ['A', 'inbox'], ['D', 'dashboards']]) {
    await app.press(key, { ctrl: true, shift: true, code: `Key${key}` });
    await app.waitFor(`window.__cc.snapshot().view === '${view}' && !document.getElementById('view-host').hidden && document.getElementById('workspace').hidden`);
    await app.waitFor(`!document.querySelector('.view-${view}').hidden && document.querySelector('.view-switch button.on').dataset.view === '${view}'`);
  }
  await app.click('.view-switch button[data-view="library"]');
  await app.waitFor(`window.__cc.snapshot().view === 'library'`);
  await app.click('.agent-card[data-agent="docs-pass"]');
  await app.waitFor(`window.__cc.snapshot().view === 'terminals' && !document.getElementById('workspace').hidden`);
  await app.waitFor(`document.querySelector('.tab[data-agent="docs-pass"].active')`);
});
