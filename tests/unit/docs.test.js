// @ts-check
'use strict';
// The docs are part of the product: the plugin dashboard examples must be what the app really reads,
// and the changelog must have the release sections.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPluginDashboards } = require('../../packages/core/src/dashboards.js');

const REPO = path.join(__dirname, '..', '..');
// Git on Windows checks text files out with CRLF line endings: normalise before matching.
const readText = (/** @type {string[]} */ ...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf8').replace(/\r\n/g, '\n');
const plugin = readText('docs', 'PLUGIN-DASHBOARDS.md');
const changelog = readText('CHANGELOG.md');

/** The JSON code blocks of PLUGIN-DASHBOARDS.md, in order. @returns {any[]} */
function jsonBlocks() {
  return [...plugin.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
}

test('plugin dashboard docs: the example manifests parse', () => {
  const blocks = jsonBlocks();
  assert.equal(blocks.length, 2, 'two json examples');
  for (const b of blocks) assert.ok(b.name && b.dashboard, 'each example has a name and a dashboard');
});

test('plugin dashboard docs: the minimal example is read as a page', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-docs-'));
  try {
    const [minimal] = jsonBlocks();
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(minimal));
    fs.writeFileSync(path.join(dir, 'dashboard', 'index.html'), '<!doctype html><title>x</title>');
    const [d] = readPluginDashboards('weather-cli@test', 'weather-cli', dir);
    assert.equal(d.kind, 'page');
    assert.equal(d.file, path.join(dir, 'dashboard', 'index.html'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin dashboard docs: the object example is read as a web dashboard that needs trust', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-docs-'));
  try {
    const [, object] = jsonBlocks();
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(object));
    const [d] = readPluginDashboards('weather-cli@test', 'weather-cli', dir);
    assert.equal(d.kind, 'web');
    assert.equal(d.name, 'Weather history');
    assert.equal(d.command, 'node dashboard/server.js');
    assert.equal(d.trusted, false, 'a plugin command is not trusted until the user approves it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('changelog has the 0.4.0, 0.3.0 and 0.2.0 sections, newest first', () => {
  const heads = [...changelog.matchAll(/^## (\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(heads.slice(0, 3), ['0.4.0', '0.3.0', '0.2.0']);
});
