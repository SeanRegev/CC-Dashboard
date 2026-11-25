// @ts-check
'use strict';
// Guards the release pipeline: CI workflow, electron-builder config and icons. The important one
// for other engineers: every package the core requires at run time must be unpacked from app.asar,
// because the installed core runs from resources/app.asar.unpacked as a separate process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const yaml = require('js-yaml');

const REPO = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const builder = /** @type {any} */ (yaml.load(read('electron-builder.yml')));
const ci = /** @type {any} */ (yaml.load(read('.github/workflows/ci.yml')));

/** JS files under a repo folder (missing folder = none). */
function jsFiles(rel) {
  const dir = path.join(REPO, rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: false })
    .map(String).filter((f) => f.endsWith('.js') && !f.split(path.sep).includes('node_modules'))
    .map((f) => path.join(dir, f));
}

/** Bare package names required by the given files (no builtins, no relative paths). */
function requiredPackages(files) {
  const out = new Set();
  const builtins = new Set(builtinModules);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const id = m[1];
      if (id.startsWith('.') || id.startsWith('node:') || path.isAbsolute(id)) continue;
      const name = id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0];
      if (builtins.has(name)) continue;
      out.add(name);
    }
  }
  return [...out];
}

test('CI workflow: Windows and Linux jobs with pinned actions and the installer artifact', () => {
  assert.ok(ci.on && 'push' in ci.on && 'pull_request' in ci.on, 'runs on push and pull_request');
  const win = ci.jobs['test-windows'];
  const linux = ci.jobs['test-linux'];
  assert.equal(win['runs-on'], 'windows-2022', 'pinned: node-gyp 9.4.1 cannot find Visual Studio 2026 on windows-latest');
  assert.equal(linux['runs-on'], 'ubuntu-latest');
  const uses = [...win.steps, ...linux.steps].filter((s) => s.uses).map((s) => s.uses);
  for (const u of uses) assert.match(u, /@v\d+$/, `${u} is pinned to a major version`);
  assert.ok(uses.includes('actions/checkout@v4') && uses.includes('actions/setup-node@v4') && uses.includes('actions/upload-artifact@v4'));
  const runs = (job) => job.steps.map((s) => s.run || '').join('\n');
  assert.match(runs(win), /npm ci/);
  assert.match(runs(win), /npm test/);
  assert.match(runs(win), /electron-builder install-app-deps/);
  assert.match(runs(win), /electron-builder --win nsis portable --publish never/);
  assert.match(runs(linux), /xvfb-run -a npm run test:e2e/);
  const upload = win.steps.find((s) => s.uses === 'actions/upload-artifact@v4' && s.with.name === 'CC-Dashboard-windows');
  assert.ok(upload, 'uploads the CC-Dashboard-windows artifact');
  assert.equal(upload.with.path, 'dist/*.exe');
  assert.equal(upload.with['if-no-files-found'], 'error');
});

test('electron-builder config: ids, targets, installer options', () => {
  assert.equal(builder.appId, 'dev.ccdashboard.app');
  assert.equal(builder.productName, 'CC-Dashboard');
  assert.equal(builder.npmRebuild, true);
  for (const f of ['package.json', 'packages/**', 'node_modules/**']) assert.ok(builder.files.includes(f), `files has ${f}`);
  assert.deepEqual(builder.win.target, ['nsis', 'portable']);
  assert.equal(builder.nsis.oneClick, false);
  assert.equal(builder.nsis.allowToChangeInstallationDirectory, true);
  assert.ok(builder.nsis.createDesktopShortcut);
  assert.equal(builder.nsis.createStartMenuShortcut, true);
  assert.match(builder.nsis.artifactName, /\$\{version\}/);
  assert.match(builder.portable.artifactName, /\$\{version\}/);
  assert.equal(pkg.main, 'packages/app/src/main/main.js', 'package.json main is the Electron entry');
});

test('the core, the contract and node-pty are unpacked from app.asar', () => {
  for (const p of ['packages/core/**', 'packages/shared/**', 'node_modules/node-pty/**']) {
    assert.ok(builder.asarUnpack.includes(p), `asarUnpack has ${p}`);
  }
});

test('every package the core and shared code require is a dependency and is unpacked', () => {
  const needed = requiredPackages([...jsFiles('packages/core'), ...jsFiles('packages/shared')]);
  for (const name of needed) {
    assert.ok(pkg.dependencies && pkg.dependencies[name],
      `packages/core requires "${name}" but it is not in package.json "dependencies" (devDependencies are not packaged)`);
    assert.ok(builder.asarUnpack.includes(`node_modules/${name}/**`),
      `packages/core requires "${name}": add "node_modules/${name}/**" (and its runtime deps) to asarUnpack in electron-builder.yml`);
  }
});

test('icons: 1024px PNG and a multi-size ICO with 16 and 256 px entries', () => {
  const png = fs.readFileSync(path.join(REPO, 'build', 'icon.png'));
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(png.readUInt32BE(16), 1024, 'width');
  assert.equal(png.readUInt32BE(20), 1024, 'height');

  const ico = fs.readFileSync(path.join(REPO, 'build', 'icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, 'type = icon');
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    sizes.push(ico[o] || 256);
    const len = ico.readUInt32LE(o + 8);
    const off = ico.readUInt32LE(o + 12);
    assert.ok(off + len <= ico.length, `entry ${i} lies inside the file`);
  }
  for (const s of [16, 32, 48, 256]) assert.ok(sizes.includes(s), `ico has ${s}px (has ${sizes.join(', ')})`);
});
