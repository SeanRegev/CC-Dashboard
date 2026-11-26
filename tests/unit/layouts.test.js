// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'app', 'src', 'renderer', 'logic.js')).href);

/** @param {string} name @param {string} state @param {any} [x] */
const entry = (name, state, x = {}) => ({
  agent: { id: name, name, spaceId: x.spaceId || 'sp', createdAt: x.createdAt || 0, role: { id: x.role || 'worker' } },
  status: { agentId: name, state, updatedAt: x.updatedAt || 0, needsSince: x.needsSince },
  running: true,
});

test('gridOrder: Main first, then needs you, working, starting, done, stopped', async () => {
  const L = await load();
  const list = [
    entry('stopped', 'stopped'), entry('done', 'idle'), entry('start', 'starting'), entry('work', 'working'),
    entry('needy', 'needs_you'), entry('boss', 'stopped', { role: 'main' }), entry('gone', 'exited'),
  ];
  assert.deepEqual(L.gridOrder(list).map((e) => e.agent.name), ['boss', 'needy', 'work', 'start', 'done', 'stopped', 'gone']);
});

test('gridOrder: Main stays first even while it works; longest-waiting needs-you first; ties are stable', async () => {
  const L = await load();
  const list = [
    entry('b', 'working', { createdAt: 2, updatedAt: 999 }), entry('a', 'working', { createdAt: 1, updatedAt: 1 }),
    entry('n2', 'needs_you', { needsSince: 50 }), entry('n1', 'needs_you', { needsSince: 10 }),
    entry('m', 'working', { role: 'main' }),
  ];
  assert.deepEqual(L.gridOrder(list).map((e) => e.agent.name), ['m', 'n1', 'n2', 'a', 'b']);
  // "updated" does not reorder tiles
  list[0].status.updatedAt = 5000;
  assert.deepEqual(L.gridOrder(list).map((e) => e.agent.name), ['m', 'n1', 'n2', 'a', 'b']);
  assert.deepEqual(L.gridOrder([]), []);
});

test('boardColumns: starting joins Working, exited joins Stopped', async () => {
  const L = await load();
  assert.deepEqual(L.BOARD_COLUMNS.map((c) => c.label), ['Needs you', 'Working', 'Done', 'Stopped']);
  const cols = L.boardColumns([
    entry('a', 'needs_you'), entry('b', 'working'), entry('c', 'starting'), entry('d', 'idle'), entry('e', 'stopped'), entry('f', 'exited'),
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.map((e) => e.agent.name).sort()])), {
    needs: ['a'], working: ['b', 'c'], done: ['d'], stopped: ['e', 'f'],
  });
  assert.equal(L.boardColumnOf('exited'), 'stopped');
  assert.equal(L.boardColumnOf('???'), 'stopped');
});

test('groupBySpace: spaces that need you first, empty spaces dropped, unknown spaces kept', async () => {
  const L = await load();
  const spaces = [{ id: 's1', name: 'One' }, { id: 's2', name: 'Two' }, { id: 's3', name: 'Three' }, { id: 's4', name: 'Empty' }];
  const groups = L.groupBySpace([
    entry('a', 'idle', { spaceId: 's1' }), entry('b', 'working', { spaceId: 's2' }), entry('c', 'needs_you', { spaceId: 's3' }),
    entry('d', 'needs_you', { spaceId: 's3' }), entry('e', 'idle', { spaceId: 'ghost' }), entry('f', 'needs_you', { spaceId: 's2' }),
  ], spaces);
  assert.deepEqual(groups.map((g) => g.space.id), ['s3', 's2', 's1', 'ghost']);
  assert.deepEqual(groups[1].entries.map((e) => e.agent.name), ['f', 'b']);
  assert.equal(groups[3].space.name, 'ghost');
});

test('tailLines drops trailing blanks and keeps the last lines', async () => {
  const L = await load();
  assert.deepEqual(L.tailLines(['a', 'b  ', '', '  ', '']), ['a', 'b']);
  assert.deepEqual(L.tailLines(['1', '2', '3', '4'], 2), ['3', '4']);
  assert.deepEqual(L.tailLines([]), []);
});
