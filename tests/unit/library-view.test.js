// @ts-check
'use strict';
// Library view helpers: plugin order and descriptions (checked against the real plugin list shape).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'app', 'src', 'renderer', 'views', 'library.js')).href);

test('plugins: yours first, then synced by your organization, then Claude Code built-ins', async () => {
  const L = await load();
  const plugins = [
    { id: 'cc-plugin-telemetry@builtin', name: 'cc-plugin-telemetry', version: 'unknown', managed: true },
    { id: 'zeta@market', name: 'zeta', version: '1.0.0', installPath: '/x/zeta', managed: false },
    { id: 'bio-research@synced', name: 'bio-research', version: '1.2.0', installPath: '/x/bio', managed: true },
    { id: 'alpha@market', name: 'alpha', version: '2.0.0', installPath: '/x/alpha', managed: false },
  ];
  assert.deepEqual([...plugins].sort(L.comparePlugins).map((p) => p.name), ['alpha', 'zeta', 'bio-research', 'cc-plugin-telemetry']);
  assert.equal(L.pluginDescription(plugins[0]), 'Built into Claude Code.');
  assert.equal(L.pluginDescription(plugins[1]), 'No description.');
  assert.equal(L.pluginDescription({ ...plugins[1], description: 'Does things' }), 'Does things');
});
