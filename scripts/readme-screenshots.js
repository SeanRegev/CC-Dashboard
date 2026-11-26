#!/usr/bin/env node
// @ts-check
'use strict';
/**
 * Real screenshots for the README: the real core, the real app and REAL Claude Code sessions
 * (Haiku, a few cents of usage) on two small demo projects it creates under ~/cc-demo
 * (or $CC_DEMO_DIR).
 *
 *   Linux:   xvfb-run -a -s "-screen 0 3000x2000x24" node scripts/readme-screenshots.js [outDir]
 *   Windows: node scripts/readme-screenshots.js [outDir]
 *
 * Needs `claude` on PATH and logged in. Default outDir: docs/images. Not a test: tests never call
 * the real Claude (see CLAUDE.md); this is a docs tool you run by hand when the UI changes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('../tests/e2e/helpers');

const OUT = path.resolve(process.argv[2] || path.join(h.REPO, 'docs', 'images'));
const DEMO = process.env.CC_DEMO_DIR || path.join(os.homedir(), 'cc-demo');
const MARKER = '.cc-demo';
const SIZE = { width: 1440, height: 900 };
const SCALE = 2;
/** The real `claude` on PATH, with the user's own Claude config (login), not the tests' temp one. */
const REAL_CLAUDE_ENV = { CC_CLAUDE: '', CLAUDE_CONFIG_DIR: undefined };

/** Two small, believable projects. A failing test gives Claude something to ask permission for. */
const PROJECTS = {
  'weather-cli': {
    'package.json': JSON.stringify({ name: 'weather-cli', version: '0.3.0', bin: { weather: 'index.js' }, scripts: { test: 'node --test' } }, null, 2) + '\n',
    'README.md': '# weather-cli\n\nPrints the weather for a city: `weather Lisbon`.\n',
    'index.js': "#!/usr/bin/env node\nconst { formatReport } = require('./src/format');\n\nconst city = process.argv[2] || 'London';\nconst reading = { city, tempC: 18.4, wind: 12, sky: 'partly cloudy' };\nconsole.log(formatReport(reading));\n",
    'src/format.js': "/** One line per reading, e.g. \"Lisbon: 18°C, partly cloudy, wind 12 km/h\". */\nfunction formatReport(r) {\n  return `${r.city}: ${Math.floor(r.tempC)}°C, ${r.sky}, wind ${r.wind} km/h`;\n}\n\nmodule.exports = { formatReport };\n",
    'test/format.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst { formatReport } = require('../src/format');\n\ntest('rounds the temperature to the nearest degree', () => {\n  assert.equal(formatReport({ city: 'Oslo', tempC: 3.6, sky: 'snow', wind: 20 }), 'Oslo: 4°C, snow, wind 20 km/h');\n});\n",
  },
  'landing-page': {
    'index.html': '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Tidy — inbox zero, daily</title></head>\n<body>\n  <h1>The email app</h1>\n  <p>Tidy sorts your inbox every morning so you only see what matters.</p>\n  <a href="/signup">Start free</a>\n</body>\n</html>\n',
  },
};

const AGENTS = [
  { space: 'weather-cli', name: 'explain', prompt: 'In two short sentences, what does this project do? Do not change anything.', want: 'idle' },
  { space: 'weather-cli', name: 'fix-tests', prompt: 'Run the tests with npm test and fix the one that fails.', want: 'needs_you' },
  { space: 'weather-cli', name: 'units-flag', prompt: 'Add a --units flag (metric or imperial) to index.js. Keep the change small.', want: 'needs_you' },
  { space: 'landing-page', name: 'headline', prompt: 'Suggest three sharper headlines for the h1 in index.html, one line each. Do not edit any file.', want: 'idle' },
];

/** Freeze animations so status dots are captured at full colour. */
const FREEZE = `(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.append(s); })()`;

function makeProjects() {
  if (fs.existsSync(DEMO) && !fs.existsSync(path.join(DEMO, MARKER))) {
    throw new Error(`${DEMO} exists and was not made by this script; move it away first`);
  }
  fs.rmSync(DEMO, { recursive: true, force: true });
  for (const [name, files] of Object.entries(PROJECTS)) {
    for (const [rel, text] of Object.entries(files)) {
      const file = path.join(DEMO, name, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  }
  fs.writeFileSync(path.join(DEMO, MARKER), 'made by scripts/readme-screenshots.js\n');
}

/**
 * The rest of the README pictures, from the same run: the project grid, the role dialog (F2), the
 * Inbox, the Board, the Library's Plugins tab, Dashboards and Settings in the light theme.
 * `d` drives the window: click(selector), press(key, mods), waitFor(JS expression), sleep(ms).
 * `shot(name)` saves <name>.png. Used by main() (Playwright) and by the mock-core check (CDP).
 * @param {{click:(sel:string)=>Promise<any>, press:(key:string, mods?:{ctrl?:boolean, shift?:boolean, code?:string})=>Promise<any>, waitFor:(expr:string)=>Promise<any>, sleep:(ms:number)=>Promise<any>}} d
 * @param {(name:string)=>Promise<any>} shot
 * @param {{space:string, roleAgent:string}} o space: the weather-cli space id; roleAgent: the agent F2 renames
 */
async function captureViews(d, shot, o) {
  const open = (/** @type {string} */ name) => d.click(`.view-switch button[data-view="${name}"]`);
  // A view that is not ready (say, plugins still listing) is shot as it is, with a warning.
  const ready = (/** @type {string} */ expr) => d.waitFor(expr).catch(() => console.warn(`not ready yet: ${expr}`));

  // The project grid: the weather-cli agents as live terminals, Main first.
  await d.click(`button[data-space="${o.space}"]`);
  await open('grid');
  await ready(`document.querySelectorAll('.view-grid .tile[data-live="true"]').length >= 1`);
  await shot('grid');

  // Session roles: F2 on the focused agent opens "Rename / change role".
  await open('terminals');
  await d.click(`.agent-card[data-agent="${o.roleAgent}"]`);
  await d.sleep(800);
  await d.press('F2', { code: 'F2' });
  await ready(`!!document.querySelector('[data-modal="agent-edit"]')`);
  await shot('roles');
  await d.press('Escape');

  // The Inbox: every permission prompt, answered without opening the terminal.
  await open('inbox');
  await ready(`document.querySelectorAll('.view-inbox [data-agent]').length >= 2`);
  await shot('inbox');

  await open('board');
  await ready(`document.querySelectorAll('.view-board .board-card').length >= 3`);
  await shot('board');

  // The Library: the plugins installed on this machine.
  await open('library');
  await d.click('.lib-tab[data-tab="plugins"]');
  await ready(`document.querySelectorAll('.view-library [data-plugin]').length > 0`);
  await shot('library');

  await open('dashboards');
  await ready(`!!document.querySelector('.view-dashboards [data-dash]')`);
  await shot('dashboards');

  // Settings, with the light theme chosen (it applies at once).
  await d.press(',', { ctrl: true, code: 'Comma' });
  await ready(`!!document.querySelector('[data-modal="settings"]')`);
  await d.click('[data-name="theme"] [data-value="light"]');
  await shot('settings-light');
  await d.press('Escape');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  makeProjects();
  const ccHome = h.makeCcHome();
  // CC_CLAUDE='' means: the real `claude` on PATH.
  const core = await h.startCore({ ccHome, name: 'readme', env: REAL_CLAUDE_ENV });
  const rpc = await h.connectRpc(core.info);
  /** @type {any} */ let launched;
  const ids = /** @type {Record<string, string>} */ ({});
  try {
    const spaces = /** @type {Record<string, any>} */ ({});
    for (const name of Object.keys(PROJECTS)) spaces[name] = await rpc.call('spaces.add', { path: path.join(DEMO, name), name });
    for (const a of AGENTS) {
      const agent = await rpc.call('agents.create', { spaceId: spaces[a.space].id, name: a.name, model: 'haiku', prompt: a.prompt });
      ids[a.name] = agent.id;
    }
    // New folders open on Claude's "Do you trust this folder?" screen; the core reports that as
    // needing you. Accept it as you would the first time: the cursor starts on "No, exit", so
    // move down to "Yes, I trust this folder" and confirm.
    const trusted = new Set();
    const acceptTrust = async () => {
      for (const e of await rpc.call('agents.list', {})) {
        if (trusted.has(e.agent.id) || e.status.state !== 'needs_you' || e.status.permission) continue;
        const screen = (await rpc.call('agents.attach', { id: e.agent.id })).replay || '';
        await rpc.call('agents.detach', { id: e.agent.id }).catch(() => {});
        if (!/trust/i.test(screen.slice(-4000))) continue;
        trusted.add(e.agent.id);
        await rpc.call('agents.input', { id: e.agent.id, data: '\x1b[B' });
        await h.sleep(400);
        await rpc.call('agents.input', { id: e.agent.id, data: '\r' });
        console.log(`${e.agent.name}: accepted the folder trust screen`);
      }
    };
    // Wait until every agent is where the pictures need it (done, or asking for permission).
    for (const a of AGENTS) {
      await h.waitUntil(async () => {
        await acceptTrust();
        const row = (await rpc.call('agents.list', {})).find((e) => e.agent.id === ids[a.name]);
        return row && row.status.state === a.want && (a.want !== 'needs_you' || row.status.permission);
      }, `${a.name} to be ${a.want}`, 120000, async () => JSON.stringify((await rpc.call('agents.list', {})).map((e) => [e.agent.name, e.status.state, e.status.message || ''])));
      console.log(`${a.name}: ${a.want}`);
    }

    const electron = h.loadElectronDriver();
    const args = [`--force-device-scale-factor=${SCALE}`];
    if (process.platform === 'linux') args.push('--no-sandbox');
    args.push(h.REPO);
    const app = await electron.launch({ args, cwd: h.REPO, env: h.testEnv({ ccHome, env: REAL_CLAUDE_ENV }) });
    const page = await app.firstWindow();
    launched = app;
    await app.evaluate(({ BrowserWindow }, size) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setContentSize(size.width, size.height);
      w.center();
    }, SIZE);
    await page.waitForSelector(`.agent-card[data-agent="${ids['fix-tests']}"]`, { timeout: 30000 });
    await page.evaluate(FREEZE);
    const shot = async (/** @type {string} */ name) => {
      await h.sleep(1200);
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    };

    // 1. The main window: the space's agents, one asking for permission, its live terminal.
    await page.click(`.agent-card[data-agent="${ids['fix-tests']}"]`);
    await h.sleep(2500);
    await shot('main-window');

    // 2. Two agents side by side.
    await page.keyboard.press('Control+Backslash');
    await h.sleep(600);
    await page.click(`.agent-card[data-agent="${ids.explain}"]`);
    await h.sleep(2000);
    await shot('split-view');

    // 3. Ctrl+K: jump to any agent in any space.
    await page.keyboard.press('Control+k');
    await page.waitForSelector('[data-modal="quick-switch"]');
    await shot('quick-switcher');
    await page.keyboard.press('Escape');

    // 4. Ctrl+T: a new agent.
    await page.keyboard.press('Control+t');
    await page.waitForSelector('[data-modal="new-agent"]');
    await page.fill('#na-name', 'write-docs');
    await page.fill('#na-prompt', 'Write a short usage section for README.md with two examples.');
    await shot('new-agent');
    await page.keyboard.press('Escape');

    // 5. Another space: an agent that has finished, with its answer.
    await page.keyboard.press('Control+Backslash'); // back to one pane
    await h.sleep(400);
    const landing = (await rpc.call('spaces.list', {})).find((s) => s.name === 'landing-page');
    await page.click(`button[data-space="${landing.id}"]`);
    await h.sleep(600);
    await page.click(`.agent-card[data-agent="${ids.headline}"]`);
    await h.sleep(2500);
    await shot('finished-agent');

    // 6-12. The other pictures, in the same run.
    await captureViews({
      click: (sel) => page.click(sel),
      press: (key, mods = {}) => page.keyboard.press([mods.ctrl && 'Control', mods.shift && 'Shift', key].filter(Boolean).join('+')),
      waitFor: (expr) => page.waitForFunction(expr, null, { timeout: 15000 }),
      sleep: h.sleep,
    }, shot, { space: spaces['weather-cli'].id, roleAgent: ids['fix-tests'] });
  } finally {
    for (const id of Object.values(ids)) await rpc.call('agents.stop', { id }).catch(() => {});
    rpc.close();
    if (launched) await h.closeApp(launched);
    await core.stop();
    h.removeCcHome(ccHome);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { captureViews, makeProjects, PROJECTS, DEMO, FREEZE, SIZE, SCALE, REAL_CLAUDE_ENV };
