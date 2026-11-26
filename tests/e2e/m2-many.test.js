// @ts-check
'use strict';
/**
 * End-to-end: 20 agents in one space. The Grid keeps only a handful of live terminals, attaches do not
 * pile up, and the chrome does not re-render in a loop. Dev mock core (`many: 20`).
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
const live = () => app.evaluate('window.__cc.liveTerminals()');
const renders = () => app.evaluate('window.__cc.renders()');
/** attach calls minus detach calls: what the core still thinks this window shows */
const heldAttaches = () => {
  const held = new Map();
  for (const c of mock.calls) {
    if (c.method === 'agents.attach') held.set(c.params.id, (held.get(c.params.id) || 0) + 1);
    if (c.method === 'agents.detach') held.set(c.params.id, (held.get(c.params.id) || 0) - 1);
  }
  return [...held.entries()].filter(([, n]) => n > 0);
};

test.before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-many-'));
  mock = await startMockCore({ home, static: true, many: 20 });
  app = await launchApp({ env: { CC_HOME: home }, size: '1280x800' });
  await app.waitFor(`document.querySelectorAll('.agent-card').length > 0`, 20000);
});

test.after(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
});

test('scrolling a 20-tile grid keeps at most 8 live terminals and no leaked attach', async () => {
  await app.click('.space[data-space="big-project"]');
  await app.waitFor(`document.querySelectorAll('.tile').length === 20`);
  let max = 0;
  const tops = [0, 300, 600, 900, 1200, 1500, 100000, 700, 0];
  for (const top of tops) {
    await app.evaluate(`document.querySelector('.grid-scroll').scrollTop = ${top}`);
    await sleep(250);
    const n = (await live()).length;
    max = Math.max(max, n);
    const dom = await app.evaluate(`document.querySelectorAll('.tile[data-live="true"]').length`);
    assert.equal(dom, n, `live tiles in the page match live terminals at scrollTop ${top}`);
  }
  assert.ok(max >= 4 && max <= 8, `at most 8 live terminals while scrolling, saw ${max}`);
  await sleep(300);
  const held = heldAttaches();
  assert.equal(held.length, (await live()).length, `core holds ${held.length} attaches, app shows ${(await live()).length}`);
  assert.ok(held.length <= 8);
  assert.ok(held.every(([, n]) => n === 1), JSON.stringify(held));
  // every attach has a detach once the tile let go: total attaches stay proportional to scrolling, not to time
  const attaches = calls('agents.attach').length;
  await sleep(1500);
  assert.equal(calls('agents.attach').length, attaches, 'no attach activity while idle');
});

test('an idle app does not re-render in a loop', async () => {
  const a = await renders();
  await sleep(2000);
  const b = await renders();
  assert.ok(b - a <= 2, `renderChrome ran ${b - a} times in 2 s with nothing happening`);
});

test('a burst of status changes renders per frame, not per event', async () => {
  const a = await renders();
  for (let i = 0; i < 200; i++) mock.setStatus(`agent-${String((i % 20) + 1).padStart(2, '0')}`, { tool: 'Read', detail: `f${i}.js` });
  await sleep(500);
  const b = await renders();
  assert.ok(b - a <= 40, `renderChrome ran ${b - a} times for 200 events`);
});

test('leaving the grid lets go of every terminal', async () => {
  await app.click('.view-switch button[data-view="board"]');
  await app.waitFor(`window.__cc.snapshot().view === 'board'`);
  await until(async () => (await live()).length === 0);
  await until(() => heldAttaches().length === 0);
  assert.equal(await app.evaluate(`document.querySelectorAll('.term-slot').length`), 0);
});

test('after a core reconnect the live grid tiles are attached again, once each', async () => {
  await app.click('.view-switch button[data-view="grid"]');
  await app.waitFor(`document.querySelectorAll('.tile[data-live="true"]').length >= 4`);
  const before = (await live()).sort();
  mock.calls.length = 0; // count from here: a dropped socket forgets its attachments (the mock does it per socket)
  mock.dropClients();
  await app.waitFor(`window.__cc.snapshot().conn === 'open'`, 15000);
  await until(() => heldAttaches().length === before.length, 10000);
  assert.deepEqual(heldAttaches().map(([id]) => id).sort(), before);
  assert.ok(heldAttaches().every(([, n]) => n === 1), JSON.stringify(heldAttaches()));
  assert.deepEqual((await live()).sort(), before);
  // output still reaches a tile
  const id = before[0];
  mock.output(id, '\r\nafter-reconnect-marker\r\n');
  await until(async () => /after-reconnect-marker/.test(await app.evaluate(`window.__cc.termText(${JSON.stringify(id)}) || ''`)));
});
