#!/usr/bin/env node
// @ts-check
'use strict';
/**
 * The two M3 README pictures, with the real core, the real app and REAL Claude Code (Haiku):
 *   activity.png  a session whose two subagents run (one asks for permission), the grid strip and the
 *                 activity drawer
 *   outside.png   a Claude session started outside the app (in a terminal): its view-only tile and sidebar entry
 *                 (outside-dialog.png, the Take over dialog, is saved too but not used by the README)
 *
 *   Linux:   xvfb-run -a -s "-screen 0 3000x2000x24" node scripts/readme-screenshots-m3.js [outDir]
 *   Windows: node scripts/readme-screenshots-m3.js [outDir]
 *
 * Uses the demo projects of scripts/readme-screenshots.js (~/cc-demo or $CC_DEMO_DIR). Needs `claude` on PATH
 * and logged in. Not a test: tests never call the real Claude (see CLAUDE.md).
 */
const fs = require('fs');
const path = require('path');
const h = require('../tests/e2e/helpers');
const base = require('./readme-screenshots');

const OUT = path.resolve(process.argv[2] || path.join(h.REPO, 'docs', 'images'));
const PARENT_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CONFIG_DIR'];
const TRIAGE = "Use the Agent tool to start two general-purpose subagents at the same time. The first has description 'Read the forecast code': it reads index.js and sums it up in one line. The second has description 'Run the test suite': it runs `npm test` with the Bash tool and reports what failed. When both are back, reply with a two-line summary.";
const OUTSIDE = 'Suggest three sharper headlines for the h1 in index.html, one line each. Do not edit any file.';

/** Accept Claude's folder trust screen (the cursor starts on "No, exit"). @param {string} screen */
const onTrustScreen = (screen) => {
  const tail = screen.slice(-4000).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  return /trust/i.test(tail) && /Yes/.test(tail);
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  base.makeProjects();
  const ccHome = h.makeCcHome();
  const core = await h.startCore({ ccHome, name: 'readme-m3', env: base.REAL_CLAUDE_ENV });
  const rpc = await h.connectRpc(core.info);
  /** @type {any} */ let launched;
  /** @type {any} */ let term;
  /** @type {string[]} */ const ids = [];
  try {
    const weather = await rpc.call('spaces.add', { path: path.join(base.DEMO, 'weather-cli'), name: 'weather-cli' });
    const landing = await rpc.call('spaces.add', { path: path.join(base.DEMO, 'landing-page'), name: 'landing-page' });
    const triage = await rpc.call('agents.create', { spaceId: weather.id, name: 'triage', model: 'haiku', prompt: TRIAGE });
    const explain = await rpc.call('agents.create', { spaceId: weather.id, name: 'explain', model: 'haiku', prompt: 'In two short sentences, what does this project do? Do not change anything.' });
    ids.push(triage.id, explain.id);
    const trusted = new Set();
    const acceptTrust = async () => {
      for (const e of await rpc.call('agents.list', {})) {
        if (trusted.has(e.agent.id) || e.status.state !== 'needs_you' || e.status.permission) continue;
        const screen = (await rpc.call('agents.attach', { id: e.agent.id })).replay || '';
        await rpc.call('agents.detach', { id: e.agent.id }).catch(() => {});
        if (!onTrustScreen(screen)) continue;
        trusted.add(e.agent.id);
        await h.sleep(800);
        await rpc.call('agents.input', { id: e.agent.id, data: '\x1b[B' });
        await h.sleep(400);
        await rpc.call('agents.input', { id: e.agent.id, data: '\r' });
        console.log(`${e.agent.name}: accepted the folder trust screen`);
      }
    };
    // triage: one subagent done, the other asking to run npm test ("asked by"); explain: idle.
    await h.waitUntil(async () => {
      await acceptTrust();
      const rows = await rpc.call('agents.list', {});
      const t = rows.find((e) => e.agent.id === triage.id);
      const x = rows.find((e) => e.agent.id === explain.id);
      return t && x && t.status.state === 'needs_you' && t.status.permission && t.status.askedBy && x.status.state === 'idle';
    }, 'triage asking for permission from a subagent, explain idle', 180000,
    async () => JSON.stringify((await rpc.call('agents.list', {})).map((e) => [e.agent.name, e.status.state, e.status.askedBy || '', e.status.message || ''])));
    console.log('triage: a subagent asks for permission');

    // An outside session: real Claude in a terminal the app did not start.
    const pty = require(path.join(h.REPO, 'node_modules', 'node-pty'));
    /** @type {Record<string, string>} */
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PARENT_VARS.includes(k)) env[k] = v;
    const claude = process.platform === 'win32' ? 'claude.exe' : 'claude';
    // Its own session id: a `claude` started from inside another Claude session can inherit that session's id.
    term = pty.spawn(claude, ['--session-id', require('crypto').randomUUID(), '--model', 'haiku', OUTSIDE], { cwd: landing.path, cols: 120, rows: 40, env });
    let screen = '';
    let outsideTrusted = false;
    term.onData((/** @type {string} */ d) => { screen += d; });
    /** @type {any} */ let ext = null;
    await h.waitUntil(async () => {
      if (!outsideTrusted && onTrustScreen(screen)) {
        outsideTrusted = true;
        await h.sleep(800); term.write('\x1b[B'); await h.sleep(400); term.write('\r');
      }
      const list = await rpc.call('external.list', {});
      ext = list.find((/** @type {any} */ s) => s.spaceId === landing.id && s.state === 'idle' && s.lastPrompt) || null;
      return ext;
    }, 'the outside session to be listed idle', 120000);
    console.log(`outside: ${ext.id}`);

    const electron = h.loadElectronDriver();
    const args = [`--force-device-scale-factor=${base.SCALE}`];
    if (process.platform === 'linux') args.push('--no-sandbox');
    args.push(h.REPO);
    const app = await electron.launch({ args, cwd: h.REPO, env: h.testEnv({ ccHome, env: base.REAL_CLAUDE_ENV }) });
    launched = app;
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, size) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setContentSize(size.width, size.height);
      w.center();
    }, base.SIZE);
    await page.waitForSelector(`.agent-card[data-agent="${triage.id}"]`, { timeout: 30000 });
    await page.evaluate(base.FREEZE);
    // Other Claude sessions on this computer (not in the demo projects) stay folded away.
    const other = await page.$('.sb-other .ext-block-head[aria-expanded="true"]');
    if (other) await other.click();
    const shot = async (/** @type {string} */ name) => {
      await h.sleep(1500);
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    };

    // 1. activity.png: weather-cli in the grid, the drawer open on triage.
    await page.click(`[data-space="${weather.id}"]`);
    await page.keyboard.press('Control+Shift+G');
    await page.waitForSelector(`.tile[data-agent="${triage.id}"]`);
    await page.evaluate((id) => /** @type {any} */ (window).__cc.openActivity(id), triage.id);
    await page.waitForSelector('#activity-drawer:not([hidden])', { timeout: 15000 });
    await shot('activity');
    await page.keyboard.press('Escape');

    // 2. outside.png: landing-page with its outside session (tile + sidebar), view only, with Take over.
    await page.click(`[data-space="${landing.id}"]`);
    await page.waitForSelector(`.ext-tile[data-ext="${ext.id}"]`, { timeout: 15000 });
    await shot('outside');
    // The Take over dialog, for reference (not in the README).
    await page.click(`.ext-tile[data-ext="${ext.id}"] .ext-takeover`);
    await page.waitForSelector('.eo-modal', { timeout: 10000 });
    await shot('outside-dialog');
    await page.keyboard.press('Escape');
  } finally {
    for (const id of ids) await rpc.call('agents.stop', { id }).catch(() => {});
    try { if (term) term.kill(); } catch { /* gone */ }
    rpc.close();
    if (launched) await h.closeApp(launched);
    await core.stop();
    h.removeCcHome(ccHome);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
