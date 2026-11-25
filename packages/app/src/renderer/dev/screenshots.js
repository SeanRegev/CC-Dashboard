#!/usr/bin/env node
// @ts-check
'use strict';
/**
 * Capture UI screenshots against the mock core.
 *   Linux:   xvfb-run -a -s "-screen 0 1920x1080x24" node packages/app/src/renderer/dev/screenshots.js [outDir]
 *   Windows: node packages/app/src/renderer/dev/screenshots.js [outDir]
 * Default outDir: docs/screenshots
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMockCore } = require('./mock-core.js');
const { launchApp, sleep, APP_DIR } = require('./cdp.js');

const OUT = path.resolve(process.argv[2] || path.join(APP_DIR, 'docs', 'screenshots'));

/** Freeze animations so status dots are captured at full colour. */
const FREEZE = `(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.append(s); })()`;

/** @param {string} size @param {(app: Awaited<ReturnType<typeof launchApp>>, shot: (name:string) => Promise<string>) => Promise<void>} script @param {{empty?: boolean}} [o] */
async function session(size, script, o = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-shots-'));
  const mock = await startMockCore({ home, static: true, empty: o.empty });
  const app = await launchApp({ env: { CC_HOME: home }, size });
  try {
    await app.waitFor(o.empty ? `window.__cc.snapshot().conn === 'open'` : `document.querySelectorAll('.agent-card').length > 0`);
    await app.evaluate(FREEZE);
    await sleep(300);
    await script(app, async (name) => {
      await sleep(350);
      const file = path.join(OUT, `${size}-${name}.png`);
      await app.screenshot(file);
      console.log(file);
      return file;
    });
  } finally {
    await app.close();
    await mock.close();
  }
}

/** @param {Awaited<ReturnType<typeof launchApp>>} app @param {string} id */
const open = (app, id) => app.click(`.agent-card[data-agent="${id}"]`);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const size of ['1280x800', '1920x1080']) {
    await session(size, async (app, shot) => {
      await shot('empty');
      await open(app, 'refactor-auth');
      await shot('needs-you');
      await open(app, 'fix-flaky-tests');
      await app.press('\\', { ctrl: true });
      await open(app, 'docs-pass');
      await app.press('1', { ctrl: true });
      await shot('split');
      await app.press('t', { ctrl: true });
      await app.evaluate(`document.getElementById('na-prompt').value = 'Add request logging to the API server and cover it with tests.'`);
      await app.click('[data-name="model"] [data-value="sonnet"]');
      await shot('new-agent');
      await app.press('Escape');
      await app.press('k', { ctrl: true });
      await app.insertText('re');
      await shot('quick-switcher');
      await app.press('Escape');
    });
  }
  await session('1280x800', async (_app, shot) => { await shot('welcome'); }, { empty: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
