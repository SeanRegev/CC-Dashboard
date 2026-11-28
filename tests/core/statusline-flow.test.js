'use strict';
// M4 track A, end to end: a real core, the fake Claude running the registered statusLine command (the relay),
// the user's own status line from a temp CLAUDE_CONFIG_DIR, and usage.json across a core restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startCore, tempHome, rmrf, waitFor, readJson } = require('./helpers');

/** What the fake Claude saw its status-line command print. @param {string} home @param {string} sessionId */
function statusLog(home, sessionId) {
  try {
    return fs.readFileSync(path.join(home, `statusline-${sessionId}.log`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test('the relay shows the user\'s own status line and feeds the exact context % and the account usage', async (t) => {
  const home = tempHome();
  const core = await startCore({ home });
  t.after(async () => { await core.stop(); rmrf(home); });
  // The user's status line, in the (temp) Claude config dir, with a display option of its own.
  const config = core.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(config, { recursive: true });
  const script = path.join(home, 'my-line.js').replace(/\\/g, '/');
  fs.writeFileSync(script, "let s='';process.stdin.on('data',(d)=>{s+=d}).on('end',()=>{const p=JSON.parse(s);"
    + "process.stdout.write('MINE '+p.model.display_name+' '+p.context_window.used_percentage+'\\n')})");
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `node "${script}"`, padding: 1 } }));
  const changed = core.collect('usage.changed');

  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'Meter' });
  // At start (like real Claude, before any reply): the user's line, and the window from the status line.
  await waitFor(() => statusLog(home, agent.sessionId).length >= 1, { what: 'startup status line', timeout: 15000 });
  const first = statusLog(home, agent.sessionId)[0];
  assert.equal(first.stdout, 'MINE Haiku 5.5 null\n');
  assert.equal(first.code, 0);
  assert.equal(first.stderr, '');
  let s = await core.waitStatus(agent.id, (x) => x.usage && x.usage.contextWindow === 1000000, 'window from the startup status line');
  assert.equal(s.usage.source, 'transcript');
  // Our settings carry the user's padding (their own file was not touched).
  const ours = fs.readdirSync(home).filter((f) => /^hooks-settings-.*\.json$/.test(f)).map((f) => readJson(path.join(home, f)));
  assert.ok(ours.some((o) => o.statusLine && o.statusLine.padding === 1 && /cc-statusline/.test(o.statusLine.command)), JSON.stringify(ours));
  assert.deepEqual(readJson(path.join(config, 'settings.json')).statusLine.padding, 1);

  // After a "reply": Claude's own %, the cost, and the account limits.
  await core.client.call('agents.send', { id: agent.id, text: 'statusline:25' });
  s = await core.waitStatus(agent.id, (x) => x.usage && x.usage.source === 'statusline', 'status-line usage', 15000);
  assert.equal(s.usage.contextPct, 25);
  assert.equal(s.usage.context, 250000);
  assert.equal(s.usage.costUsd, 0.01);
  assert.equal(s.usage.model, 'claude-haiku-5-5');
  await waitFor(() => statusLog(home, agent.sessionId).some((l) => l.stdout === 'MINE Haiku 5.5 25\n'), { what: 'prompted line' });
  await core.client.call('agents.send', { id: agent.id, text: 'statusline:30' });
  await core.waitStatus(agent.id, (x) => x.usage.contextPct === 30, 'second update', 15000);
  const u = await core.client.call('usage.get', {});
  assert.equal(u.limits.fiveHour.usedPct, 62);
  assert.equal(u.limits.fromAgentId, agent.id);
  assert.deepEqual(u.byAgent[agent.id], { costUsd: 0.02, inputTokens: 2000, outputTokens: 200, name: 'Meter', spaceId: space.id });
  assert.deepEqual(u.bySpace[space.id], { costUsd: 0.02, inputTokens: 2000, outputTokens: 200 });
  await waitFor(() => changed.some((c) => c.usage.byAgent[agent.id] && c.usage.byAgent[agent.id].costUsd === 0.02), { what: 'usage.changed' });

  // usage.json is on disk soon (a hard kill on Windows gives no time to flush) and survives a restart.
  await waitFor(() => {
    const d = readJson(path.join(home, 'usage.json'));
    return d && d.byAgent && d.byAgent[agent.id] && d.byAgent[agent.id].costUsd === 0.02;
  }, { what: 'usage.json' });
  await core.stop();
  const again = await startCore({ home });
  t.after(() => again.stop());
  const u2 = await again.client.call('usage.get', {});
  assert.deepEqual(u2.byAgent[agent.id], u.byAgent[agent.id]);
  assert.equal(u2.limits.fiveHour.usedPct, 62);
});

test('without a status line of their own: the default line; a resumed process is not counted twice', async (t) => {
  const core = await startCore();
  t.after(() => core.dispose());
  const space = await core.space();
  const agent = await core.client.call('agents.create', { spaceId: space.id, name: 'Plain' });
  await waitFor(() => statusLog(core.home, agent.sessionId).length >= 1, { what: 'startup status line', timeout: 15000 });
  assert.equal(statusLog(core.home, agent.sessionId)[0].stdout, 'Haiku 5.5\n');
  await core.client.call('agents.send', { id: agent.id, text: 'statusline:10' });
  await waitFor(() => statusLog(core.home, agent.sessionId).some((l) => l.stdout === 'Haiku 5.5 · ctx 10% · 5h 62%\n'), { what: 'default line' });
  await core.client.call('agents.send', { id: agent.id, text: 'statusline:11' });
  await waitFor(async () => {
    const u = await core.client.call('usage.get', {});
    return u.byAgent[agent.id] && u.byAgent[agent.id].costUsd === 0.02;
  }, { what: 'cost after two updates' });
  // A new process (restart): its counters start again from 0; only what it adds counts.
  await core.client.call('agents.restart', { id: agent.id });
  await waitFor(() => statusLog(core.home, agent.sessionId).filter((l) => l.pct === null).length >= 2, { what: 'restarted status line', timeout: 15000 });
  await core.client.call('agents.send', { id: agent.id, text: 'statusline:12' });
  await core.waitStatus(agent.id, (x) => x.usage.contextPct === 12, 'update after restart', 15000);
  await waitFor(async () => {
    const u = await core.client.call('usage.get', {});
    return u.byAgent[agent.id].costUsd === 0.03 ? u : null;
  }, { what: 'cost after the restart' });
});
