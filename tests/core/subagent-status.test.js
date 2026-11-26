'use strict';
// Pure tests: the session's status while it has subagents (status.js, v3 rules).
const test = require('node:test');
const assert = require('node:assert/strict');
const { newStatus, newRuntime, applyEvent, withState, restingStatus, subagentsDetail, isTaskNotification } = require('../../packages/core/src/status');

const SUB = 'ae0d14e7ad2db2bf5';

/** Feed [event, payload, subagents?] through applyEvent. */
function run(events, start = { status: newStatus('a', 0), rt: newRuntime() }) {
  let cur = start;
  let now = 1000;
  for (const [event, payload, subagents] of events) {
    cur = applyEvent(cur.status, cur.rt, event, payload || {}, (now += 1000), subagents ? { subagents } : {});
  }
  return cur;
}

const one = { running: 1, total: 1 };
const none = { running: 0, total: 1 };

test('subagent tools do not overwrite the session tool / detail or count in counts.tools', () => {
  const { status: s } = run([
    ['UserPromptSubmit', { prompt: 'go' }],
    ['PreToolUse', { tool_name: 'Agent', tool_input: { description: 'Count files here' } }],
    ['SubagentStart', { agent_id: SUB, agent_type: 'general-purpose' }, one],
    ['PreToolUse', { agent_id: SUB, tool_name: 'Bash', tool_input: { command: 'ls' } }, one],
    ['PostToolUse', { agent_id: SUB, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { is_error: true } }, one],
    ['PostToolUse', { agent_id: SUB, tool_name: 'Edit', tool_input: { file_path: 'x.js' } }, one],
  ]);
  assert.equal(s.state, 'working');
  assert.equal(s.tool, 'Agent');
  assert.equal(s.detail, 'Count files here');
  assert.equal(s.counts.tools, 0);
  assert.equal(s.counts.errors, 0);
  assert.deepEqual(s.files, ['x.js'], 'files a subagent edits are still the session\'s files');
  assert.deepEqual(s.subagents, one);
});

test('after Stop with a background subagent running: working, "1 subagent running", then idle when it ends', () => {
  let cur = run([
    ['UserPromptSubmit', { prompt: 'go' }],
    ['SubagentStart', { agent_id: SUB, agent_type: 'general-purpose' }, one],
    ['Stop', {}, one],
  ]);
  assert.equal(cur.status.state, 'working');
  assert.equal(cur.status.detail, '1 subagent running');
  assert.equal(cur.status.counts.turns, 1);
  assert.ok(cur.rt.doneFrom > 0, 'the done notification waits');
  assert.equal(cur.rt.turnStartedAt, 0);
  cur = run([['PreToolUse', { agent_id: SUB, tool_name: 'Read', tool_input: { file_path: 'a.txt' } }, one]], cur);
  assert.equal(cur.status.detail, '1 subagent running');
  cur = run([['SubagentStop', { agent_id: SUB }, none]], cur);
  assert.equal(cur.status.state, 'idle');
  assert.equal(cur.status.tool, '');
  assert.equal(cur.status.detail, '');
  assert.equal(cur.rt.doneFrom, 0);
  assert.deepEqual(cur.status.history.map(([, x]) => x).slice(-2), ['working', 'idle']);
});

test('two running: the detail counts down; a new turn keeps it working', () => {
  const two = { running: 2, total: 2 };
  let cur = run([['UserPromptSubmit', { prompt: 'go' }], ['Stop', {}, two]]);
  assert.equal(cur.status.detail, '2 subagents running');
  cur = run([['SubagentStop', { agent_id: 'x1' }, { running: 1, total: 2 }]], cur);
  assert.equal(cur.status.state, 'working');
  assert.equal(cur.status.detail, '1 subagent running');
  // The user starts a new turn: the last SubagentStop must not make it idle mid-turn.
  cur = run([['UserPromptSubmit', { prompt: 'more' }], ['SubagentStop', { agent_id: 'x2' }, { running: 0, total: 2 }]], cur);
  assert.equal(cur.status.state, 'working');
  assert.equal(cur.status.lastPrompt, 'more');
});

test('a <task-notification> turn is not the user\'s prompt: lastPrompt kept, doneFrom kept', () => {
  let cur = run([['UserPromptSubmit', { prompt: 'real task' }], ['Stop', {}, { running: 2, total: 2 }]]);
  const doneFrom = cur.rt.doneFrom;
  cur = run([['SubagentStop', { agent_id: 'x1' }, { running: 1, total: 2 }],
    ['UserPromptSubmit', { prompt: '<task-notification>\n<task-id>x1</task-id></task-notification>' }, { running: 1, total: 2 }]], cur);
  assert.equal(cur.status.lastPrompt, 'real task');
  assert.equal(cur.status.state, 'working');
  assert.equal(cur.rt.doneFrom, doneFrom);
  cur = run([['Stop', {}, { running: 1, total: 2 }]], cur);
  assert.equal(cur.rt.doneFrom, doneFrom, 'still the first turn\'s start');
  assert.equal(cur.status.detail, '1 subagent running');
  assert.ok(isTaskNotification('  <task-notification>x'));
  assert.ok(!isTaskNotification('please read <task-notification>'));
});

test('a permission prompt from a subagent sets askedBy; only that subagent\'s events clear it', () => {
  let cur = run([
    ['UserPromptSubmit', { prompt: 'go' }],
    ['PreToolUse', { tool_name: 'Agent', tool_input: { description: 'd' } }],
    ['PermissionRequest', { agent_id: SUB, tool_name: 'Bash', tool_input: { command: 'rm x' } }, one],
  ]);
  assert.equal(cur.status.state, 'needs_you');
  assert.equal(cur.status.askedBy, SUB);
  assert.equal(cur.status.message, 'Wants to use Bash: rm x');
  assert.equal(cur.status.tool, 'Agent', 'the session tool is kept');
  // Another subagent and the session go on: the prompt is still up.
  cur = run([['PostToolUse', { agent_id: 'other', tool_name: 'Read' }, one], ['PostToolUse', { tool_name: 'Read' }, one]], cur);
  assert.equal(cur.status.state, 'needs_you');
  assert.equal(cur.status.askedBy, SUB);
  // Stop of the session while a subagent asks: still needs you.
  cur = run([['Stop', {}, one]], cur);
  assert.equal(cur.status.state, 'needs_you');
  // The asking subagent's tool runs: answered.
  cur = run([['PostToolUse', { agent_id: SUB, tool_name: 'Bash' }, one]], cur);
  assert.equal(cur.status.state, 'working');
  assert.equal(cur.status.askedBy, undefined);
  assert.equal(cur.status.permission, undefined);
});

test('the session\'s own prompt clears askedBy; leaving needs_you (approve) clears it too', () => {
  let cur = run([['PermissionRequest', { agent_id: SUB, tool_name: 'Bash' }, one], ['PermissionRequest', { tool_name: 'Edit' }, one]]);
  assert.equal(cur.status.askedBy, undefined);
  cur = run([['PermissionRequest', { agent_id: SUB, tool_name: 'Bash' }, one]], cur);
  assert.equal(withState(cur.status, 'working').askedBy, undefined);
});

test('a subagent that asked and then ended takes its prompt with it', () => {
  let cur = run([['UserPromptSubmit', { prompt: 'go' }], ['Stop', {}, one], ['PermissionRequest', { agent_id: SUB, tool_name: 'Bash' }, one]]);
  assert.equal(cur.status.state, 'needs_you');
  cur = run([['SubagentStop', { agent_id: SUB }, none]], cur);
  assert.equal(cur.status.state, 'idle');
  assert.equal(cur.status.askedBy, undefined);
});

test('restingStatus: idle, or working while background subagents run', () => {
  const s = withState(newStatus('a', 0), 'needs_you', { permission: true, askedBy: SUB, message: 'x' });
  const idle = restingStatus(s, { running: 0, total: 2 }, 5);
  assert.equal(idle.state, 'idle');
  assert.equal(idle.askedBy, undefined);
  assert.deepEqual(idle.subagents, { running: 0, total: 2 });
  const busy = restingStatus(s, { running: 2, total: 2 }, 5);
  assert.equal(busy.state, 'working');
  assert.equal(busy.detail, subagentsDetail(2));
  assert.equal(busy.permission, undefined);
});

test('without subagents nothing changes: a plain turn ends idle, SubagentStop mid-turn stays working', () => {
  const { status: s } = run([['UserPromptSubmit', { prompt: 'p' }], ['SubagentStop'], ['Stop']]);
  assert.equal(s.state, 'idle');
  assert.deepEqual(s.subagents, { running: 0, total: 0 });
  const mid = run([['UserPromptSubmit', { prompt: 'p' }], ['SubagentStop', {}, { running: 0, total: 1 }]]);
  assert.equal(mid.status.state, 'working');
});
