#!/usr/bin/env node
// @ts-check
'use strict';
/**
 * Cutting a release (see docs/RELEASE.md):
 *
 *   npm run release -- patch          0.1.0 -> 0.1.1   (also: minor, major, or an exact 1.2.3)
 *   npm run release -- minor --push   ... and push main + the tag, which starts the Release workflow
 *
 * Before tagging it checks that you are on an up-to-date, clean main and that `npm test` passes.
 * The tag push runs .github/workflows/release.yml: tests, installer, GitHub Release.
 *
 * Used by the workflow too:
 *   node scripts/release.js --check-tag v1.2.3   exit 1 unless the tag is vX.Y.Z and matches package.json
 *   node scripts/release.js --notes v1.2.3       print the release notes header (install steps)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

/**
 * Is `tag` a release tag for `version`? Returns an error message, or '' when it is.
 * @param {string} tag @param {string} version
 */
function checkTag(tag, version) {
  if (!TAG_RE.test(tag || '')) return `"${tag}" is not a release tag (expected vMAJOR.MINOR.PATCH, e.g. v1.2.3 or v1.2.3-beta.1)`;
  if (tag !== `v${version}`) return `tag ${tag} does not match package.json version ${version}: run "npm run release" to bump both`;
  return '';
}

/**
 * The version after a bump. @param {string} current @param {string} bump patch | minor | major | X.Y.Z[-pre]
 */
function nextVersion(current, bump) {
  const m = TAG_RE.exec(`v${current}`);
  if (!m) throw new Error(`package.json version ${current} is not MAJOR.MINOR.PATCH`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  if (bump === 'patch') return m[4] ? `${maj}.${min}.${pat}` : `${maj}.${min}.${pat + 1}`;
  if (TAG_RE.test(`v${bump}`)) return bump;
  throw new Error(`unknown bump "${bump}": use patch, minor, major or an exact version like 1.2.3`);
}

/**
 * The top of the GitHub Release notes; GitHub appends the generated changelog below it.
 * @param {string} version @param {string} [repo] owner/name, for links
 */
function releaseNotes(version, repo = 'SeanRegev/CC-Dashboard') {
  const dl = `https://github.com/${repo}/releases/download/v${version}`;
  return [
    `## Install`,
    ``,
    `| | |`,
    `|---|---|`,
    `| **Installer** (recommended) | [CC-Dashboard-Setup-${version}.exe](${dl}/CC-Dashboard-Setup-${version}.exe) |`,
    `| **Portable** (no install) | [CC-Dashboard-Portable-${version}.exe](${dl}/CC-Dashboard-Portable-${version}.exe) |`,
    ``,
    `1. You need [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed **on Windows itself**: \`claude --version\` must work in PowerShell.`,
    `2. Run the installer. It is not code-signed yet, so Windows shows *"Windows protected your PC"*: click **More info → Run anyway**.`,
    `3. Open CC-Dashboard, **Add space** (a project folder), then **New agent** (Ctrl+T).`,
    ``,
    `Checksums: \`SHA256SUMS.txt\`. Full guide: [README](https://github.com/${repo}#readme).`,
    ``,
  ].join('\n');
}

/** @param {string} cmd @param {string[]} args @param {{inherit?: boolean}} [o] */
function run(cmd, args, o = {}) {
  const stdio = o.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'];
  // npm is a .cmd shim on Windows, which only runs through the shell; quote for cmd.exe then.
  if (process.platform === 'win32' && cmd === 'npm') {
    const line = ['npm', ...args.map((a) => (/[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))].join(' ');
    return execFileSync(line, { cwd: ROOT, encoding: 'utf8', stdio: /** @type {any} */ (stdio), shell: true }) || '';
  }
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: /** @type {any} */ (stdio) }) || '';
}

/** @param {string} msg */
function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

function cut(bump, push) {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch !== 'main') fail(`releases are cut from main (you are on ${branch})`);
  if (run('git', ['status', '--porcelain']).trim()) fail('the working tree has uncommitted changes');
  run('git', ['fetch', 'origin', 'main', '--tags']);
  const behind = run('git', ['rev-list', '--count', 'HEAD..origin/main']).trim();
  if (behind !== '0') fail(`main is ${behind} commit(s) behind origin/main: pull first`);

  const version = nextVersion(readVersion(), bump);
  if (run('git', ['tag', '--list', `v${version}`]).trim()) fail(`tag v${version} already exists`);
  console.log(`release: running the tests before tagging v${version} ...`);
  run('npm', ['test'], { inherit: true });

  // Bumps package.json + package-lock.json, commits "Release vX.Y.Z" and tags vX.Y.Z.
  run('npm', ['version', version, '-m', 'Release v%s'], { inherit: true });
  if (push) {
    run('git', ['push', 'origin', 'main', '--follow-tags'], { inherit: true });
    console.log(`release: pushed v${version}. The Release workflow now builds and publishes it (Actions tab).`);
  } else {
    console.log(`release: tagged v${version}. Publish it with:\n  git push origin main --follow-tags`);
  }
}

function main(argv) {
  if (argv[0] === '--check-tag') {
    const err = checkTag(argv[1], readVersion());
    if (err) fail(err);
    console.log(`release: ${argv[1]} matches package.json`);
    return;
  }
  if (argv[0] === '--notes') {
    const err = checkTag(argv[1], readVersion());
    if (err) fail(err);
    process.stdout.write(releaseNotes(argv[1].slice(1), process.env.GITHUB_REPOSITORY || undefined));
    return;
  }
  const bump = argv.find((a) => !a.startsWith('--'));
  if (!bump) fail('usage: npm run release -- <patch|minor|major|X.Y.Z> [--push]');
  try { nextVersion(readVersion(), bump); } catch (e) { fail(/** @type {Error} */ (e).message); }
  cut(bump, argv.includes('--push'));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { checkTag, nextVersion, releaseNotes, TAG_RE };
