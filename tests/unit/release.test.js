// @ts-check
'use strict';
// The release tooling: version bumps, tag checks and release notes (scripts/release.js), and the
// Release workflow that publishes the installer when a tag is pushed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const { checkTag, nextVersion, releaseNotes } = require('../../scripts/release.js');

const REPO = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

test('nextVersion: patch, minor, major, exact, and pre-releases', () => {
  assert.equal(nextVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(nextVersion('0.1.9', 'minor'), '0.2.0');
  assert.equal(nextVersion('1.4.2', 'major'), '2.0.0');
  assert.equal(nextVersion('0.1.0', '0.3.0-beta.1'), '0.3.0-beta.1');
  assert.equal(nextVersion('0.3.0-beta.1', 'patch'), '0.3.0', 'patch on a pre-release releases it');
  assert.throws(() => nextVersion('0.1.0', 'bigger'), /unknown bump/);
  assert.throws(() => nextVersion('0.1.0', 'v1.0.0'), /unknown bump/);
});

test('checkTag: strict vX.Y.Z that matches package.json, nothing else', () => {
  assert.equal(checkTag('v1.2.3', '1.2.3'), '');
  assert.equal(checkTag('v1.2.3-rc.1', '1.2.3-rc.1'), '');
  assert.match(checkTag('v1.2.4', '1.2.3'), /does not match/);
  for (const bad of ['1.2.3', 'v1.2', 'v1.2.3;rm -rf /', 'v1.2.3 x', '', 'vX.Y.Z']) {
    assert.match(checkTag(bad, '1.2.3'), /not a release tag/, bad);
  }
});

test('release.js --check-tag is what the workflow runs: exit 0 for this version, 1 otherwise', () => {
  const script = path.join(REPO, 'scripts', 'release.js');
  assert.match(execFileSync(process.execPath, [script, '--check-tag', `v${pkg.version}`], { encoding: 'utf8' }), /matches/);
  assert.throws(() => execFileSync(process.execPath, [script, '--check-tag', 'v999.0.0'], { stdio: 'pipe' }));
});

test('release notes link both installers of this version and say how to get past SmartScreen', () => {
  const notes = releaseNotes('1.2.3', 'me/app');
  assert.match(notes, /releases\/download\/v1\.2\.3\/CC-Dashboard-Setup-1\.2\.3\.exe/);
  assert.match(notes, /releases\/download\/v1\.2\.3\/CC-Dashboard-Portable-1\.2\.3\.exe/);
  assert.match(notes, /More info → Run anyway/);
  // The file names match what electron-builder produces.
  const builder = /** @type {any} */ (yaml.load(fs.readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf8')));
  assert.equal(builder.nsis.artifactName, '${productName}-Setup-${version}.${ext}');
  assert.equal(builder.portable.artifactName, '${productName}-Portable-${version}.${ext}');
  assert.equal(pkg.productName, 'CC-Dashboard');
});

test('Release workflow: tag push only, tests and package check before publishing, safe tag handling', () => {
  const wf = /** @type {any} */ (yaml.load(fs.readFileSync(path.join(REPO, '.github', 'workflows', 'release.yml'), 'utf8')));
  assert.deepEqual(wf.on, { push: { tags: ['v*'] }, workflow_dispatch: null }, 'a pushed v* tag, or run by hand');
  assert.deepEqual(wf.permissions, { contents: 'write' });
  const job = wf.jobs['release-windows'];
  assert.equal(job['runs-on'], 'windows-2022');
  const steps = job.steps;
  for (const s of steps.filter((x) => x.uses)) assert.match(s.uses, /@v\d+$/, `${s.uses} is pinned to a major version`);
  const order = (re) => steps.findIndex((s) => re.test(s.run || ''));
  const publish = order(/gh release create/);
  assert.ok(publish > 0, 'publishes with gh release create');
  for (const re of [/release\.js --check-tag/, /npm ci/, /npm test/, /npm run test:e2e/, /electron-builder --win nsis portable/, /check-package\.js/, /sha256sum/]) {
    const i = order(re);
    assert.ok(i >= 0 && i < publish, `${re} runs before publishing`);
  }
  assert.ok(order(/release\.js --check-tag/) < order(/npm ci/), 'a wrong tag fails before the slow steps');
  const pub = steps[publish];
  assert.match(pub.run, /dist\/\*\.exe dist\/SHA256SUMS\.txt/);
  assert.match(pub.run, /--target "\$GITHUB_SHA"/, 'creates the tag on the built commit when run by hand');
  // Run by hand: only from main, never over an existing tag, and the tag is still checked.
  const tagStep = steps[order(/release\.js --check-tag/)];
  assert.match(tagStep.run, /refs\/heads\/main/);
  assert.match(tagStep.run, /ls-remote --exit-code --tags origin/);
  assert.match(tagStep.run, /--check-tag "\$tag"/);
  assert.match(pub.run, /--generate-notes/);
  assert.match(pub.run, /--prerelease/);
  assert.equal(pub.env.GH_TOKEN, '${{ github.token }}');
  // No ${{ }} expressions inside run: scripts (the tag comes in through $GITHUB_REF_NAME).
  for (const s of steps) assert.doesNotMatch(s.run || '', /\$\{\{/, `step "${s.name}" interpolates an expression into a script`);
  assert.equal(pkg.scripts.release, 'node scripts/release.js');
});
