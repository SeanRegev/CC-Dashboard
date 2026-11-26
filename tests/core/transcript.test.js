'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../../packages/core/src/transcript');
const { rmrf } = require('./helpers');

const SESSIONS = path.join(__dirname, '..', 'fixtures', 'sessions');
const lines = (name) => T.parseJsonLines(fs.readFileSync(path.join(SESSIONS, name), 'utf8'));

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-transcript-'));
  t.after(() => rmrf(dir));
  return dir;
}

test('main transcript fixture: prompt, Agent tool call, done with ms, task notification', () => {
  const st = T.newParseState();
  const out = lines('main-transcript.jsonl').flatMap((o) => T.parseLine(o, st));
  assert.deepEqual(out.map((e) => e.kind), ['prompt', 'tool', 'tool_done', 'notice']);
  assert.match(out[0].text, /^Use the Agent\/Task tool to launch ONE/);
  assert.equal(out[1].tool, 'Agent');
  assert.equal(out[1].detail, 'Count files here');
  assert.equal(out[2].tool, 'Agent');
  assert.equal(out[2].ms, Date.parse('2026-11-26T12:28:33.990Z') - Date.parse('2026-11-26T12:28:33.883Z'));
  assert.equal(out[3].text, 'Subagent finished: Count files here');
  for (const e of out) assert.equal(e.subagentId, '');
  assert.equal(st.agentIds.get('toolu_01PuLytW4FeEwpS7LGCzihRc'), 'ae0d14e7ad2db2bf5');
  assert.deepEqual(st.agentCalls.get('toolu_01PuLytW4FeEwpS7LGCzihRc'), { description: 'Count files here', type: 'general-purpose', background: false });
  assert.equal(st.notifications[0].taskId, 'ae0d14e7ad2db2bf5');
  assert.equal(st.notifications[0].status, 'completed');
  assert.equal(st.pending.size, 0);
  assert.match(st.lastText, /^DONE/);
  assert.match(st.lastPrompt, /^Use the Agent/);
  assert.deepEqual(st.lastTool, { tool: 'Agent', detail: 'Count files here' });
});

test('subagent transcript fixture: its tools carry the subagentId, its task prompt is not a user prompt', () => {
  const st = T.newParseState();
  const out = lines('agent-ae0d14e7ad2db2bf5.jsonl').flatMap((o) => T.parseLine(o, st, { subagentId: 'ae0d14e7ad2db2bf5' }));
  assert.deepEqual(out.map((e) => [e.kind, e.tool, e.detail]), [
    ['tool', 'Bash', 'ls'], ['tool_done', 'Bash', 'ls'],
    ['tool', 'Read', '<CWD>/a.txt'], ['tool_done', 'Read', '<CWD>/a.txt'],
  ]);
  for (const e of out) assert.equal(e.subagentId, 'ae0d14e7ad2db2bf5');
  assert.equal(st.tools, 2);
  assert.match(st.lastText, /^\*\*1\. `ls` output\*\*/);
  // No tool output or file contents are kept.
  assert.ok(!JSON.stringify(out).includes('hello'));
});

test('tool errors, unknown line types, meta lines, reminders, commands, sidechain lines and junk', () => {
  const st = T.newParseState();
  const at = '2026-01-01T00:00:00.000Z';
  const objs = [
    { type: 'summary', summary: 'x' },
    { type: 'file-history-snapshot', snapshot: {} },
    { type: 'system', content: 'compacted' },
    null, 42, 'text', { type: 'user' }, { type: 'assistant', message: { content: 'not an array' } },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'user', message: { content: '<system-reminder>be nice</system-reminder>' } },
    { type: 'user', message: { content: '<local-command-stdout>ok</local-command-stdout>' } },
    { type: 'user', timestamp: at, message: { content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' } },
    { type: 'user', timestamp: at, message: { content: '<bash-input>git status</bash-input>' } },
    { type: 'user', timestamp: at, message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 's1', name: 'Bash', input: { command: 'old style' } }] } },
    { type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm   test\n --watch' } }] } },
    { type: 'user', timestamp: '2026-01-01T00:00:02.500Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'secret output' }] } },
    { type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'x' }] } },
    { type: 'user', timestamp: at, message: { content: [{ type: 'text', text: 'fix the login bug' }, { type: 'image', source: {} }] } },
  ];
  const out = objs.flatMap((o) => T.parseLine(o, st));
  assert.deepEqual(out.map((e) => [e.kind, 'tool' in e ? e.tool : e.text]), [
    ['prompt', '/clear'], ['prompt', '!git status'], ['notice', 'Interrupted by the user'],
    ['tool', 'Bash'], ['tool_error', 'Bash'], ['tool_done', ''], ['prompt', 'fix the login bug'],
  ]);
  assert.equal(out[3].detail, 'npm test --watch');
  assert.equal(out[4].ms, 2500);
  assert.equal(st.errors, 1);
  assert.equal(st.lastPrompt, 'fix the login bug');
  assert.ok(!JSON.stringify(out).includes('secret'));
});

test('caps: detail 300, text 500; a failed task notification', () => {
  const st = T.newParseState();
  const long = 'x'.repeat(2000);
  const out = [
    { type: 'user', message: { content: long } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: long } }] } },
    { type: 'user', message: { content: '<task-notification>\n<task-id>abc</task-id>\n<status>failed</status>\n<summary>Agent "Do it" failed</summary>\n</task-notification>' } },
  ].flatMap((o) => T.parseLine(o, st));
  assert.equal(out[0].text.length, 500);
  assert.ok(out[1].detail.length <= 300);
  assert.equal(out[2].text, 'Subagent failed: Do it');
});

test('projectDirName replaces every non-alphanumeric character (fixture naming)', () => {
  assert.equal(T.projectDirName('/home/user/my.proj'), '-home-user-my-proj');
  assert.equal(T.projectDirName('C:\\Users\\me\\cc dash'), 'C--Users-me-cc-dash');
});

test('findTranscript: Claude\'s folder for cwd first, then a scan of every project folder', (t) => {
  const cfg = tmp(t);
  const cwd = path.join(cfg, 'work', 'proj');
  const sid = '11111111-2222-4333-8444-555555555555';
  assert.equal(T.findTranscript(cfg, cwd, sid), '');
  const other = path.join(cfg, 'projects', 'some-other-name');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, `${sid}.jsonl`), '');
  assert.equal(T.findTranscript(cfg, cwd, sid), path.join(other, `${sid}.jsonl`));
  assert.equal(T.findTranscript(cfg, cwd, sid, { scan: false }), '');
  const direct = path.join(cfg, 'projects', T.projectDirName(cwd));
  fs.mkdirSync(direct, { recursive: true });
  fs.writeFileSync(path.join(direct, `${sid}.jsonl`), '');
  assert.equal(T.findTranscript(cfg, cwd, sid), path.join(direct, `${sid}.jsonl`));
  assert.equal(T.findTranscript(cfg, cwd, '../evil'), '');
});

test('TranscriptTail: reads only new bytes, keeps a half-written last line, survives a rewrite', (t) => {
  const dir = tmp(t);
  const f = path.join(dir, 's.jsonl');
  const tail = new T.TranscriptTail(f);
  assert.deepEqual(tail.read(), { lines: [], reset: false }); // missing file
  fs.writeFileSync(f, '{"a":1}\n{"b":');
  assert.deepEqual(tail.read().lines, [{ a: 1 }]);
  assert.deepEqual(tail.read().lines, []);
  fs.appendFileSync(f, '2}\nnot json\n{"c":"é"}\n');
  assert.deepEqual(tail.read().lines, [{ b: 2 }, { c: 'é' }]);
  fs.writeFileSync(f, '{"d":4}\n');
  assert.deepEqual(tail.read(), { lines: [{ d: 4 }], reset: true });
});

test('TranscriptTail: a huge file is read from near its end; a multi-byte character split across reads is kept whole', (t) => {
  const dir = tmp(t);
  const f = path.join(dir, 'big.jsonl');
  const line = (i) => JSON.stringify({ i, pad: 'ü'.repeat(20) }) + '\n';
  let text = '';
  for (let i = 0; i < 200; i++) text += line(i);
  fs.writeFileSync(f, text);
  const tail = new T.TranscriptTail(f, { maxFirstRead: 1000, maxRead: 300 });
  const got = [];
  for (let k = 0; k < 50; k++) got.push(...tail.read().lines);
  assert.ok(got.length > 5 && got.length < 30, `read ${got.length} lines`);
  assert.equal(got[got.length - 1].i, 199);
  for (let k = 1; k < got.length; k++) assert.equal(got[k].i, got[k - 1].i + 1);
  for (const o of got) assert.equal(o.pad, 'ü'.repeat(20));
});

test('parseMeta: fixture, defaults, junk', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS, 'subagents-meta', 'agent-ae0d14e7ad2db2bf5.meta.json'), 'utf8'));
  assert.deepEqual(T.parseMeta(meta), { type: 'general-purpose', description: 'Count files here', toolUseId: 'toolu_01PuLytW4FeEwpS7LGCzihRc', background: true, finished: true });
  assert.deepEqual(T.parseMeta({ agentType: 5 }), { type: '', description: '', toolUseId: '', background: false, finished: false });
  assert.equal(T.parseMeta(null), null);
  assert.equal(T.parseMeta([1]), null);
});
