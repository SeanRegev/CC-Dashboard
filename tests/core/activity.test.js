'use strict';
// Pure tests for the activity log and subagent tracking (activity.js SessionLog), fed with the real
// hook payloads in tests/fixtures/hooks/ and small hand-made sequences. No core, no processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { MAX_SUBAGENTS, SessionLog, parseTaskNotification, metaPath, fileBase, typeLabel, toolFailed, parseLines } = require('../../packages/core/src/activity');
const { tempHome, rmrf } = require('./helpers');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'hooks', 'subagent-background.jsonl');
const META_SAMPLE = path.join(__dirname, '..', 'fixtures', 'sessions', 'subagents-meta', 'agent-ae0d14e7ad2db2bf5.meta.json');
const SUB = 'ae0d14e7ad2db2bf5';

function fixture() {
  return fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

/** Feed [event, payload] pairs; returns the log and every entry made. */
function feed(log, events, start = 1000) {
  let now = start;
  const entries = [];
  const changed = new Set();
  for (const [event, payload] of events) {
    const out = log.apply(event, payload || {}, (now += 1000));
    entries.push(...out.entries);
    for (const id of out.changed) changed.add(id);
  }
  return { entries, changed };
}

const agentPre = (id, description, type = 'general-purpose', extra = {}) => ['PreToolUse', {
  tool_name: 'Agent', tool_use_id: id, tool_input: { description, subagent_type: type, prompt: 'do it', ...extra },
}];
const start = (id, type = 'general-purpose', extra = {}) => ['SubagentStart', { agent_id: id, agent_type: type, ...extra }];

test('the real fixture: every hook becomes an entry, the subagent gets its title and ends done', () => {
  const log = new SessionLog('main');
  const { entries } = feed(log, fixture().map(({ ev, p }) => [ev, p]));
  assert.deepEqual(entries.map((e) => [e.kind, e.subagentId ? 'sub' : '']), [
    ['session_start', ''], ['prompt', ''], ['tool', ''], ['tool_done', ''], ['subagent_start', 'sub'], ['tool', 'sub'],
    ['turn_end', ''], ['tool_done', 'sub'], ['tool', 'sub'], ['tool_done', 'sub'], ['subagent_end', 'sub'],
    ['notice', ''], ['turn_end', ''], ['session_end', ''],
  ]);
  assert.deepEqual(entries.map((e) => e.seq), entries.map((_, i) => i + 1));
  assert.equal(entries[0].text, 'startup');
  assert.equal(entries[2].tool, 'Agent');
  assert.equal(entries[2].detail, 'Count files here');
  assert.equal(entries[3].ms, 15, 'duration_ms from the payload');
  assert.deepEqual([entries[4].text, entries[4].type, entries[4].subagentId], ['Count files here', 'general-purpose', SUB]);
  assert.deepEqual([entries[5].tool, entries[5].detail], ['Bash', 'ls']);
  assert.equal(entries[7].ms, 50);
  assert.equal(entries[8].detail, '<CWD>/a.txt');
  assert.match(entries[10].text, /^\*\*1\. `ls` output\*\*/);
  assert.equal(entries[11].text, 'Subagent finished: Count files here');
  assert.match(entries[6].text, /^The subagent is running in the background/);
  assert.equal(entries[13].text, 'other');
  // Never tool responses or file contents.
  const json = JSON.stringify(entries);
  for (const leak of ['numLines', 'canReadOutputFile', 'outputFile', 'stdout', 'isAsync']) assert.ok(!json.includes(leak), leak);

  const [sub] = log.list();
  assert.equal(sub.id, SUB);
  assert.equal(sub.agentId, 'main');
  assert.equal(sub.title, 'Count files here');
  assert.equal(sub.type, 'general-purpose');
  assert.equal(sub.state, 'done');
  assert.equal(sub.background, true, 'PostToolUse said isAsync');
  assert.deepEqual(sub.counts, { tools: 2, errors: 0 });
  assert.match(sub.summary, /hello/);
  assert.ok(sub.endedAt && sub.endedAt >= sub.startedAt);
  assert.deepEqual(log.counts(), { running: 0, total: 1 });
});

test('subagent tool and detail follow its tools; PostToolUse clears them', () => {
  const log = new SessionLog('a');
  feed(log, [agentPre('t1', 'Find call sites', 'Explore'), start('s1', 'Explore'),
    ['PreToolUse', { agent_id: 's1', tool_name: 'Grep', tool_input: { pattern: 'verifyToken' }, tool_use_id: 'g1' }]]);
  assert.deepEqual([log.get('s1').tool, log.get('s1').detail], ['Grep', 'verifyToken']);
  feed(log, [['PostToolUse', { agent_id: 's1', tool_name: 'Grep', tool_use_id: 'g1', tool_response: { is_error: true } }]]);
  const s = log.get('s1');
  assert.deepEqual([s.tool, s.detail], ['', '']);
  assert.deepEqual(s.counts, { tools: 1, errors: 1 });
  assert.equal(s.title, 'Find call sites');
});

test('ms is measured by tool_use_id when the payload has no duration_ms', () => {
  const log = new SessionLog('a');
  log.apply('PreToolUse', { tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'npm test' } }, 1000);
  const out = log.apply('PostToolUse', { tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'npm test' }, tool_response: { interrupted: true } }, 3500);
  assert.deepEqual(out.entries.map((e) => [e.kind, e.ms, e.detail]), [['tool_error', 2500, 'npm test']]);
  // Unknown start, no duration: no ms at all.
  const lone = log.apply('PostToolUse', { tool_name: 'Read', tool_use_id: 'y' }, 4000);
  assert.equal(lone.entries[0].ms, undefined);
});

test('titles: the oldest queued call of the same type, else the oldest', () => {
  const log = new SessionLog('a');
  feed(log, [
    agentPre('t1', 'Map fixtures', 'Explore'),
    agentPre('t2', 'Plan the fix', 'Plan'),
    agentPre('t3', 'Second explore', 'Explore'),
    start('p1', 'Plan'), start('e1', 'Explore'), start('e2', 'Explore'),
  ]);
  assert.deepEqual(log.list().map((s) => [s.id, s.title]), [['p1', 'Plan the fix'], ['e1', 'Map fixtures'], ['e2', 'Second explore']]);
  // A plugin type that matches no queued call takes the oldest one.
  const other = new SessionLog('b');
  feed(other, [agentPre('t1', 'First', 'Explore'), agentPre('t2', 'Second', 'Plan'), start('x', 'my-plugin:reviewer')]);
  assert.equal(other.get('x').title, 'First');
  assert.equal(other.get('x').type, 'my-plugin:reviewer');
});

test('titles: PostToolUse(Agent) with agentId pairs it before SubagentStart, and corrects a wrong pairing', () => {
  const log = new SessionLog('a');
  // Background: the result comes at once, before SubagentStart, naming the agent.
  feed(log, [agentPre('t1', 'Alpha'), agentPre('t2', 'Beta'),
    ['PostToolUse', { tool_name: 'Agent', tool_use_id: 't2', tool_response: { isAsync: true, status: 'async_launched', agentId: 'b' } }],
    start('a1'), start('b')]);
  assert.equal(log.get('b').title, 'Beta');
  assert.equal(log.get('b').background, true);
  assert.equal(log.get('a1').title, 'Alpha');

  // Foreground: two of the same type start in the other order; their results swap the titles.
  const fg = new SessionLog('c');
  feed(fg, [agentPre('t1', 'One'), agentPre('t2', 'Two'), start('y'), start('x')]);
  assert.deepEqual([fg.get('y').title, fg.get('x').title], ['One', 'Two']);
  const { changed } = feed(fg, [['PostToolUse', { tool_name: 'Agent', tool_use_id: 't1', tool_response: { status: 'completed', agentId: 'x' } }]]);
  assert.deepEqual([fg.get('x').title, fg.get('y').title], ['One', 'Two']);
  assert.ok(changed.has('x') && changed.has('y'));
  assert.equal(fg.get('x').state, 'done', 'a foreground result means it is over');
  assert.equal(fg.get('x').background, false);
});

test('titles: meta.json when no Agent call was seen, tried again on a later event', (t) => {
  const home = tempHome();
  t.after(() => rmrf(home));
  const session = '00000000-0000-4000-8000-000000000001';
  const transcript = path.join(home, 'projects', 'proj', `${session}.jsonl`);
  const base = { session_id: session, transcript_path: transcript };
  const log = new SessionLog('a');
  feed(log, [start(SUB, 'general-purpose', base)]);
  assert.equal(log.get(SUB).title, 'General', 'the type label until meta.json shows up');
  const file = metaPath(transcript, session, SUB);
  assert.equal(file, path.join(home, 'projects', 'proj', session, 'subagents', `agent-${SUB}.meta.json`));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(META_SAMPLE, file);
  const { changed } = feed(log, [['PreToolUse', { ...base, agent_id: SUB, tool_name: 'Bash', tool_input: { command: 'ls' } }]]);
  assert.ok(changed.has(SUB));
  assert.equal(log.get(SUB).title, 'Count files here');
  assert.equal(log.get(SUB).background, true, 'requestShape: background');
  // Already there at SubagentStart: used at once.
  const log2 = new SessionLog('b');
  const { entries } = feed(log2, [start(SUB, 'general-purpose', base)]);
  assert.equal(entries[0].text, 'Count files here');
  // Ids that don't look like Claude's never become paths.
  assert.equal(metaPath(transcript, '../x', SUB), '');
  assert.equal(metaPath(transcript, session, '..\\..\\x'), '');
});

test('titles: background_tasks of a later Stop, else the task notification, else the type label', () => {
  const log = new SessionLog('a');
  feed(log, [start('s1', 'Explore'), start('s2', 'Plan'), start('s3', 'odd-type')]);
  assert.deepEqual(log.list().map((s) => s.title), ['Explore', 'Plan', 'odd-type']);
  feed(log, [['Stop', { background_tasks: [{ id: 's1', type: 'subagent', status: 'running', description: 'Look around', agent_type: 'Explore' },
    { id: 'shell1', type: 'shell', description: 'npm run dev' }] }]]);
  assert.equal(log.get('s1').title, 'Look around');
  assert.equal(log.get('s1').background, true);
  // s2 and s3 were not in the list: their turn ended without them (stopped).
  assert.equal(log.get('s2').state, 'stopped');
  feed(log, [['UserPromptSubmit', { prompt: '<task-notification>\n<task-id>s2</task-id>\n<status>completed</status>\n<summary>Agent "Plan it" finished</summary>\n</task-notification>' }]]);
  assert.equal(log.get('s2').title, 'Plan it');
  assert.equal(typeLabel('statusline-setup'), 'Status line');
  assert.equal(typeLabel(''), 'Subagent');
});

test('task notifications: failed and killed', () => {
  const log = new SessionLog('a');
  feed(log, [agentPre('t1', 'Flaky run', 'general-purpose', { run_in_background: true }), start('f'), start('k')]);
  assert.equal(log.get('f').background, true, 'run_in_background');
  const { entries } = feed(log, [
    ['UserPromptSubmit', { prompt: '<task-notification><task-id>f</task-id><status>failed</status><result>npm test exited 1</result></task-notification>' }],
    ['UserPromptSubmit', { prompt: '<task-notification><task-id>k</task-id><status>killed</status></task-notification>' }],
  ]);
  assert.equal(log.get('f').state, 'failed');
  assert.equal(log.get('f').summary, 'npm test exited 1');
  assert.equal(log.get('k').state, 'stopped');
  assert.deepEqual(entries.map((e) => [e.kind, e.text, e.subagentId]), [
    ['notice', 'Subagent failed: Flaky run', ''], ['notice', 'Subagent stopped: General', ''],
  ]);
  const tn = parseTaskNotification(fixture().find((l) => l.ev === 'UserPromptSubmit' && l.p.prompt.startsWith('<task')).p.prompt);
  assert.deepEqual([tn.taskId, tn.toolUseId, tn.status, tn.title], [SUB, 'toolu_01PuLytW4FeEwpS7LGCzihRc', 'completed', 'Count files here']);
  assert.equal(parseTaskNotification('hello'), null);
});

test('failed: the Agent call\'s PostToolUse says so', () => {
  const log = new SessionLog('a');
  feed(log, [agentPre('t1', 'Broken'), start('s1'),
    ['PostToolUse', { tool_name: 'Agent', tool_use_id: 't1', tool_response: { status: 'error', is_error: true } }]]);
  assert.equal(log.get('s1').state, 'failed');
  assert.ok(toolFailed({ is_error: true }) && toolFailed({ status: 'failed' }) && !toolFailed({ status: 'completed' }) && !toolFailed('Error'));
});

test('needsYou: set by its PermissionRequest, cleared by its PostToolUse or by syncAsked', () => {
  const log = new SessionLog('a');
  feed(log, [start('s1'), start('s2'), ['PermissionRequest', { agent_id: 's1', tool_name: 'Bash', tool_input: { command: 'rm x' } }]]);
  assert.equal(log.get('s1').needsYou, true);
  assert.deepEqual([log.get('s1').tool, log.get('s1').detail], ['Bash', 'rm x']);
  // A prompt from s2 replaces it.
  feed(log, [['PermissionRequest', { agent_id: 's2', tool_name: 'Edit' }]]);
  assert.equal(log.get('s1').needsYou, false);
  assert.equal(log.get('s2').needsYou, true);
  // The prompt on screen is now the session's own, or none: cleared.
  assert.deepEqual([...log.syncAsked('s2')], []);
  assert.deepEqual([...log.syncAsked('')], ['s2']);
  assert.equal(log.get('s2').needsYou, false);
  feed(log, [['PermissionRequest', { agent_id: 's1', tool_name: 'Bash' }], ['PostToolUse', { agent_id: 's1', tool_name: 'Bash' }]]);
  assert.equal(log.get('s1').needsYou, false);
});

test('stopped: SessionEnd, a new process, a new user prompt (foreground only), stopAll / stopForeground', () => {
  const log = new SessionLog('a');
  feed(log, [agentPre('t1', 'bg', 'general-purpose', { run_in_background: true }), start('bg'), start('fg')]);
  feed(log, [['UserPromptSubmit', { prompt: 'next' }]]);
  assert.deepEqual(log.list().map((s) => s.state), ['running', 'stopped']);
  feed(log, [['SessionEnd', { reason: 'exit' }]]);
  assert.deepEqual(log.list().map((s) => s.state), ['stopped', 'stopped']);
  // Working again: revived by a new action.
  feed(log, [['PreToolUse', { agent_id: 'bg', tool_name: 'Read' }]]);
  assert.equal(log.get('bg').state, 'running');
  assert.equal(log.get('bg').endedAt, undefined);
  feed(log, [['SessionStart', { source: 'resume' }]]);
  assert.equal(log.get('bg').state, 'stopped');
  feed(log, [start('fg2'), ['PreToolUse', { agent_id: 'bg', tool_name: 'Read' }]]);
  assert.deepEqual([...log.stopForeground()], ['fg2']);
  assert.equal(log.get('bg').state, 'running');
  assert.deepEqual([...log.stopAll()], ['bg']);
  // A late PostToolUse of a stopped one does not revive it.
  feed(log, [['PostToolUse', { agent_id: 'bg', tool_name: 'Read' }]]);
  assert.equal(log.get('bg').state, 'stopped');
});

test('a subagent first seen by a tool event (missed SubagentStart) is created; SubagentStart again restarts it', () => {
  const log = new SessionLog('a');
  const { entries } = feed(log, [['PreToolUse', { agent_id: 'z', agent_type: 'Explore', tool_name: 'Glob', tool_input: { pattern: '*.js' } }]]);
  assert.deepEqual(entries.map((e) => e.kind), ['subagent_start', 'tool']);
  assert.equal(log.get('z').type, 'Explore');
  feed(log, [['SubagentStop', { agent_id: 'z', last_assistant_message: 'x'.repeat(900) }]]);
  assert.equal(log.get('z').summary.length, 500);
  const again = feed(log, [start('z', 'Explore')]);
  assert.equal(log.get('z').state, 'running');
  assert.deepEqual(again.entries.map((e) => e.kind), ['subagent_start']);
  assert.equal(log.list().length, 1);
});

test('entries: caps, idle reminders skipped, notices, compaction; the queue is dropped at Stop', () => {
  const log = new SessionLog('a');
  const { entries } = feed(log, [
    ['UserPromptSubmit', { prompt: 'p'.repeat(800) }],
    ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'c'.repeat(800) } }],
    ['Notification', { message: 'Claude is waiting for your input' }],
    ['Notification', { message: 'Claude needs your permission to use Bash' }],
    ['PreCompact', { trigger: 'auto' }],
    agentPre('t1', 'Never started'),
    ['Stop', { last_assistant_message: 'm'.repeat(800) }],
    start('s1'),
  ]);
  assert.deepEqual(entries.map((e) => e.kind), ['prompt', 'tool', 'notice', 'notice', 'tool', 'turn_end', 'subagent_start']);
  assert.equal(entries[0].text.length, 500);
  assert.ok(entries[1].detail.length <= 300);
  assert.equal(entries[2].text, 'Claude needs your permission to use Bash');
  assert.equal(entries[3].text, 'Compacting context (auto)');
  assert.equal(entries[5].text.length, 500);
  assert.equal(log.get('s1').title, 'General', 'a call from an ended turn is not paired');
});

test('the in-memory tail keeps the newest entries', () => {
  const log = new SessionLog('a', { memTail: 5 });
  for (let i = 0; i < 12; i++) log.apply('PreToolUse', { tool_name: 'Read' }, i);
  assert.deepEqual(log.entries.map((e) => e.seq), [8, 9, 10, 11, 12]);
  assert.equal(log.firstSeq, 1);
});

test('toJSON / restore round trip; restore tolerates junk', () => {
  const log = new SessionLog('a');
  feed(log, [agentPre('t1', 'Keep me'), start('s1'), start('s2')]);
  const copy = new SessionLog('a');
  copy.restore(JSON.parse(JSON.stringify(log.toJSON())));
  assert.deepEqual(copy.list(), log.list());
  const junk = new SessionLog('a');
  junk.restore({ subagents: [null, 3, { id: '' }, { id: 'ok', state: 'weird', counts: 'x' }] });
  assert.deepEqual(junk.list().map((s) => [s.id, s.state, s.counts.tools]), [['ok', 'stopped', 0]]);
  junk.restore(null);
  junk.restore({ subagents: 'no' });
});

test('file names are safe on Windows; parseLines skips torn lines', () => {
  assert.equal(fileBase('fix-bug'), 'fix-bug');
  assert.equal(fileBase('con'), 'con_');
  assert.equal(fileBase('LPT1'), 'LPT1_');
  assert.equal(fileBase('a/b'), 'a%2fb');
  assert.deepEqual(parseLines('{"seq":1,"kind":"tool"}\n{"seq":2,"ki\n\n{"x":1}\n{"seq":3,"kind":"prompt"}').map((e) => e.seq), [1, 3]);
});

test('real interactive run: Claude\'s hidden helpers (SubagentStop, no agent_type, unknown id) are not subagents', () => {
  const file = path.join(__dirname, '..', 'fixtures', 'hooks', 'subagent-hidden-helper.jsonl');
  const events = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const hidden = events.filter(({ ev, p }) => ev === 'SubagentStop' && !p.agent_type);
  assert.equal(hidden.length, 2, 'the fixture has two hidden helper stops');
  const log = new SessionLog('main', { readMeta: () => null });
  let internal = 0;
  const entries = [];
  let now = 1000;
  for (const { ev, p } of events) {
    const out = log.apply(ev, p, (now += 1000));
    if (out.internal) internal++;
    entries.push(...out.entries);
  }
  assert.equal(internal, 2);
  assert.deepEqual(log.list().map((s) => [s.title, s.state]), [['Read a.txt', 'done']]);
  assert.deepEqual(log.counts(), { running: 0, total: 1 });
  const ids = new Set(entries.map((e) => e.subagentId).filter(Boolean));
  assert.deepEqual([...ids], [log.list()[0].id], 'no log lines for the hidden helpers');
});

test('a session that starts thousands of subagents keeps a bounded list: the oldest finished go, running ones stay', () => {
  const log = new SessionLog('main');
  const n = MAX_SUBAGENTS + 30;
  const events = [start('a-running')];
  for (let i = 0; i < n; i++) events.push(start(`a${i}`), ['SubagentStop', { agent_id: `a${i}`, agent_type: 'general-purpose' }]);
  feed(log, events);
  assert.ok(log.subagents.size <= MAX_SUBAGENTS, `kept ${log.subagents.size}`);
  assert.equal(log.titles.size, log.subagents.size, 'titles are dropped with them');
  assert.ok(log.subagents.has('a-running') && log.subagents.get('a-running').state === 'running');
  assert.ok(log.subagents.has(`a${n - 1}`), 'the newest is kept');
  assert.ok(!log.subagents.has('a0'), 'the oldest finished one is gone');
});

// ---- M4: Subagent.model ----

const metaOpts = (model) => ({ readMeta: () => ({ agentType: 'Explore', description: 'From meta', ...(model ? { model } : {}) }) });
const metaStart = (id) => ['SubagentStart', { agent_id: id, agent_type: 'Explore', transcript_path: path.join('x', 'projects', 'p', 'sess.jsonl'), session_id: 'sess' }];

test('model: the Agent call\'s tool_input.model when there is no meta.json', () => {
  const log = new SessionLog('a', { readMeta: () => null });
  feed(log, [agentPre('t1', 'Find it', 'Explore', { model: 'haiku' }), start('s1', 'Explore')]);
  assert.equal(log.get('s1').model, 'haiku');
});

test('model: meta.json wins over the Agent call', () => {
  const log = new SessionLog('a', metaOpts('claude-haiku-4-5-20251001'));
  feed(log, [agentPre('t1', 'Find it', 'Explore', { model: 'opus' }), metaStart('s1')]);
  assert.equal(log.get('s1').model, 'claude-haiku-4-5-20251001');
});

test('model: left out when neither names one', () => {
  const log = new SessionLog('a', metaOpts(''));
  feed(log, [agentPre('t1', 'Find it', 'Explore'), metaStart('s1')]);
  assert.equal('model' in log.get('s1'), false);
});

test('model: a meta.json that shows up later (title retry) sets it', () => {
  let meta = null;
  const log = new SessionLog('a', { readMeta: () => meta });
  feed(log, [metaStart('s1')]);
  assert.equal(log.get('s1').model, undefined);
  meta = { agentType: 'Explore', description: 'Late title', model: 'claude-sonnet-4-5' };
  feed(log, [['PreToolUse', { agent_id: 's1', tool_name: 'Read', tool_use_id: 'r1', tool_input: {}, transcript_path: path.join('x', 'projects', 'p', 'sess.jsonl'), session_id: 'sess' }]]);
  assert.equal(log.get('s1').title, 'Late title');
  assert.equal(log.get('s1').model, 'claude-sonnet-4-5');
});
