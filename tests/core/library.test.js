'use strict';
// Library: scanning plugins and skills, plugin actions (command lines), confirm flow, skill read/write safety.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library, isNewerVersion, parseFrontMatter, parseAlwaysOn, parseConfigure } = require('../../packages/core/src/library');
const { claudeCmd, rmrf, waitFor } = require('./helpers');

const FAKE = path.join(__dirname, '..', 'fixtures', 'library', 'fake-claude-plugin.js');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skillMd = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`;

/** A temp world: config dir, one plugin with parts (path with spaces), a managed plugin, a space with a skill. */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc lib test-'));
  const cfg = path.join(root, 'claude home');
  const space = path.join(root, 'proj');
  const plug = path.join(cfg, 'plugins', 'cache', 'my market', 'tools');
  const synced = path.join(cfg, 'plugins', 'synced', 'org');
  write(path.join(cfg, 'skills', 'pdf', 'SKILL.md'), skillMd('pdf', 'Work with PDFs'));
  write(path.join(space, '.claude', 'skills', 'release', 'SKILL.md'), '---\nname: release\ndescription: >\n  Cut a release\n  with care\n---\nbody');
  write(path.join(plug, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tools', description: 'Handy tools', author: { name: 'Acme' }, homepage: 'https://example.com', logo: 'logo.png', userConfig: { token: {} } }));
  write(path.join(plug, 'logo.png'), 'x');
  write(path.join(plug, 'skills', 'lint', 'SKILL.md'), skillMd('lint', 'Lint things'));
  write(path.join(plug, 'agents', 'reviewer.md'), 'x');
  write(path.join(plug, 'commands', 'ship.md'), 'x');
  write(path.join(plug, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }] } }));
  write(path.join(plug, '.mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'x' } } }));
  write(path.join(synced, 'plugin.json'), JSON.stringify({ name: 'org', version: '3.0.0', author: 'Org' }));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'log.jsonl');
  fs.writeFileSync(stateFile, JSON.stringify({
    plugins: [
      { id: 'tools@my-market', version: '1.0.0', scope: 'user', enabled: true, installPath: plug },
      { id: 'org@synced', version: '3.0.0', scope: 'synced', enabled: true, installPath: synced },
      { id: 'cc-plugin-telemetry@builtin', version: 'unknown', scope: 'user', enabled: true },
    ],
    available: [{ pluginId: 'new@my-market', name: 'new', description: 'A new one', marketplaceName: 'my-market' }, { pluginId: 'tools@my-market', name: 'tools', marketplaceName: 'my-market', version: '1.2.0' }, { pluginId: 'org@synced', name: 'org', version: '9.0.0' }],
    marketplaces: [{ name: 'my-market', source: 'github', repo: 'acme/market' }],
    needsCommand: { 'cmd@my-market': 'a'.repeat(64) },
    tokens: { 'tools@my-market': 1200 },
  }));
  const events = [];
  const core = { spaces: new Map([['proj', { id: 'proj', name: 'proj', path: space }]]), broadcast: (e, d) => events.push([e, d]) };
  const env = { ...process.env, CC_CLAUDE: claudeCmd(FAKE), CLAUDE_CONFIG_DIR: cfg, FAKE_PLUGIN_STATE: stateFile, FAKE_PLUGIN_LOG: logFile };
  const lib = new Library(core, { env });
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { root, cfg, space, plug, lib, events, calls, stateFile, cleanup: () => { lib.dispose(); rmrf(root); } };
}

test('front matter: quotes, folded blocks, missing', () => {
  assert.deepEqual(parseFrontMatter('---\nname: a\ndescription: "x: y"\n---\nbody'), { name: 'a', description: 'x: y' });
  assert.equal(parseFrontMatter('---\ndescription: >\n  one\n  two\n---\n').description, 'one two');
  assert.equal(parseFrontMatter('---\r\nname: crlf\r\n---\r\n').name, 'crlf');
  assert.deepEqual(parseFrontMatter('no front matter'), {});
  assert.equal(parseAlwaysOn('Always-on:   ~873 tok'), 873);
  assert.equal(parseAlwaysOn('Always-on: ~1.2k tok'), 1200);
  assert.equal(parseAlwaysOn('nothing'), undefined);
  assert.deepEqual(parseConfigure({ schema: { properties: { a: { type: 'string', title: 'A' } } }, inputs: { a: '1' } }), { options: [{ key: 'a', title: 'A', type: 'string' }], values: { a: '1' } });
});

test('list: plugins with manifest, parts, managed flags; skills from user, project and plugin', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const lib = await w.lib.list({});
  assert.deepEqual(lib.errors, []);
  const tools = lib.plugins.find((p) => p.id === 'tools@my-market');
  assert.equal(tools.name, 'tools');
  assert.equal(tools.author, 'Acme');
  assert.equal(tools.description, 'Handy tools');
  assert.equal(tools.marketplace, 'my-market');
  assert.equal(tools.managed, false);
  assert.equal(tools.hasConfig, true);
  assert.equal(tools.logo, path.join(w.plug, 'logo.png'));
  assert.deepEqual(tools.components, { skills: ['lint'], agents: ['reviewer'], commands: ['ship'], hooks: 2, mcpServers: ['github'] });
  assert.equal(lib.plugins.find((p) => p.id === 'org@synced').managed, true);
  assert.equal(lib.plugins.find((p) => p.id === 'cc-plugin-telemetry@builtin').managed, true);
  assert.deepEqual(lib.marketplaces, [{ name: 'my-market', source: 'github:acme/market' }]);
  const byId = Object.fromEntries(lib.skills.map((s) => [s.id, s]));
  assert.equal(byId['user:pdf'].description, 'Work with PDFs');
  assert.equal(byId['user:pdf'].deletable, true);
  assert.equal(byId['project:proj:release'].description, 'Cut a release with care');
  assert.equal(byId['project:proj:release'].spaceId, 'proj');
  assert.equal(byId['plugin:tools@my-market:lint'].deletable, false);
  assert.equal(byId['plugin:tools@my-market:lint'].pluginId, 'tools@my-market');
});

test('list: context cost arrives later with a library.changed event', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const first = await w.lib.list({});
  assert.equal(first.plugins.find((p) => p.id === 'tools@my-market').tokens, undefined);
  await waitFor(() => w.events.some(([e, d]) => e === 'library.changed' && d.library.plugins.some((p) => p.tokens && p.tokens.alwaysOn === 1200)), { what: 'tokens event' });
  assert.equal((await w.lib.list({})).plugins.find((p) => p.id === 'tools@my-market').tokens.alwaysOn, 1200);
  const detailsCalls = w.calls().filter((c) => c.argv[1] === 'details');
  const again = detailsCalls.length;
  await w.lib.list({ refresh: true });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(w.calls().filter((c) => c.argv[1] === 'details').length, again, 'cached: details is not read twice');
});

test('list: claude missing is a non-fatal error', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const lib = new Library(w.lib.core, { env: { ...w.lib.env, CC_CLAUDE: path.join(w.root, 'no-such-claude') } });
  const r = await lib.list({});
  assert.deepEqual(r.plugins, []);
  assert.ok(r.errors.length >= 1 && /not found|claude/i.test(r.errors[0]), r.errors.join('|'));
  assert.equal(r.skills.some((s) => s.id === 'user:pdf'), true, 'skills are still listed');
  lib.dispose();
});

test('pluginAction: right command lines, rescans and broadcasts', async (t) => {
  const w = world();
  t.after(w.cleanup);
  await w.lib.list({});
  const r = await w.lib.pluginAction({ id: 'tools@my-market', action: 'disable' });
  assert.equal(r.ok, true);
  assert.deepEqual(w.calls().find((c) => c.argv[1] === 'disable').argv, ['plugin', 'disable', 'tools@my-market', '--json', '--scope', 'user']);
  assert.equal((await w.lib.list({})).plugins.find((p) => p.id === 'tools@my-market').enabled, false);
  await waitFor(() => w.events.some(([e]) => e === 'library.changed'), { what: 'library.changed' });
  await w.lib.pluginAction({ id: 'tools@my-market', action: 'enable' });
  assert.equal((await w.lib.list({})).plugins.find((p) => p.id === 'tools@my-market').enabled, true);
  const u = await w.lib.pluginAction({ id: 'tools@my-market', action: 'uninstall', keepData: true });
  assert.equal(u.ok, true);
  assert.ok(w.calls().find((c) => c.argv[1] === 'uninstall').argv.includes('--keep-data'));
  assert.equal((await w.lib.list({})).plugins.some((p) => p.id === 'tools@my-market'), false);
  await assert.rejects(w.lib.pluginAction({ id: 'new@my-market', action: 'update' }), { code: 'not_found' });
});

test('pluginAction: removing or updating managed plugins, unknown ids and option injection are refused', async (t) => {
  const w = world();
  t.after(w.cleanup);
  await assert.rejects(w.lib.pluginAction({ id: 'org@synced', action: 'uninstall' }), { code: 'not_allowed' });
  await assert.rejects(w.lib.pluginAction({ id: 'org@synced', action: 'update' }), { code: 'not_allowed' });
  await assert.rejects(w.lib.pluginAction({ id: 'cc-plugin-telemetry@builtin', action: 'uninstall' }), { code: 'not_allowed' });
  await assert.rejects(w.lib.pluginAction({ id: 'ghost@x', action: 'disable' }), { code: 'not_found' });
  await assert.rejects(w.lib.pluginAction({ id: '--help', action: 'install' }), { code: 'bad_request' });
  await assert.rejects(w.lib.pluginAction({ id: 'a@b', action: 'explode' }), { code: 'bad_request' });
  await assert.rejects(w.lib.pluginAction({ id: 'a@b', action: 'install', acceptCommand: 'nope' }), { code: 'bad_request' });
  assert.equal(w.calls().filter((c) => ['uninstall', 'update', 'disable'].includes(c.argv[1])).length, 0);
});

test('pluginAction: managed and built-in plugins can still be turned on and off (claude decides)', async (t) => {
  const w = world();
  t.after(w.cleanup);
  await w.lib.pluginAction({ id: 'cc-plugin-telemetry@builtin', action: 'disable' });
  await w.lib.pluginAction({ id: 'org@synced', action: 'disable' });
  const calls = w.calls().filter((c) => c.argv[1] === 'disable').map((c) => c.argv[2]);
  assert.deepEqual(calls, ['cc-plugin-telemetry@builtin', 'org@synced']);
});

test('install: a command-source plugin asks for confirmation, then installs with --accept-command', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const plain = await w.lib.pluginAction({ id: 'new@my-market', action: 'install' });
  assert.equal(plain.ok, true);
  const first = await w.lib.pluginAction({ id: 'cmd@my-market', action: 'install' });
  assert.equal(first.ok, false);
  assert.deepEqual(first.confirm, { command: 'npx some-installer --yes', sha256: 'a'.repeat(64) });
  assert.equal((await w.lib.list({})).plugins.some((p) => p.id === 'cmd@my-market'), false);
  const second = await w.lib.pluginAction({ id: 'cmd@my-market', action: 'install', acceptCommand: 'a'.repeat(64) });
  assert.equal(second.ok, true);
  assert.deepEqual(w.calls().filter((c) => c.argv[1] === 'install').pop().argv, ['plugin', 'install', 'cmd@my-market', '--json', '--accept-command', 'a'.repeat(64)]);
  assert.equal((await w.lib.list({})).plugins.some((p) => p.id === 'cmd@my-market'), true);
});

test('available marks installed plugins; marketplace add/remove/update', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const av = await w.lib.available();
  assert.deepEqual(av.map((a) => [a.id, a.installed, a.marketplace]).slice(0, 2), [['new@my-market', false, 'my-market'], ['tools@my-market', true, 'my-market']]);
  const add = await w.lib.marketplace({ action: 'add', source: 'acme/second market' });
  assert.equal(add.ok, true);
  assert.deepEqual(w.calls().find((c) => c.argv[2] === 'add').argv, ['plugin', 'marketplace', 'add', 'acme/second market']);
  assert.ok((await w.lib.list({})).marketplaces.some((m) => m.name === 'second market'));
  await w.lib.marketplace({ action: 'remove', name: 'my-market' });
  assert.equal((await w.lib.list({})).marketplaces.some((m) => m.name === 'my-market'), false);
  await w.lib.marketplace({ action: 'update' });
  await assert.rejects(w.lib.marketplace({ action: 'add', source: '--evil' }), { code: 'bad_request' });
  await assert.rejects(w.lib.marketplace({ action: 'nuke' }), { code: 'bad_request' });
});

test('configure: reads options, saves values through stdin and reads them back', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const r0 = await w.lib.configure({ id: 'tools@my-market' });
  assert.deepEqual(r0.options.map((o) => o.key), ['token', 'region']);
  assert.deepEqual(r0.options[1].options, ['eu', 'us']);
  const r1 = await w.lib.configure({ id: 'tools@my-market', values: { token: 'abc', region: 'us' } });
  assert.deepEqual(r1.values, { token: 'abc', region: 'us' });
  const save = w.calls().find((c) => c.argv.includes('--values-stdin'));
  assert.deepEqual(JSON.parse(save.stdin), { token: 'abc', region: 'us' });
  await assert.rejects(w.lib.configure({ id: 'tools@my-market', values: { token: 'a\nb' } }), { code: 'bad_request' });
  await assert.rejects(w.lib.configure({ id: 'org@synced', values: { a: 'b' } }), { code: 'not_allowed' });
});

test('skillRead: known skills only', async (t) => {
  const w = world();
  t.after(w.cleanup);
  assert.match((await w.lib.skillRead({ id: 'user:pdf' })).content, /Work with PDFs/);
  assert.match((await w.lib.skillRead({ id: 'plugin:tools@my-market:lint' })).content, /Lint things/);
  await assert.rejects(w.lib.skillRead({ id: 'user:../../etc/passwd' }), { code: 'not_found' });
  await assert.rejects(w.lib.skillRead({ id: path.join(w.cfg, 'skills', 'pdf', 'SKILL.md') }), { code: 'not_found' });
  await assert.rejects(w.lib.skillRead({}), { code: 'bad_request' });
});

test('skillWrite: save, create (user and project), validate names, refuse traversal and plugin skills', async (t) => {
  const w = world();
  t.after(w.cleanup);
  await w.lib.list({});
  const saved = await w.lib.skillWrite({ id: 'user:pdf', content: skillMd('pdf', 'Changed') });
  assert.equal(saved.description, 'Changed');
  assert.match(fs.readFileSync(path.join(w.cfg, 'skills', 'pdf', 'SKILL.md'), 'utf8'), /Changed/);

  const made = await w.lib.skillWrite({ scope: 'user', name: 'my-skill-2', content: '' });
  assert.equal(made.id, 'user:my-skill-2');
  assert.equal(made.path, path.join(w.cfg, 'skills', 'my-skill-2', 'SKILL.md'));
  assert.match(fs.readFileSync(made.path, 'utf8'), /^---\nname: my-skill-2\n/);
  const proj = await w.lib.skillWrite({ scope: 'project', spaceId: 'proj', name: 'deploy', content: skillMd('deploy', 'Deploy it') });
  assert.equal(proj.id, 'project:proj:deploy');
  assert.equal(proj.path, path.join(w.space, '.claude', 'skills', 'deploy', 'SKILL.md'));

  for (const name of ['../evil', 'a/b', 'a\\b', 'Up', '', '.', '..', '-x', 'a b', 'x'.repeat(65)]) {
    await assert.rejects(w.lib.skillWrite({ scope: 'user', name, content: 'x' }), { code: 'bad_request' }, `name ${JSON.stringify(name)}`);
  }
  await assert.rejects(w.lib.skillWrite({ scope: 'user', name: 'pdf', content: 'x' }), { code: 'bad_request' }, 'exists');
  await assert.rejects(w.lib.skillWrite({ scope: 'project', spaceId: 'nope', name: 'x', content: 'x' }), { code: 'not_found' });
  await assert.rejects(w.lib.skillWrite({ scope: 'global', name: 'x', content: 'x' }), { code: 'bad_request' });
  await assert.rejects(w.lib.skillWrite({ id: 'plugin:tools@my-market:lint', content: 'x' }), { code: 'not_allowed' });
  await assert.rejects(w.lib.skillWrite({ id: path.join(w.cfg, 'skills', 'pdf', 'SKILL.md'), content: 'x' }), { code: 'not_found' });
  assert.equal(fs.existsSync(path.join(w.root, 'evil')), false);
  assert.equal(fs.existsSync(path.join(w.cfg, 'evil')), false);
});

test('isNewerVersion: numeric parts, pre-releases, junk', () => {
  assert.equal(isNewerVersion('1.10.0', '1.9.2'), true);
  assert.equal(isNewerVersion('1.2.0', '1.2.0'), false);
  assert.equal(isNewerVersion('1.2', '1.2.0'), false);
  assert.equal(isNewerVersion('2.0.0', '10.0.0'), false);
  assert.equal(isNewerVersion('1.0.0', '1.0.0-beta.2'), true);
  assert.equal(isNewerVersion('1.0.0-beta.10', '1.0.0-beta.9'), true);
  assert.equal(isNewerVersion('1.0.0-beta', '1.0.0'), false);
  assert.equal(isNewerVersion('v2.1.0', '2.0.9'), true);
  assert.equal(isNewerVersion('unknown', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.0', 'unknown'), false);
});

test('update available: a newer marketplace version marks the plugin (not managed ones)', async (t) => {
  const w = world();
  t.after(w.cleanup);
  await w.lib.list({ refresh: true });
  await waitFor(() => w.lib.cache.plugins.find((p) => p.id === 'tools@my-market').updateAvailable === true, { what: 'update badge' });
  assert.notEqual(w.lib.cache.plugins.find((p) => p.id === 'org@synced').updateAvailable, true, 'managed plugins are not offered updates');
  // library.changed is coalesced (~60 ms): wait for the event that carries the badge.
  await waitFor(() => w.events.some(([e, d]) => e === 'library.changed' && d.library.plugins.find((p) => p.id === 'tools@my-market').updateAvailable), { what: 'library.changed with the badge' });
});
