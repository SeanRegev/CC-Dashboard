// @ts-check
'use strict';
// The renderer's role list (ESM, no bundler) must stay identical to the contract's.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROLES } = require('../../packages/shared/protocol.js');

test('renderer roles.js matches protocol ROLES, Main first and crowned', async () => {
  const r = await import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'app', 'src', 'renderer', 'roles.js')).href).catch((e) => {
    // roles.js imports dom.js, which needs a DOM only when called; the import itself must work in Node.
    throw e;
  });
  assert.deepEqual(JSON.parse(JSON.stringify(r.ROLES)), JSON.parse(JSON.stringify(ROLES)));
  assert.deepEqual(ROLES[0], { id: 'main', label: 'Main', emoji: '👑' });
  assert.equal(r.roleOf({ role: { id: 'docs', label: 'Docs', emoji: '📝' } }).id, 'docs');
  assert.equal(r.roleOf({}).id, 'worker', 'agents from an older core show as Worker');
  assert.equal(r.isMain({ role: ROLES[0] }), true);
});
