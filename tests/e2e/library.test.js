// @ts-check
'use strict';
/** End-to-end: the Library view in the real Electron app against the dev mock core. */
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
let trash = '';
const calls = (/** @type {string} */ method) => mock.calls.filter((c) => c.method === method);
const q = (/** @type {string} */ s) => JSON.stringify(s);
const tab = async (/** @type {string} */ t) => { await app.click(`.lib-tab[data-tab="${t}"]`); await app.waitFor(`document.querySelector('.lib-tab.on').dataset.tab === ${q(t)}`); };

test.before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-lib-'));
  trash = path.join(home, 'trash');
  mock = await startMockCore({ home, static: true });
  app = await launchApp({ env: { CC_HOME: home, CC_TRASH_DIR: trash }, size: '1400x900' });
  await app.waitFor(`document.querySelectorAll('.agent-card').length > 0`);
  await app.click('.view-switch button[data-view="library"]');
  await app.waitFor(`document.querySelectorAll('.plugin-card').length === 4`);
});

test.after(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
});

test('plugins: cards with badges, cost and counts; managed plugins can still be switched on and off', async () => {
  const text = await app.evaluate(`document.querySelector('.plugin-card[data-plugin="engineering@claude-plugins-official"]').textContent`);
  assert.match(text, /engineering/);
  assert.match(text, /Update available/);
  assert.match(text, /~873 tok/);
  assert.match(text, /4 skills/);
  assert.match(text, /2 MCP/);
  const managed = await app.evaluate(`(() => { const c = document.querySelector('.plugin-card[data-plugin="security-guidance@synced"]'); return { text: c.textContent, disabled: c.querySelector('.switch').disabled }; })()`);
  assert.match(managed.text, /Managed/);
  assert.equal(managed.disabled, false);
  assert.match(await app.evaluate(`document.querySelector('.plugin-card[data-plugin="figma@claude-plugins-official"]').textContent`), /Disabled/);
});

test('toggle a plugin: calls the core, flips the card, offers to restart running agents', async () => {
  const id = 'figma@claude-plugins-official';
  await app.click(`.plugin-card[data-plugin="${id}"] .switch`);
  await app.waitFor(`document.querySelector('.plugin-card[data-plugin="${id}"] .switch').getAttribute('aria-checked') === 'true'`);
  assert.deepEqual(calls('library.pluginAction').pop().params, { id, action: 'enable' });
  await app.waitFor(`!document.querySelector('.lib-bar').hidden`);
  assert.match(await app.evaluate(`document.querySelector('.lib-bar').textContent`), /running agents? (uses|use) the old plugins/);
  const before = calls('agents.restart').length;
  await app.click('.lib-bar [data-act="restart-stale"]');
  await app.waitFor(`document.querySelector('.lib-bar').hidden`);
  assert.ok(calls('agents.restart').length > before, 'agents were restarted');
  await app.click(`.plugin-card[data-plugin="${id}"] .switch`);
  await app.waitFor(`document.querySelector('.plugin-card[data-plugin="${id}"] .switch').getAttribute('aria-checked') === 'false'`);
});

test('detail panel lists the parts; homepage opens through the bridge', async () => {
  await app.click('.plugin-card[data-plugin="figma@claude-plugins-official"]');
  await app.waitFor(`!document.querySelector('.lib-detail').hidden`);
  const d = await app.evaluate(`document.querySelector('.lib-detail').textContent`);
  for (const w of ['figma-use', 'designer', 'MCP servers', 'Open homepage', 'Configure', 'Uninstall', 'Update']) assert.ok(d.includes(w), w);
});

test('configure: the form comes from the options and saves values', async () => {
  await app.click('.lib-detail [data-act="configure"]');
  await app.waitFor(`document.querySelector('[data-modal="lib-configure"]')`);
  await app.evaluate(`(() => { const i = document.querySelector('[data-modal="lib-configure"] input[data-key="token"]'); i.value = 'sekret'; })()`);
  await app.click('[data-modal="lib-configure"] [data-testid="ok"]');
  await app.waitFor(`!document.querySelector('[data-modal="lib-configure"]')`);
  const last = calls('library.configure').pop().params;
  assert.equal(last.id, 'figma@claude-plugins-official');
  assert.equal(last.values.token, 'sekret');
  assert.equal(last.values.region, 'eu');
});

test('uninstall asks first, with a keep-data choice', async () => {
  const id = 'codeburn@getagentseal';
  await app.click(`.plugin-card[data-plugin="${id}"]`);
  await app.waitFor(`document.querySelector('.lib-detail [data-act="uninstall"]')`);
  await app.click('.lib-detail [data-act="uninstall"]');
  await app.waitFor(`document.querySelector('[data-modal="lib-confirm"]')`);
  assert.equal(calls('library.pluginAction').filter((c) => c.params.action === 'uninstall').length, 0, 'nothing happens before the confirmation');
  await app.click('[data-modal="lib-confirm"] [data-testid="cancel"]');
  await app.waitFor(`!document.querySelector('[data-modal="lib-confirm"]')`);
  assert.equal(calls('library.pluginAction').filter((c) => c.params.action === 'uninstall').length, 0);
  await app.click('.lib-detail [data-act="uninstall"]');
  await app.waitFor(`document.querySelector('#lib-keep-data')`);
  await app.click('#lib-keep-data');
  await app.click('[data-modal="lib-confirm"] [data-testid="ok"]');
  await app.waitFor(`!document.querySelector('.plugin-card[data-plugin="${id}"]')`);
  assert.deepEqual(calls('library.pluginAction').pop().params, { id, action: 'uninstall', keepData: true });
});

test('browse: install shows the exact command first and passes its sha256 on confirm', async () => {
  await tab('browse');
  await app.waitFor(`document.querySelector('.plugin-card[data-available="cmd-plugin@getagentseal"]')`);
  await app.click('.plugin-card[data-available="cmd-plugin@getagentseal"] [data-act="install"]');
  await app.waitFor(`document.querySelector('[data-testid="confirm-command"]')`);
  assert.equal(await app.evaluate(`document.querySelector('[data-testid="confirm-command"]').textContent`), 'npx cmd-plugin-installer --yes');
  await app.click('[data-modal="lib-confirm"] [data-testid="ok"]');
  await app.waitFor(`document.querySelector('.plugin-card[data-available="cmd-plugin@getagentseal"]').textContent.includes('Installed')`);
  const last = calls('library.pluginAction').pop().params;
  assert.equal(last.action, 'install');
  assert.match(last.acceptCommand, /^[0-9a-f]{64}$/);
  await tab('plugins');
  await app.waitFor(`document.querySelector('.plugin-card[data-plugin="cmd-plugin@getagentseal"]')`);
});

test('skills: grouped, searchable, readable; Try it opens New agent with /name prefilled', async () => {
  await tab('skills');
  await app.waitFor(`document.querySelector('.skill-row[data-skill="user:session-start-hook"]')`);
  const groups = await app.evaluate(`[...document.querySelectorAll('.skill-group-title')].map((g) => g.firstChild.textContent)`);
  assert.deepEqual(groups.slice(0, 2), ['Yours', 'Project: cc-dashboard']);
  assert.ok(groups.includes('Plugin: engineering'));
  await app.click('.skill-row[data-skill="user:session-start-hook"]');
  await app.waitFor(`document.querySelector('[data-testid="skill-text"]') && /startup hooks/.test(document.querySelector('[data-testid="skill-text"]').textContent)`);
  await app.click('.lib-detail [data-act="try"]');
  await app.waitFor(`document.querySelector('[data-modal="new-agent"]')`);
  assert.equal(await app.evaluate(`document.querySelector('#na-prompt').value`), '/session-start-hook ');
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal="new-agent"]')`);
  // plugin skills are never editable or deletable
  await app.click('.skill-row[data-skill="plugin:engineering@claude-plugins-official:debug"]');
  await app.waitFor(`document.querySelector('.lib-detail .detail-title').textContent === '/debug'`);
  assert.equal(await app.evaluate(`!!document.querySelector('.lib-detail [data-act="delete"], .lib-detail [data-act="edit"]')`), false);
  await app.click('.lib-detail [data-act="try"]');
  await app.waitFor(`document.querySelector('[data-modal="new-agent"]')`);
  assert.equal(await app.evaluate(`document.querySelector('#na-prompt').value`), '/engineering:debug ');
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('[data-modal="new-agent"]')`);
});

test('skills: edit and save, create a new one', async () => {
  await app.click('.skill-row[data-skill="user:pdf-notes"]');
  await app.waitFor(`document.querySelector('.lib-detail [data-act="edit"]')`);
  await app.click('.lib-detail [data-act="edit"]');
  await app.waitFor(`document.querySelector('.lib-detail textarea.skill-editor')`);
  await app.evaluate(`(() => { const t = document.querySelector('.lib-detail textarea.skill-editor'); t.value += '\\nEXTRA LINE'; t.dispatchEvent(new Event('input')); })()`);
  await app.click('.lib-detail [data-act="save"]');
  await app.waitFor(`!document.querySelector('.lib-detail textarea.skill-editor')`);
  const w = calls('library.skillWrite').pop().params;
  assert.equal(w.id, 'user:pdf-notes');
  assert.match(w.content, /EXTRA LINE/);
  assert.match(fs.readFileSync(path.join(mock.home, 'mock-library', 'claude', 'skills', 'pdf-notes', 'SKILL.md'), 'utf8'), /EXTRA LINE/);

  await app.click('[data-act="new-skill"]');
  await app.waitFor(`document.querySelector('[data-modal="lib-new-skill"]')`);
  await app.evaluate(`document.querySelector('#ns-name').value = 'Bad Name'`);
  await app.click('[data-modal="lib-new-skill"] [data-testid="ok"]');
  assert.match(await app.evaluate(`document.querySelector('[data-modal="lib-new-skill"] .form-error').textContent`), /lowercase/);
  await app.evaluate(`document.querySelector('#ns-name').value = 'fresh-skill'`);
  await app.click('[data-modal="lib-new-skill"] [data-testid="ok"]');
  await app.waitFor(`document.querySelector('.skill-row[data-skill="user:fresh-skill"]') && document.querySelector('.lib-detail textarea.skill-editor')`);
  assert.deepEqual(calls('library.skillWrite').pop().params, { scope: 'user', name: 'fresh-skill', content: '' });
});

test('delete a skill: confirm, then the folder is trashed and the list refreshes', async () => {
  const dir = path.join(mock.home, 'mock-library', 'claude', 'skills', 'fresh-skill');
  assert.ok(fs.existsSync(dir));
  await app.click('.skill-row[data-skill="user:fresh-skill"]');
  await app.waitFor(`document.querySelector('.lib-detail [data-act="delete"]')`);
  await app.click('.lib-detail [data-act="delete"]');
  await app.waitFor(`document.querySelector('[data-modal="lib-confirm"]')`);
  assert.ok(fs.existsSync(dir), 'still there before the confirmation');
  await app.click('[data-modal="lib-confirm"] [data-testid="cancel"]');
  await app.waitFor(`!document.querySelector('[data-modal="lib-confirm"]')`);
  assert.ok(fs.existsSync(dir));
  await app.click('.lib-detail [data-act="delete"]');
  await app.waitFor(`document.querySelector('[data-modal="lib-confirm"]')`);
  const refreshes = calls('library.list').filter((c) => c.params && c.params.refresh).length;
  await app.click('[data-modal="lib-confirm"] [data-testid="ok"]');
  await app.waitFor(`!document.querySelector('.skill-row[data-skill="user:fresh-skill"]')`);
  assert.ok(!fs.existsSync(dir), 'folder moved away');
  assert.equal(fs.readdirSync(trash).filter((n) => n.startsWith('fresh-skill')).length, 1, 'it went to the trash');
  assert.ok(calls('library.list').filter((c) => c.params && c.params.refresh).length > refreshes, 'library.list { refresh: true } after the delete');
});

test('marketplaces: add, refresh, remove', async () => {
  await tab('marketplaces');
  await app.waitFor(`document.querySelectorAll('.market-row').length === 2`);
  await app.evaluate(`document.querySelector('#mk-source').value = 'acme/extra-market'`);
  await app.click('[data-act="add-market"]');
  await app.waitFor(`document.querySelector('.market-row[data-market="extra-market"]')`);
  assert.deepEqual(calls('library.marketplace').pop().params, { action: 'add', source: 'acme/extra-market' });
  await app.click('.market-row[data-market="extra-market"] [data-act="remove-market"]');
  await app.waitFor(`document.querySelector('[data-modal="lib-confirm"]')`);
  await app.click('[data-modal="lib-confirm"] [data-testid="ok"]');
  await app.waitFor(`!document.querySelector('.market-row[data-market="extra-market"]')`);
  await sleep(10);
});
