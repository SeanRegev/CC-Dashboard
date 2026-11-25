'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startCore, tempHome, rmrf, waitFor, readJson } = require('./helpers');

async function setup(home) {
  const core = await startCore({ home });
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'Keeper', prompt: 'remember me' });
  await core.waitStatus(agent.id, (x) => x.state === 'idle' && x.counts.turns === 1);
  return { core, space, agent };
}

function checkRestored(rows, spaces, space, agent) {
  assert.deepEqual(spaces, [space]);
  assert.equal(rows.length, 1);
  const { agent: a, status: s, running } = rows[0];
  assert.deepEqual(a, agent);
  assert.equal(running, false);
  assert.equal(s.state, 'stopped'); // its process is gone
  assert.equal(s.lastPrompt, 'remember me');
  assert.equal(s.counts.turns, 1);
  assert.equal(s.usage.total, 510);
  assert.deepEqual(s.history.map(([, st]) => st).slice(-2), ['idle', 'stopped']);
}

test('spaces, agents and last known status survive a clean core restart', async (t) => {
  const home = tempHome();
  const { core, space, agent } = await setup(home);
  await core.stop('SIGTERM');
  const again = await startCore({ home });
  t.after(async () => { await again.stop(); rmrf(home); });
  checkRestored(await again.client.call('agents.list'), await again.client.call('spaces.list'), space, agent);
  // It can be resumed in the new core.
  await again.client.call('agents.resume', { id: agent.id });
  await again.waitStatus(agent.id, (x) => x.state === 'idle' && x.running, 'resumed');
});

test('state survives a hard kill of the core (atomic snapshots on disk)', async (t) => {
  const home = tempHome();
  const { core, space, agent } = await setup(home);
  // Snapshots are written shortly after each change; wait until the idle status is on disk.
  await waitFor(() => {
    const st = readJson(path.join(home, 'state.json'));
    return st && st.status[agent.id] && st.status[agent.id].state === 'idle' && st.status[agent.id].counts.turns === 1;
  }, { what: 'snapshot' });
  await core.stop('SIGKILL');
  const again = await startCore({ home });
  t.after(async () => { await again.stop(); rmrf(home); });
  checkRestored(await again.client.call('agents.list'), await again.client.call('spaces.list'), space, agent);
});
