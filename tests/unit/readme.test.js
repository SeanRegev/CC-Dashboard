// @ts-check
'use strict';
// The README is the front page: every picture and local link in it must exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');

test('README pictures exist and are real screenshots (PNG)', () => {
  const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)|<img[^>]+src="([^"]+)"/g)].map((m) => m[1] || m[2]);
  assert.ok(images.length >= 4, `README shows ${images.length} pictures`);
  for (const src of images) {
    assert.ok(!/^https?:/.test(src), `${src}: pictures are kept in the repo`);
    const file = path.join(REPO, src);
    assert.ok(fs.existsSync(file), `${src} exists`);
    assert.deepEqual([...fs.readFileSync(file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${src} is a PNG`);
  }
});

test('README local links point at files that exist', () => {
  const links = [...readme.matchAll(/\]\(((?!https?:|#|mailto:)[^)\s]+)\)/g)].map((m) => m[1].split('#')[0]).filter(Boolean);
  for (const l of links) assert.ok(fs.existsSync(path.join(REPO, l)), `${l} exists`);
});

test('README documents every keyboard shortcut the app has', () => {
  for (const k of ['Ctrl+K', 'Ctrl+T', 'Ctrl+\\', 'Ctrl+W', 'Ctrl+Tab', 'Ctrl+1', 'Ctrl+Shift+C', 'Ctrl+Shift+V',
    'Ctrl+Shift+T', 'Ctrl+Shift+G', 'Ctrl+Shift+B', 'Ctrl+Shift+A', 'Ctrl+Shift+L', 'Ctrl+Shift+D', 'Ctrl+,', 'F2']) {
    assert.ok(readme.includes(k), `README mentions ${k}`);
  }
});

test('README shortcut table lists every view key the app wires (Ctrl+Shift+letter)', () => {
  const { VIEW_KEYS } = require('../../packages/app/src/renderer/logic.js');
  for (const code of Object.keys(VIEW_KEYS)) {
    const letter = code.replace(/^Key/, '');
    assert.ok(readme.includes(`Ctrl+Shift+${letter}`), `README mentions Ctrl+Shift+${letter}`);
  }
});

test('README points at the changelog and the plugin dashboards guide', () => {
  assert.ok(readme.includes('(CHANGELOG.md)'), 'changelog linked');
  assert.ok(readme.includes('(docs/PLUGIN-DASHBOARDS.md)'), 'plugin guide linked');
});
