// @ts-check
'use strict';
// Smoke test: real core + real Electron app, fake Claude. Creates an agent through the core's RPC
// and expects the app's sidebar to show it. Skipped until both packages exist on the branch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

const skip = h.missingPieces();
if (skip) console.log(`# ${skip}`);

test('app window opens and shows an agent created through the core', { skip: skip || false, timeout: 120000 }, async (t) => {
  const ccHome = h.makeCcHome();
  const project = path.join(ccHome, 'project');
  fs.mkdirSync(project, { recursive: true });
  /** @type {any} */ let core;
  /** @type {any} */ let rpc;
  /** @type {any} */ let launched;
  t.after(async () => {
    if (rpc) rpc.close();
    if (launched) await h.closeApp(launched.app);
    if (core) await core.stop();
    h.removeCcHome(ccHome);
  });

  core = await h.startCore({ ccHome, name: 'smoke' });
  rpc = await h.connectRpc(core.info);
  const hello = await rpc.call('hello', { clientName: 'e2e-smoke' });
  assert.ok(hello && hello.protocol !== undefined, `hello returned ${JSON.stringify(hello)}`);
  const space = await rpc.call('spaces.add', { path: project, name: 'Smoke Space' });
  assert.ok(space && space.id, `spaces.add returned ${JSON.stringify(space)}`);

  launched = await h.launchApp({ ccHome });
  const { app, page } = launched;
  // Keep the renderer's console in the test log; it is the first thing to read when this fails.
  page.on('console', (m) => console.log(`# [renderer:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`# [renderer:pageerror] ${e.message}`));
  assert.ok(await page.title() !== undefined);
  const windows = await app.windows();
  assert.ok(windows.length >= 1, 'a window is open');

  try {
    await h.waitUntil(async () => (await h.sidebarText(page)).includes('Smoke Space'), 'the space in the sidebar', 20000,
      async () => `sidebar text: ${JSON.stringify(await h.sidebarText(page))}`);

    const agent = await rpc.call('agents.create', { spaceId: space.id, name: 'smoke-agent', prompt: 'hello from e2e' });
    assert.ok(agent && agent.id, `agents.create returned ${JSON.stringify(agent)}`);
    await rpc.waitForEvent('agent.created', (d) => d && d.agent && d.agent.id === agent.id);

    await h.waitUntil(async () => (await h.sidebarText(page)).includes('smoke-agent'), 'the agent in the sidebar', 20000,
      async () => `sidebar text: ${JSON.stringify(await h.sidebarText(page))}`);
    // fake-claude fired Stop after the prompt, so the agent should settle (not stay "starting").
    await rpc.waitForEvent('agent.status', (s) => s && s.agentId === agent.id && s.state === 'idle', 20000);
  } finally {
    const shot = await h.screenshot(page, 'smoke').catch(() => '');
    if (shot) console.log(`# screenshot: ${shot}`);
  }
});
