// @ts-check
'use strict';
// Pure helpers of the Outside UI (renderer/components/external.js): labels, grouping, sorting, feed lines.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'app', 'src', 'renderer', 'components', 'external.js')).href);

test('entrypointLabel / runsIn name where a session runs', async () => {
  const x = await load();
  assert.equal(x.entrypointLabel('vscode'), 'VS Code');
  assert.equal(x.entrypointLabel('claude-vscode'), 'VS Code');
  assert.equal(x.entrypointLabel('cli'), 'Terminal');
  assert.equal(x.entrypointLabel(undefined), 'Terminal');
  assert.equal(x.entrypointLabel('jetbrains'), 'JetBrains');
  assert.equal(x.entrypointLabel('cursor'), 'Cursor');
  assert.equal(x.entrypointLabel('sdk-ts'), 'an SDK app');
  assert.equal(x.entrypointLabel('Zed'), 'Zed');
  assert.equal(x.runsIn('vscode'), 'running in VS Code');
  assert.equal(x.runsIn('cli'), 'running in a terminal');
});

test('sortExternal: needs you, working, idle, unknown; newest first', async () => {
  const x = await load();
  const list = [
    { name: 'a', state: 'idle', updatedAt: 5 }, { name: 'b', state: 'working', updatedAt: 1 },
    { name: 'c', state: 'unknown', updatedAt: 9 }, { name: 'd', state: 'idle', updatedAt: 8 }, { name: 'e', state: 'needs_you', updatedAt: 0 },
  ];
  assert.deepEqual(x.sortExternal(list).map((s) => s.name), ['e', 'b', 'd', 'a', 'c']);
  assert.equal(list[0].name, 'a', 'input is not mutated');
});

test('paths: Windows and POSIX, either slash', async () => {
  const x = await load();
  assert.equal(x.folderName('C:\\Users\\me\\code\\cc-dashboard'), 'cc-dashboard');
  assert.equal(x.folderName('/home/me/code/notes/'), 'notes');
  assert.equal(x.normPath('C:\\Users\\Me\\Code\\'), 'c:/users/me/code');
  assert.equal(x.normPath('/Home/Me'), '/Home/Me', 'POSIX paths keep their case');
  assert.equal(x.displayPath('C:\\code\\app'), 'C:\\code\\app');
  assert.equal(x.displayPath('C:\\Users\\someone\\Documents\\projects\\clients\\cc-dashboard', 30), 'C:\\…\\clients\\cc-dashboard');
  assert.equal(x.displayPath('/home/someone/documents/projects/clients/cc-dashboard', 30), '/…/clients/cc-dashboard');
});

test('spaceOfSession / groupExternal: by id, else by folder (either slash, case-insensitive on Windows); rest is "other"', async () => {
  const x = await load();
  const spaces = [{ id: 'cc', path: 'C:\\Code\\cc-dashboard' }, { id: 'sub', path: 'C:\\Code\\cc-dashboard\\packages\\app' }, { id: 'p', path: '/home/me/p' }];
  assert.equal(x.spaceOfSession({ spaceId: 'cc', cwd: 'D:\\elsewhere' }, spaces), 'cc', 'the core said so');
  assert.equal(x.spaceOfSession({ spaceId: 'gone', cwd: 'c:/code/CC-dashboard/docs' }, spaces), 'cc', 'unknown id: match by folder');
  assert.equal(x.spaceOfSession({ cwd: 'C:\\Code\\cc-dashboard\\packages\\app\\src' }, spaces), 'sub', 'the deepest folder wins');
  assert.equal(x.spaceOfSession({ cwd: 'C:\\Code\\cc-dashboard-old' }, spaces), null, 'a sibling with the same prefix is not inside');
  assert.equal(x.spaceOfSession({ cwd: '/home/me/P' }, spaces), null, 'POSIX is case-sensitive');
  const g = x.groupExternal([
    { name: '1', state: 'idle', cwd: '/home/me/p' }, { name: '2', state: 'working', cwd: '/home/me/p/x' },
    { name: '3', state: 'idle', cwd: '/tmp/none' },
  ], spaces);
  assert.deepEqual(g.bySpace.get('p').map((s) => s.name), ['2', '1']);
  assert.deepEqual(g.other.map((s) => s.name), ['3']);
  assert.deepEqual(x.externalOfSpace([{ name: '1', state: 'idle', cwd: '/home/me/p' }, { name: '3', state: 'idle', cwd: '/tmp/none' }], spaces, null).length, 2);
});

test('board column and activity text', async () => {
  const x = await load();
  assert.deepEqual(['needs_you', 'working', 'idle', 'unknown'].map(x.externalBoardColumn), ['needs', 'working', 'done', 'done']);
  assert.equal(x.externalActivityText({ state: 'working', tool: 'Read', detail: 'a.js' }), 'Read a.js');
  assert.equal(x.externalActivityText({ state: 'working' }), 'Working…');
  assert.equal(x.externalActivityText({ state: 'needs_you', entrypoint: 'vscode' }), 'Waiting for you in VS Code');
  assert.equal(x.externalActivityText({ state: 'idle', lastPrompt: 'hi' }), 'Idle · hi');
});

test('recentFeed: last lines, a tool call shows once, errors flagged, session_start skipped', async () => {
  const x = await load();
  const e = [
    { seq: 1, kind: 'session_start' }, { seq: 2, kind: 'prompt', text: 'Fix it', subagentId: '' },
    { seq: 3, kind: 'tool', tool: 'Read', detail: 'a.js', subagentId: '' }, { seq: 4, kind: 'tool_done', tool: 'Read', detail: 'a.js', subagentId: '' },
    { seq: 5, kind: 'tool', tool: 'Bash', detail: 'npm test', subagentId: 's1' }, { seq: 6, kind: 'tool_error', tool: 'Bash', detail: 'npm test', subagentId: 's1' },
    { seq: 7, kind: 'tool', tool: 'Edit', detail: 'b.js', subagentId: '' },
  ];
  const f = x.recentFeed(e, 10);
  assert.deepEqual(f.map((l) => l.seq), [2, 4, 6, 7]);
  assert.equal(f[2].error, true);
  assert.equal(f[2].sub, true);
  assert.deepEqual(x.recentFeed(e, 2).map((l) => l.seq), [6, 7]);
  const many = Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, kind: 'prompt', text: `p${i}` }));
  assert.equal(x.recentFeed(many).length, 6);
});

test('mergeEntries dedupes by seq, sorts and caps', async () => {
  const x = await load();
  const m = x.mergeEntries([{ seq: 1 }, { seq: 3 }], [{ seq: 2 }, { seq: 3 }, { seq: 4 }], 3);
  assert.deepEqual(m.map((e) => e.seq), [2, 3, 4]);
});

test('takeOverCopy: idle asks, working warns and forces; new space is announced', async () => {
  const x = await load();
  const s = { name: 'review', entrypoint: 'vscode', cwd: 'C:\\Code\\notes', state: 'working', tool: 'Read', detail: 'a.js' };
  const idle = x.takeOverCopy(s, { working: false, spaceName: 'cc' });
  assert.match(idle.lead, /ends the session in VS Code and reopens the same conversation here, with its terminal/);
  assert.equal(idle.warning, '');
  assert.equal(idle.button, 'Take over');
  assert.match(idle.space, /joins the space “cc”/);
  const busy = x.takeOverCopy(s, { working: true, spaceName: null });
  assert.match(busy.warning, /working right now \(Read a\.js\)/);
  assert.equal(busy.button, 'End it and take over');
  assert.match(busy.space, /new space “notes”/);
});
