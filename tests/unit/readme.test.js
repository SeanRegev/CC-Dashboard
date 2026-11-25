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
  for (const k of ['Ctrl+K', 'Ctrl+T', 'Ctrl+\\', 'Ctrl+W', 'Ctrl+Tab', 'Ctrl+1', 'Ctrl+Shift+C', 'Ctrl+Shift+V']) {
    assert.ok(readme.includes(k), `README mentions ${k}`);
  }
});
