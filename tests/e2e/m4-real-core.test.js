// @ts-check
'use strict';
/**
 * M4 against the REAL core (the other M4 e2e files use the mock core): fake Claude runs the registered status-line
 * relay and starts subagents with models; the Electron app is on top. Temp CC_HOME and CLAUDE_CONFIG_DIR, never the
 * real claude or ~/.claude. Linux CI: xvfb-run -a npm run test:e2e
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const { launchApp } = require('../../packages/app/src/renderer/dev/cdp.js');

const skip = h.missingPieces();
const q = (/** @type {string} */ s) => JSON.stringify(s);

/** Core + app + rpc on one temp home; cleaned up by t.after. */
async function setup(/** @type {import('node:test').TestContext} */ t, /** @type {Record<string,string>} */ env = {}) {
  const ccHome = h.makeCcHome();
  const folder = path.join(ccHome, 'space-folder');
  fs.mkdirSync(folder, { recursive: true });
  const fullEnv = { CC_EXTERNAL_POLL_MS: '200', ...env };
  /** @type {any[]} */ const closers = [];
  t.after(async () => {
    for (const c of closers.reverse()) { try { await c(); } catch { /* best effort */ } }
    h.removeCcHome(ccHome);
  });
  const core = await h.startCore({ ccHome, env: fullEnv, name: 'm4-real' });
  closers.push(() => core.stop());
  const rpc = await h.connectRpc(core.info);
  closers.push(() => rpc.close());
  await rpc.call('hello', { clientName: 'e2e-m4' });
  const space = await rpc.call('spaces.add', { path: folder, name: 'Real Space' });
  const app = await launchApp({ env: h.testEnv({ ccHome, env: fullEnv }), size: '1280x800' });
  closers.push(() => app.close());
  await app.waitFor(`document.querySelector('.space[data-space=${q(space.id)}]')`, 20000);
  return { ccHome, folder, core, rpc, space, app };
}

test('real core: a status line update moves the top-bar meter, the pane context gauge and the Usage view', { skip: skip || false, timeout: 120000 }, async (t) => {
  const { rpc, space, app } = await setup(t);
  // before any update with limits there is no meter
  assert.equal(await app.evaluate(`!!document.getElementById('usage-meter')`), false);

  const agent = await rpc.call('agents.create', { spaceId: space.id, name: 'meter-agent', prompt: 'statusline:42' });
  const A = q(agent.id);
  // the top-bar meter appears with the 5-hour and weekly numbers of the fixture (62% / 31%)
  await app.waitFor(`document.getElementById('usage-meter')`, 30000);
  assert.match(await app.evaluate(`document.getElementById('usage-meter').textContent`), /5h.*62%/);
  assert.match(await app.evaluate(`document.getElementById('usage-meter').title`), /meter-agent/, 'the tooltip names the agent that reported it');

  // the pane footer gauge: Claude's own number against the 1M window, and the bar agrees
  await app.click(`.agent-card[data-agent=${A}]`);
  await app.waitFor(`window.__cc.snapshot().view === 'terminals'`, 10000);
  await app.waitFor(`/\\/ 1M \\(42%\\)$/.test(((document.querySelector('.pane-foot .gauge-pct')) || {}).textContent || '')`, 20000);
  assert.equal(await app.evaluate(`document.querySelector('.pane-foot .gauge-fill').style.width`), '42%');

  // the Usage view lists the agent, live: a second update changes its row
  await app.press('u', { ctrl: true, shift: true });
  await app.waitFor(`window.__cc.snapshot().view === 'usage' && document.querySelector('.usage-block[data-block="agents"] tbody tr[data-key=${A}]')`, 15000);
  const row = (/** @type {string} */ sel) => app.evaluate(`document.querySelector('.usage-block[data-block="agents"] tr[data-key=${A}] ${sel}').textContent`);
  assert.equal(await app.evaluate(`document.querySelector('.usage-block[data-block="agents"] tr[data-key=${A}] .name').textContent`), 'meter-agent');
  const before = await row('.cost');
  await rpc.call('agents.send', { id: agent.id, text: 'statusline:80' });
  await app.waitFor(`document.querySelector('.usage-block[data-block="agents"] tr[data-key=${A}] .cost').textContent !== ${q(before)}`, 20000);
  const u = await rpc.call('usage.get', {});
  assert.ok(u.byAgent[agent.id].costUsd >= 0.02, JSON.stringify(u.byAgent[agent.id]));

  // back in Terminals the gauge moved with it, and the meter is still there
  await app.press('t', { ctrl: true, shift: true, code: 'KeyT' });
  await app.waitFor(`window.__cc.snapshot().view === 'terminals'`, 10000);
  await app.waitFor(`/\\/ 1M \\(80%\\)$/.test(((document.querySelector('.pane-foot .gauge-pct')) || {}).textContent || '')`, 20000);
  assert.equal(await app.evaluate(`document.querySelector('.pane-foot .gauge-fill').style.width`), '80%');
  assert.equal(await app.evaluate(`!!document.getElementById('usage-meter')`), true);
});

test('real core: subagent cards with title and model show in the sidebar, the grid and the pane bar; a click opens the drawer on that subagent', { skip: skip || false, timeout: 120000 }, async (t) => {
  // background subagents stay up long enough to click on them
  const { rpc, space, app } = await setup(t, { CC_FAKE_SUBAGENT_MS: '25000' });
  await app.click(`.space[data-space=${q(space.id)}]`);
  await app.waitFor(`window.__cc.snapshot().view === 'grid'`);
  const agent = await rpc.call('agents.create', { spaceId: space.id, name: 'boss', prompt: 'please run subagents:2 bg' });
  const A = q(agent.id);
  const TITLES = ['Count files here', 'Find token call sites'];
  const MODELS = [/Haiku 4\.5/, /Sonnet 4\.5/];

  /** Titles and models of the running cards under `scope`, in order. @param {string} scope */
  const cards = (scope) => app.evaluate(`[...document.querySelectorAll(${q(`${scope} .sub-card.st-running`)})].map((c) => ({ id: c.dataset.sub, title: c.querySelector('.sub-card-title').textContent, model: (c.querySelector('.sub-card-model') || {}).textContent || '' }))`);
  /** @param {string} scope */
  const check = async (scope) => {
    await app.waitFor(`document.querySelectorAll(${q(`${scope} .sub-card.st-running .sub-card-model`)}).length === 2`, 30000);
    const list = await cards(scope);
    const by = new Map(list.map((/** @type {any} */ c) => [c.title, c.model]));
    TITLES.forEach((title, i) => { assert.match(String(by.get(title)), MODELS[i], `${scope}: model of ${title}`); });
    return list;
  };

  // grid tile row (the view we are in)
  await check(`.tile[data-agent=${A}] .tile-subs`);
  // sidebar child cards
  const side = await check(`.sub-group[data-agent=${A}]`);
  assert.equal(side.length, 2);
  // Terminals pane bar
  await app.click(`.agent-card[data-agent=${A}]`);
  await app.waitFor(`window.__cc.snapshot().view === 'terminals'`, 10000);
  const pane = await check('.pane-sub');

  // a click opens the drawer filtered to that subagent
  const target = pane.find((/** @type {any} */ c) => c.title === 'Find token call sites');
  assert.ok(target);
  await app.click(`.pane-sub .sub-card[data-sub=${q(target.id)}]`);
  await app.waitFor(`!document.getElementById('activity-drawer').hidden`, 10000);
  await app.waitFor(`document.querySelector('#activity-drawer .act-item.sub.on .act-item-title')`, 10000);
  assert.equal(await app.evaluate(`document.querySelector('#activity-drawer .act-item.sub.on .act-item-title').textContent`), 'Find token call sites');
  assert.equal(await app.evaluate(`document.querySelectorAll('#activity-drawer .act-item.sub.on').length`), 1);

  // the same click from the sidebar picks the other subagent
  const other = side.find((/** @type {any} */ c) => c.title === 'Count files here');
  await app.click(`.sub-group[data-agent=${A}] .sub-card[data-sub=${q(other.id)}]`);
  await app.waitFor(`(document.querySelector('#activity-drawer .act-item.sub.on .act-item-title') || {}).textContent === 'Count files here'`, 10000);
});
