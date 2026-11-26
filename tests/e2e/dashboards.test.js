// @ts-check
'use strict';
/**
 * End-to-end: the Dashboards view against the dev mock core.
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
const q = (/** @type {string} */ s) => JSON.stringify(s);
const termText = () => app.evaluate(`(document.querySelector('.dash-term .xterm-rows') || {}).textContent || ''`);
const until = async (/** @type {() => any} */ fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout'); };

test.before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-dash-'));
  mock = await startMockCore({ home, static: true });
  app = await launchApp({ env: { CC_HOME: home }, size: '1280x800' });
  // The sidebar element is in the static HTML; wait for the switcher app.js renders instead.
  await app.waitFor(`document.querySelector('.view-switch button[data-view="dashboards"]')`);
  await app.evaluate(`document.querySelector('.view-switch button[data-view="dashboards"]').click()`);
  await app.waitFor(`document.querySelectorAll('.dash-card').length >= 5`);
});

test.after(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
});

test('cards show name, kind, source and availability', async () => {
  const cards = await app.evaluate(`[...document.querySelectorAll('.dash-card')].map((c) => ({ id: c.dataset.dash, text: c.textContent, open: c.querySelector('.dash-open').disabled }))`);
  const by = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.match(by['codeburn-terminal'].text, /CodeBurn.*Built in.*Terminal/);
  assert.match(by['codeburn-web'].text, /Web page/);
  assert.match(by['plugin:pager-duty@acme'].text, /pager-duty.*Plugin page/);
  assert.match(by['plugin:basemind@acme'].text, /asks first/);
  assert.match(by['mock-missing'].text, /not installed/);
  assert.equal(by['mock-missing'].open, true);
});

test('opening the CodeBurn terminal dashboard shows its output; input and Back work', async () => {
  await app.click('.dash-card[data-dash="codeburn-terminal"] .dash-open');
  await until(async () => /Total\s+\$42\.18/.test(await termText()));
  assert.ok(mock.calls.some((c) => c.method === 'dashboards.start' && c.params.id === 'codeburn-terminal'));
  assert.ok(mock.calls.some((c) => c.method === 'dashboards.attach' && c.params.id === 'codeburn-terminal'));
  await until(() => mock.calls.some((c) => c.method === 'dashboards.resize' && c.params.id === 'codeburn-terminal'));
  // keys go to dashboards.input
  await app.evaluate(`document.querySelector('.dash-term textarea').focus()`);
  await app.press('x');
  await until(() => mock.calls.some((c) => c.method === 'dashboards.input' && c.params.data === 'x'));
  assert.ok(!mock.calls.some((c) => c.method === 'agents.input' && c.params.id === 'codeburn-terminal'));
  // q quits: the panel offers Restart
  await app.press('q');
  await app.waitFor(`document.querySelector('[data-act="restart"]') && !document.querySelector('[data-act="restart"]').hidden`);
  assert.match(await app.evaluate(`document.querySelector('.dash-status').textContent`), /Exited/);
  await app.click('[data-act="restart"]');
  await until(async () => /Total\s+\$42\.18/.test(await termText()));
  await app.click('[data-act="stop"]');
  await app.waitFor(`!document.querySelector('[data-act="restart"]').hidden`);
  await app.click('[data-act="back"]');
  await app.waitFor(`document.querySelectorAll('.dash-card').length >= 5 && !document.querySelector('.dash-term')`);
  assert.ok(mock.calls.some((c) => c.method === 'dashboards.detach' && c.params.id === 'codeburn-terminal'));
});

test('a plugin command asks to be trusted, showing the exact command', async () => {
  await app.click('.dash-card[data-dash="plugin:basemind@acme"] .dash-open');
  await app.waitFor(`document.querySelector('[data-modal="dash-trust"]')`);
  assert.equal(await app.evaluate(`document.querySelector('[data-testid="trust-command"]').textContent`), 'basemind dash --live');
  // cancel: nothing was started or trusted
  await app.click('[data-modal="dash-trust"] [data-act="cancel"]');
  await app.waitFor(`!document.querySelector('[data-modal="dash-trust"]')`);
  assert.ok(!mock.calls.some((c) => c.method === 'dashboards.trust'));
  assert.ok(!mock.calls.some((c) => c.method === 'dashboards.start' && c.params.id === 'plugin:basemind@acme'));
  // trust: then it starts and opens
  await app.click('.dash-card[data-dash="plugin:basemind@acme"] .dash-open');
  await app.waitFor(`document.querySelector('[data-modal="dash-trust"]')`);
  await app.click('[data-modal="dash-trust"] [data-act="trust"]');
  await until(() => mock.calls.some((c) => c.method === 'dashboards.trust' && c.params.id === 'plugin:basemind@acme'));
  await app.waitFor(`document.querySelector('.dash-term')`);
  await until(() => mock.calls.some((c) => c.method === 'dashboards.start' && c.params.id === 'plugin:basemind@acme'));
  await app.click('[data-act="stop"]');
  await app.click('[data-act="back"]');
  await app.waitFor(`document.querySelector('.dash-card[data-dash="plugin:basemind@acme"]') && !document.querySelector('.dash-card[data-dash="plugin:basemind@acme"] .dash-badge.need')`);
});

test('add your own, then remove it', async () => {
  await app.click('#dash-add');
  await app.waitFor(`document.querySelector('[data-modal="dash-add"]')`);
  // empty form is refused in the dialog
  await app.click('#dash-save');
  assert.match(await app.evaluate(`document.querySelector('.dash-add-modal .form-error').textContent`), /name/i);
  await app.evaluate(`(() => { const n = document.getElementById('dash-name'); n.value = 'Grafana'; })()`);
  await app.click('.dash-add-modal [data-value="url"]');
  await app.evaluate(`document.getElementById('dash-value').value = 'https://grafana.example.com'`);
  await app.click('#dash-save');
  await app.waitFor(`!document.querySelector('[data-modal="dash-add"]')`);
  await app.waitFor(`document.querySelector('.dash-card[data-source="user"]')`);
  const text = await app.evaluate(`document.querySelector('.dash-card[data-source="user"]').textContent`);
  assert.match(text, /Grafana.*Yours.*Web address/);
  const add = mock.calls.find((c) => c.method === 'dashboards.add');
  assert.deepEqual([add.params.name, add.params.kind, add.params.url], ['Grafana', 'url', 'https://grafana.example.com']);
  await app.click('.dash-card[data-source="user"] .dash-remove');
  await app.waitFor(`!document.querySelector('.dash-card[data-source="user"]')`);
});
