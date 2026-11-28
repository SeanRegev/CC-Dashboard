'use strict';
// Contract v4 groundwork (lead): POST /statusline and usage.get are routed. Track A fills in what they do
// (tests/core/statusline*.test.js); these only pin the routing and the token rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startCore, tempHome, rmrf } = require('./helpers');

const SAMPLE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'statusline', 'sample.json'), 'utf8');

/** @param {any} core @param {string} agentId @param {string} body @param {string} [token] */
async function postStatusLine(core, agentId, body, token = core.info.token) {
  const res = await fetch(`http://127.0.0.1:${core.info.port}/statusline?agent=${encodeURIComponent(agentId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-cc-token': token } : {}) }, body,
  });
  return { status: res.status, body: await res.json() };
}

test('POST /statusline: token required, unknown agent 404, known agent 200', async (t) => {
  const core = await startCore();
  const dir = tempHome();
  t.after(async () => { await core.dispose(); rmrf(dir); });
  assert.equal((await postStatusLine(core, 'x', SAMPLE, '')).status, 401);
  assert.equal((await postStatusLine(core, 'x', SAMPLE, 'nope')).status, 401);
  assert.deepEqual(await postStatusLine(core, 'nobody', SAMPLE), { status: 404, body: { ok: false } });
  const space = await core.client.call('spaces.add', { path: dir });
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'a' });
  assert.deepEqual(await postStatusLine(core, agent.id, SAMPLE), { status: 200, body: { ok: true } });
  // Junk never breaks it.
  assert.equal((await postStatusLine(core, agent.id, 'not json')).status, 200);
  assert.equal((await postStatusLine(core, agent.id, '"a string"')).status, 200);
});

test('usage.get answers a Usage', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const u = await core.client.call('usage.get', {});
  assert.equal(typeof u.limits, 'object');
  assert.equal(typeof u.limits.updatedAt, 'number');
  for (const k of ['byAgent', 'bySpace', 'byDay']) assert.equal(typeof u[k], 'object', k);
  assert.equal(typeof u.updatedAt, 'number');
});
