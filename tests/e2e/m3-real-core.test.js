// @ts-check
'use strict';
/**
 * M3 against the REAL core (the other M3 e2e files use the mock core): fake Claude with subagents, a live fake
 * outside session (tests/fake-claude-registry.js) and the Electron app on top. Temp CC_HOME and CLAUDE_CONFIG_DIR.
 * Linux CI: xvfb-run -a npm run test:e2e
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const h = require('./helpers');
const { launchApp } = require('../../packages/app/src/renderer/dev/cdp.js');
const { projectDirName } = require('../../packages/core/src/transcript.js');

const skip = h.missingPieces();
const REGISTRY = path.join(h.REPO, 'tests', 'fake-claude-registry.js');
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
  const core = await h.startCore({ ccHome, env: fullEnv, name: 'm3-real' });
  closers.push(() => core.stop());
  const rpc = await h.connectRpc(core.info);
  closers.push(() => rpc.close());
  await rpc.call('hello', { clientName: 'e2e-m3' });
  const space = await rpc.call('spaces.add', { path: folder, name: 'Real Space' });
  const app = await launchApp({ env: h.testEnv({ ccHome, env: fullEnv }), size: '1280x800' });
  closers.push(() => app.close());
  await app.waitFor(`document.querySelector('.space[data-space=${q(space.id)}]')`, 20000);
  return { ccHome, folder, core, rpc, space, app, closers, configDir: path.join(ccHome, 'claude-config') };
}

test('real core: subagents show in the tile strip, the sidebar badge and the drawer, live, then finish', { skip: skip || false, timeout: 120000 }, async (t) => {
  // background subagents stay up 4 s, long enough to look at them while they run
  const { rpc, space, app } = await setup(t, { CC_FAKE_SUBAGENT_MS: '4000' });
  await app.click(`.space[data-space=${q(space.id)}]`);
  await app.waitFor(`window.__cc.snapshot().view === 'grid'`);
  const agent = await rpc.call('agents.create', { spaceId: space.id, name: 'boss', prompt: 'please run subagents:2 bg' });
  const A = q(agent.id);
  const tile = `.tile[data-agent=${A}]`;

  await app.waitFor(`document.querySelectorAll('${tile} .sub-chip').length === 2`, 20000);
  const titles = await app.evaluate(`[...document.querySelectorAll('${tile} .sub-chip .sub-title')].map((n) => n.textContent).sort()`);
  assert.deepEqual(titles, ['Count files here', 'Find token call sites']);
  // the strip shows the tool a subagent is running right now
  await app.waitFor(`[...document.querySelectorAll('${tile} .sub-chip .sub-tool')].some((n) => /Bash/.test(n.textContent))`, 10000);
  await app.waitFor(`document.querySelector('.agent-card[data-agent=${A}] .sub-badge') && /2 running/.test(document.querySelector('.agent-card[data-agent=${A}] .sub-badge').textContent)`, 10000);
  assert.equal(await app.evaluate(`window.__cc.snapshot().view`), 'grid');

  // the drawer: both subagents with titles; each has its tool lines
  await app.click(`.agent-card[data-agent=${A}] .sub-badge`);
  await app.waitFor(`!document.getElementById('activity-drawer').hidden`);
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-item.sub').length === 2`, 10000);
  const items = await app.evaluate(`[...document.querySelectorAll('#activity-drawer .act-item.sub .act-item-title')].map((n) => n.textContent).sort()`);
  assert.deepEqual(items, ['Count files here', 'Find token call sites']);
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-line.k-tool').length >= 2`, 10000);
  assert.match(await app.evaluate(`document.querySelector('#activity-drawer .act-feed').textContent`), /ls/);

  // live: the later lines (Read, subagent end, task notification) arrive without reopening
  await app.waitFor(`document.querySelector('#activity-drawer .act-line.k-subagent_end')`, 20000);
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-line.k-subagent_end').length === 2`, 20000);
  assert.match(await app.evaluate(`document.querySelector('#activity-drawer .act-feed').textContent`), /Read/);
  // filter on one subagent: only its lines
  await app.click(`#activity-drawer .act-item.sub`);
  await app.waitFor(`document.querySelector('#activity-drawer .act-item.sub.on')`);
  await app.waitFor(`[...document.querySelectorAll('#activity-drawer .act-line')].every((l) => !l.querySelector('.act-who'))`);
  assert.ok(await app.evaluate(`document.querySelectorAll('#activity-drawer .act-line').length`) >= 2);

  // finished: the session goes idle and the chips collapse to "done"
  await rpc.waitForEvent('agent.status', (s) => s && s.agentId === agent.id && s.state === 'idle', 30000);
  const st = (await rpc.call('agents.list', {})).find((/** @type {any} */ r) => r.agent.id === agent.id).status;
  assert.equal(st.state, 'idle');
  assert.equal(st.subagents.running, 0);
  await app.waitFor(`document.querySelectorAll('${tile} .sub-chip').length === 0 && /2/.test((document.querySelector('${tile} .sub-pill.done') || {}).textContent || '')`, 10000);
  await app.waitFor(`!document.querySelector('.agent-card[data-agent=${A}] .sub-badge')`, 10000);
  await app.waitFor(`document.querySelectorAll('#activity-drawer .act-item.sub.st-done').length === 2`, 10000);
  const subs = await rpc.call('subagents.list', { agentId: agent.id });
  assert.deepEqual(subs.map((/** @type {any} */ s) => s.state), ['done', 'done']);
});

test('real core: an outside session shows as a view-only tile; Take over ends it and carries its log into a new agent', { skip: skip || false, timeout: 120000 }, async (t) => {
  const { ccHome, folder, rpc, space, app, closers, configDir } = await setup(t);
  const sessionId = 'aaaaaaaa-1111-4222-8333-444444444444';
  const ext = `ext:${sessionId}`;
  // its transcript, where Claude keeps it
  const dir = path.join(configDir, 'projects', projectDirName(folder));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), [
    { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'tidy the changelog' } },
    { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x1', name: 'Bash', input: { command: 'git log --oneline' } }] } },
    { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x1', content: 'abc fix', is_error: false }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const proc = spawn(process.execPath, [REGISTRY, '--session', sessionId, '--cwd', folder, '--name', 'Outside work', '--entrypoint', 'vscode', '--status', 'idle'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  closers.push(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } });
  const exited = new Promise((r) => proc.once('exit', r));
  await new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.stdout.on('data', (d) => { if (String(d).includes('READY')) resolve(undefined); });
    proc.once('exit', () => reject(new Error('fake outside session exited early')));
  });

  await app.click(`.space[data-space=${q(space.id)}]`);
  await app.waitFor(`window.__cc.snapshot().view === 'grid'`);
  const tile = `.ext-tile[data-ext=${q(ext)}]`;
  await app.waitFor(`document.querySelector('${tile}')`, 20000);
  assert.match(await app.evaluate(`document.querySelector('${tile}').textContent`), /Outside/);
  assert.match(await app.evaluate(`document.querySelector('${tile}').textContent`), /VS Code/);
  assert.match(await app.evaluate(`document.querySelector('${tile}').textContent`), /Outside work/);
  await app.waitFor(`/git log/.test(document.querySelector('${tile} .ext-feed').textContent)`, 10000);
  await app.waitFor(`document.querySelector('.ext-card[data-ext=${q(ext)}]')`, 10000);
  assert.equal(await app.evaluate(`document.querySelector('.ext-card[data-ext=${q(ext)}]').dataset.state`), 'idle');
  // its state follows the registry file
  proc.stdin.write('status busy\n');
  await app.waitFor(`document.querySelector('.ext-card[data-ext=${q(ext)}]').dataset.state === 'working'`, 10000);
  proc.stdin.write('status idle\n');
  await app.waitFor(`document.querySelector('.ext-card[data-ext=${q(ext)}]').dataset.state === 'idle'`, 10000);

  // Take over through the dialog
  await app.click(`${tile} .ext-takeover`);
  await app.waitFor(`document.querySelector('.eo-modal')`);
  assert.equal(await app.evaluate(`!!document.querySelector('.eo-warn')`), false);
  await app.click('#eo-confirm');
  await Promise.race([exited, h.sleep(15000).then(() => { throw new Error('the outside process did not exit'); })]);
  await app.waitFor(`!document.querySelector('.eo-modal') && window.__cc.snapshot().view === 'terminals'`, 20000);
  const rows = await rpc.call('agents.list', {});
  const mine = (rows.find((/** @type {any} */ r) => r.agent.sessionId === sessionId) || {}).agent;
  assert.ok(mine, 'a normal agent with the same conversation');
  assert.equal(mine.name, 'Outside work');
  assert.equal(mine.spaceId, space.id);
  // the sidebar is always rendered; the Grid (hidden now) drops the tile when it is shown again
  await app.waitFor(`!document.querySelector('.ext-card[data-ext=${q(ext)}]')`, 10000);
  assert.deepEqual(await rpc.call('external.list', {}), []);
  await app.waitFor(`document.querySelector('.tab[data-agent=${q(mine.id)}].active')`, 10000);

  // the drawer of the new agent still has what the outside session did
  await app.evaluate(`window.__cc.openActivity(${q(mine.id)})`);
  await app.waitFor(`!document.getElementById('activity-drawer').hidden`);
  await app.waitFor(`/git log/.test(document.querySelector('#activity-drawer .act-feed').textContent) && /tidy the changelog/.test(document.querySelector('#activity-drawer .act-feed').textContent)`, 10000);
  await app.press('G', { ctrl: true, shift: true, code: 'KeyG' });
  await app.waitFor(`window.__cc.snapshot().view === 'grid' && document.querySelector('.tile[data-agent=${q(mine.id)}]') && !document.querySelector('${tile}')`, 10000);
  void ccHome;
});
