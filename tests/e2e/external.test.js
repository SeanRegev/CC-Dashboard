// @ts-check
'use strict';
/**
 * End-to-end: outside sessions (view only) in Grid, sidebar, Board and Inbox, and the take-over flow,
 * against the dev mock core (three outside sessions, see mock-activity.js). Linux: xvfb-run -a npm run test:e2e
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
const VSC = 'ext:5f0c8a10-1111-4c1e-9a0b-00000000vsc0';
const CLI = 'ext:6a1d9b21-2222-4d2f-8b1c-00000000cli0';
const NOTE = 'ext:7b2eac32-3333-4e30-9c2d-00000000note';
const q = (/** @type {string} */ id) => `[data-ext="${id}"]`;
const key = (/** @type {string} */ k) => (k === 'B' ? { code: 'KeyB' } : { code: `Key${k}` });

test.before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-ext-'));
  mock = await startMockCore({ home, static: true });
  app = await launchApp({ env: { CC_HOME: home }, size: '1280x800' });
  await app.waitFor(`document.querySelectorAll('.agent-card').length > 0`, 15000);
});

test.after(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
});

test('Grid: outside sessions are view-only tiles after the space\'s agents', async () => {
  await app.click('.space[data-space="cc-dashboard"]');
  await app.waitFor(`window.__cc.snapshot().view === 'grid' && document.querySelectorAll('.ext-tile').length === 2`);
  const order = await app.evaluate(`[...document.querySelectorAll('.grid-tiles > .tile')].map((t) => t.dataset.agent || t.dataset.ext)`);
  const agents = await app.evaluate(`window.__cc.snapshot().agents.filter((id) => document.querySelector('.tile[data-agent="' + id + '"]'))`);
  assert.equal(order.length, agents.length + 2);
  assert.deepEqual(order.slice(-2), [VSC, CLI], 'working one first, both after every agent tile');
  const t = await app.evaluate(`(() => { const t = document.querySelector('.ext-tile[data-ext="${VSC}"]'); return {
    badge: t.querySelector('.ext-badge').textContent, name: t.querySelector('.tile-name').textContent, where: t.querySelector('.tile-activity').textContent,
    now: t.querySelector('.ext-now').textContent, lines: t.querySelectorAll('.ext-line').length, foot: t.querySelector('.ext-subs').textContent,
    buttons: [...t.querySelectorAll('button')].map((b) => b.textContent), term: !!t.querySelector('.term-slot, .xterm'), approval: !!t.querySelector('.approval'),
    note: t.querySelector('.ext-note').textContent, state: t.dataset.state }; })()`);
  assert.match(t.badge, /👁\s*Outside/);
  assert.equal(t.name, 'review PR comments');
  assert.equal(t.where, 'VS Code');
  assert.equal(t.now, 'Read src/core/server.js');
  assert.ok(t.lines >= 3 && t.lines <= 6, `feed lines: ${t.lines}`);
  assert.match(t.foot, /1 subagent running/);
  assert.deepEqual(t.buttons, ['Activity', 'Take over']);
  assert.equal(t.term, false, 'no terminal for an outside session');
  assert.equal(t.approval, false, 'no Allow / Deny');
  assert.match(t.note, /View only/);
  assert.equal(await app.evaluate(`document.querySelector('.ext-tile[data-ext="${CLI}"] .tile-activity').textContent`), 'Terminal');
  assert.match(await app.evaluate(`document.querySelector('.grid-count').textContent`), /2 outside/);
});

test('Grid: outside tiles count for the 4-visible / scroll rules', async () => {
  const n = await app.evaluate(`document.querySelectorAll('.grid-tiles > .tile').length`);
  const geo = await app.evaluate(`(() => { const s = document.querySelector('.grid-scroll').getBoundingClientRect(); const t = document.querySelector('.ext-tile[data-ext="${CLI}"]').getBoundingClientRect(); const first = document.querySelector('.grid-tiles > .tile').getBoundingClientRect();
    return { sh: s.height, th: t.height, ft: first.height }; })()`);
  assert.ok(Math.abs(geo.th - geo.ft) < 1, 'same height as an agent tile');
  assert.ok(Math.abs(geo.th * 2 + 8 - geo.sh) < 3, 'two rows fill the area');
  assert.ok(n >= 2);
});

test('Grid: the Activity button asks the app to open that session\'s activity', async () => {
  assert.equal(await app.evaluate(`window.__cc.activityFor()`), null);
  await app.click(`.ext-tile${q(VSC)} .ext-activity`);
  await app.waitFor(`window.__cc.activityFor() && window.__cc.activityFor().agentId === ${JSON.stringify(VSC)}`);
});

test('Grid: live activity lines arrive on the tile', async () => {
  mock.activity.push(VSC, { kind: 'tool', tool: 'Grep', detail: 'takeOver' });
  mock.broadcast('activity', { agentId: VSC, entries: [mock.activity.logs.get(VSC).slice(-1)[0]] });
  await app.waitFor(`document.querySelector('.ext-tile${q(VSC)} .ext-feed').textContent.includes('Grep takeOver')`);
});

test('sidebar: "Outside the app (N)" under the space, collapsible and remembered; "Other folders" with Add as space', async () => {
  await app.waitFor(`document.querySelector('.ext-block[data-block="cc-dashboard"] .ext-block-title')`);
  assert.equal(await app.evaluate(`document.querySelector('.ext-block[data-block="cc-dashboard"] .ext-block-title').textContent`), 'Outside the app (2)');
  const cards = await app.evaluate(`[...document.querySelectorAll('.ext-block[data-block="cc-dashboard"] .ext-card')].map((c) => ({ id: c.dataset.ext, badge: c.querySelector('.ext-badge').textContent, where: c.querySelector('.ext-where').textContent, approval: !!c.querySelector('.approval') }))`);
  assert.deepEqual(cards.map((c) => c.id), [VSC, CLI]);
  assert.deepEqual(cards.map((c) => c.where), ['VS Code', 'Terminal']);
  assert.ok(cards.every((c) => /Outside/.test(c.badge) && !c.approval));
  // collapse and keep it across renders
  await app.click('.ext-block[data-block="cc-dashboard"] .ext-block-head');
  await app.waitFor(`!document.querySelector('.ext-block[data-block="cc-dashboard"] .ext-card')`);
  await app.evaluate(`window.dispatchEvent(new Event('resize'))`);
  assert.equal(await app.evaluate(`document.querySelectorAll('.ext-block[data-block="cc-dashboard"] .ext-card').length`), 0);
  assert.match(await app.evaluate(`document.querySelector('.ext-block[data-block="cc-dashboard"] .ext-block-title').textContent`), /\(2\)/);
  await app.click('.ext-block[data-block="cc-dashboard"] .ext-block-head');
  await app.waitFor(`document.querySelectorAll('.ext-block[data-block="cc-dashboard"] .ext-card').length === 2`);
  // other folders
  assert.equal(await app.evaluate(`document.querySelector('.sb-other .ext-block-title').textContent`), 'Other folders (1)');
  assert.match(await app.evaluate(`document.querySelector('.sb-other .ext-card .ext-path').textContent`), /notes$/);
  // card click opens the activity of that session
  await app.click(`.ext-card${q(CLI)} .ext-activity`);
  await app.waitFor(`window.__cc.activityFor().agentId === ${JSON.stringify(CLI)}`);
});

test('Board: outside sessions are cards in their state\'s column, with only Activity / Take over', async () => {
  await app.press('B', { ctrl: true, shift: true, code: 'KeyB' });
  await app.waitFor(`window.__cc.snapshot().view === 'board'`);
  const by = await app.evaluate(`Object.fromEntries([...document.querySelectorAll('.board-col')].map((c) => [c.dataset.col, [...c.querySelectorAll('.ext-board-card')].map((x) => x.dataset.ext).sort()]))`);
  assert.deepEqual(by.working, [VSC]);
  assert.deepEqual(by.done.sort(), [CLI, NOTE].sort());
  assert.deepEqual(by.needs, []);
  const c = await app.evaluate(`(() => { const c = document.querySelector('.ext-board-card[data-ext="${VSC}"]'); return { badge: c.querySelector('.ext-badge').textContent, buttons: [...c.querySelectorAll('button')].map((b) => b.textContent), approval: !!c.querySelector('.approval') }; })()`);
  assert.match(c.badge, /Outside/);
  assert.deepEqual(c.buttons, ['Activity', 'Take over']);
  assert.equal(c.approval, false);
  // the counters include them
  assert.equal(await app.evaluate(`document.querySelector('.col-working .bch-count').textContent`), String(1 + (await app.evaluate(`document.querySelectorAll('.col-working .board-card').length`))));
  await app.click('#board-space');
  await app.waitFor(`!document.querySelector('.ext-board-card[data-ext="${NOTE}"]')`);
  await app.click('#board-all');
  await app.waitFor(`document.querySelector('.ext-board-card[data-ext="${NOTE}"]')`);
});

test('Inbox: an outside session that waits shows "waiting in VS Code" with Take over, no Allow / Deny', async () => {
  const x = mock.activity.external().find((/** @type {any} */ s) => s.id === CLI);
  x.state = 'needs_you'; x.entrypoint = 'vscode'; x.updatedAt = Date.now() - 90e3;
  mock.broadcast('external.changed', { sessions: mock.activity.external().map((/** @type {any} */ s) => ({ ...s })) });
  await app.press('A', { ctrl: true, shift: true, code: 'KeyA' });
  await app.waitFor(`window.__cc.snapshot().view === 'inbox' && document.querySelector('.ext-inbox-row')`);
  const row = await app.evaluate(`(() => { const r = document.querySelector('.ext-inbox-row'); return { text: r.textContent, buttons: [...r.querySelectorAll('button')].map((b) => b.textContent), allow: !!r.querySelector('.appr-btn') }; })()`);
  assert.match(row.text, /waiting in VS Code/);
  assert.deepEqual(row.buttons, ['Activity', 'Take over']);
  assert.equal(row.allow, false);
  x.state = 'idle'; x.entrypoint = 'cli';
  mock.broadcast('external.changed', { sessions: mock.activity.external().map((/** @type {any} */ s) => ({ ...s })) });
  await app.waitFor(`!document.querySelector('.ext-inbox-row')`);
});

test('take over, idle: confirm dialog, then the same conversation opens as an agent', async () => {
  await app.click('.space[data-space="cc-dashboard"]');
  await app.waitFor(`window.__cc.snapshot().view === 'grid' && document.querySelector('.ext-tile${q(CLI)}')`);
  await app.click(`.ext-tile${q(CLI)} .ext-takeover`);
  await app.waitFor(`document.querySelector('.eo-modal')`);
  const d = await app.evaluate(`({ lead: document.querySelector('.eo-lead').textContent, warn: !!document.querySelector('.eo-warn'), btn: document.querySelector('#eo-confirm').textContent, title: document.querySelector('#eo-title').textContent })`);
  assert.match(d.lead, /ends the session in the terminal and reopens the same conversation here, with its terminal/);
  assert.equal(d.warn, false);
  assert.equal(d.btn, 'Take over');
  assert.equal(d.title, 'Take over “quick question”');
  // Esc cancels
  await app.press('Escape');
  await app.waitFor(`!document.querySelector('.eo-modal')`);
  assert.ok(mock.activity.external().some((/** @type {any} */ s) => s.id === CLI), 'cancel leaves it alone');
  await app.click(`.ext-tile${q(CLI)} .ext-takeover`);
  await app.waitFor(`document.querySelector('#eo-confirm')`);
  await app.click('#eo-confirm');
  await app.waitFor(`!document.querySelector('.eo-modal') && window.__cc.snapshot().view === 'terminals' && window.__cc.snapshot().tabs.includes('quick-question')`);
  assert.ok(!mock.activity.external().some((/** @type {any} */ s) => s.id === CLI));
  await app.waitFor(`document.querySelectorAll('.ext-card${q(CLI)}').length === 0`);
  assert.match(await app.evaluate(`document.querySelector('.toasts').textContent`), /Took over/);
  const calls = (await (await fetch(`http://127.0.0.1:${mock.port}/mock/log?token=${mock.token}`)).json()).calls.filter((/** @type {any} */ c) => c.method === 'external.takeOver');
  assert.deepEqual(calls.map((/** @type {any} */ c) => ({ id: c.params.id, force: c.params.force })), [{ id: CLI, force: undefined }]);
});

test('take over, working: warning, "End it and take over" sends force', async () => {
  await app.click('.space[data-space="cc-dashboard"]');
  await app.press('G', { ctrl: true, shift: true, code: 'KeyG' });
  await app.waitFor(`window.__cc.snapshot().view === 'grid' && document.querySelector('.ext-tile${q(VSC)}')`);
  await app.click(`.ext-tile${q(VSC)} .ext-takeover`);
  await app.waitFor(`document.querySelector('.eo-warn')`);
  const d = await app.evaluate(`({ warn: document.querySelector('.eo-warn').textContent, btn: document.querySelector('#eo-confirm').textContent, lead: document.querySelector('.eo-lead').textContent })`);
  assert.match(d.warn, /working right now/);
  assert.match(d.lead, /VS Code/);
  assert.equal(d.btn, 'End it and take over');
  await app.click('#eo-confirm');
  await app.waitFor(`!document.querySelector('.eo-modal') && window.__cc.snapshot().tabs.includes('review-pr-comments')`);
  const log = (await (await fetch(`http://127.0.0.1:${mock.port}/mock/log?token=${mock.token}`)).json()).calls.filter((/** @type {any} */ c) => c.method === 'external.takeOver');
  assert.equal(log[log.length - 1].params.force, true);
});

test('take over: still_working from the core turns the dialog into the force path', async () => {
  // the app thinks it is idle (the registry changed after the last event): the core refuses, the dialog warns
  const x = mock.activity.external().find((/** @type {any} */ s) => s.id === NOTE);
  x.state = 'working';
  await app.waitFor(`document.querySelector('.sb-other .ext-takeover')`);
  await app.click('.sb-other .ext-takeover');
  await app.waitFor(`document.querySelector('#eo-confirm')`);
  assert.equal(await app.evaluate(`document.querySelector('#eo-confirm').textContent`), 'Take over');
  assert.match(await app.evaluate(`document.querySelector('.eo-facts').textContent`), /New: notes/);
  await app.click('#eo-confirm');
  await app.waitFor(`document.querySelector('.eo-warn') && document.querySelector('#eo-confirm').textContent === 'End it and take over'`);
  assert.ok(mock.activity.external().some((/** @type {any} */ s) => s.id === NOTE), 'nothing was ended yet');
  await app.click('#eo-confirm');
  await app.waitFor(`!document.querySelector('.eo-modal') && window.__cc.snapshot().tabs.includes('notes')`);
  // its folder was no space: the core made one
  assert.ok(await app.evaluate(`!!document.querySelector('.space[data-space="notes"]')`));
});

test('Add as space moves an outside session from "Other folders" into the new space; Windows paths display fine', async () => {
  const base = { pid: 1, state: 'idle', entrypoint: 'cli', startedAt: Date.now(), updatedAt: Date.now(), subagents: { running: 0, total: 0 } };
  const win = { ...base, id: 'ext:win', sessionId: 'win', cwd: 'C:\\Users\\someone\\Documents\\projects\\clients\\side-project', name: 'win' };
  const px = { ...base, id: 'ext:aaaa', sessionId: 'aaaa', cwd: '/home/me/code/side-project', name: 'side' };
  mock.broadcast('external.changed', { sessions: [...mock.activity.external().map((/** @type {any} */ s) => ({ ...s })), win, px] });
  await app.waitFor(`document.querySelector('.sb-other .ext-card[data-ext="ext:win"] .ext-path')`);
  const w = await app.evaluate(`(() => { const e = document.querySelector('.sb-other .ext-card[data-ext="ext:win"] .ext-path'); return { shown: e.textContent, title: e.title }; })()`);
  assert.equal(w.title, win.cwd);
  assert.match(w.shown, /^C:\\…\\clients\\side-project$/);
  mock.broadcast('external.changed', { sessions: [...mock.activity.external().map((/** @type {any} */ s) => ({ ...s })), px] });
  await app.waitFor(`document.querySelector('.sb-other .ext-card[data-ext="ext:aaaa"]') && !document.querySelector('.ext-card[data-ext="ext:win"]')`);
  await app.click('.sb-other .ext-card[data-ext="ext:aaaa"] .ext-add-space');
  await app.waitFor(`document.querySelector('.space[data-space="side-project"]') && !document.querySelector('.sb-other')`);
  const calls = (await (await fetch(`http://127.0.0.1:${mock.port}/mock/log?token=${mock.token}`)).json()).calls.filter((/** @type {any} */ c) => c.method === 'spaces.add');
  assert.equal(calls[calls.length - 1].params.path, '/home/me/code/side-project');
  await app.click('.space[data-space="side-project"]');
  await app.waitFor(`document.querySelector('.ext-tile[data-ext="ext:aaaa"]')`);
  await sleep(50);
});
