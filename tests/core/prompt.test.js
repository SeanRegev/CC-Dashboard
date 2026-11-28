// @ts-check
'use strict';
// The permission prompt parser (packages/core/src/prompt.js) against screens of real Claude Code
// layouts (tests/fixtures/prompts/*.txt) and against screens it must refuse (bad-*.txt).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parsePrompt, classify } = require('../../packages/core/src/prompt');

const DIR = path.join(__dirname, '..', 'fixtures', 'prompts');
// .gitattributes keeps these LF; normalise anyway so a CRLF checkout can't change what the tests edit.
const screen = (/** @type {string} */ name) => fs.readFileSync(path.join(DIR, `${name}.txt`), 'utf8').replace(/\r\n/g, '\n');
const kinds = (/** @type {any} */ p) => p.options.map((/** @type {any} */ o) => `${o.key}:${o.kind}`);

test('Bash, 4 options (Claude Code 2.1): "don\'t ask again" is option 2, auto mode is allow_other', () => {
  const p = parsePrompt(screen('bash-4opt'));
  assert.ok(p);
  assert.equal(p.tool, 'Bash');
  assert.equal(p.detail, 'npm test 2>&1 | tail -80');
  assert.equal(p.question, 'Do you want to proceed?');
  assert.deepEqual(kinds(p), ['1:allow', '2:allow_always', '3:allow_other', '4:deny']);
  assert.equal(p.options[1].label, "Yes, and don't ask again for: npm test *");
  assert.equal(p.options[2].label, 'Yes, and switch to auto mode · auto mode handles these prompts for you');
  assert.match(p.id, /^p-[0-9a-f]{24}$/);
});

test('Bash, 3 options: no allow_always at all, the tip that wrapped is not the command', () => {
  const p = parsePrompt(screen('bash-3opt'));
  assert.ok(p);
  assert.equal(p.tool, 'Bash');
  assert.equal(p.detail, 'ls -la && git log --oneline -5 && (cat README.md 2>/dev/null | head -60)');
  assert.deepEqual(kinds(p), ['1:allow', '2:allow_other', '3:deny']);
});

test('Bash, wrapped command in a gutter and a wrapped "always allow access" option', () => {
  const p = parsePrompt(screen('bash-wrapped'));
  assert.ok(p);
  assert.equal(p.detail, "printf 'ok' > /home/user/claudeultimatedeck/cc_probe.txt && cat /home/user/claudeultimatedeck/cc_probe.txt");
  assert.deepEqual(kinds(p), ['1:allow', '2:allow_always', '3:allow_other', '4:deny']);
  assert.equal(p.options[1].label, 'Yes, and always allow access to /home/user/claudeultimatedeck from this project');
});

test('Edit and Create file prompts: the file is the detail, "allow all edits during this session" is allow_always', () => {
  const e = parsePrompt(screen('edit'));
  assert.ok(e);
  assert.equal(e.tool, 'Edit');
  assert.equal(e.detail, 'src/app.js');
  assert.equal(e.question, 'Do you want to make this edit to app.js?');
  assert.deepEqual(kinds(e), ['1:allow', '2:allow_always', '3:deny']);
  const c = parsePrompt(screen('create'));
  assert.ok(c);
  assert.equal(c.tool, 'Write');
  assert.equal(c.detail, 'notes/todo.md');
  assert.deepEqual(kinds(c), ['1:allow', '2:allow_always', '3:deny']);
});

test('WebFetch: the URL is the detail', () => {
  const p = parsePrompt(screen('fetch'));
  assert.ok(p);
  assert.equal(p.tool, 'WebFetch');
  assert.equal(p.detail, 'https://docs.example.com/api/v2');
  assert.deepEqual(kinds(p), ['1:allow', '2:allow_always', '3:deny']);
});

test('MCP tool: mcp__server__tool and its arguments', () => {
  const p = parsePrompt(screen('mcp'));
  assert.ok(p);
  assert.equal(p.tool, 'mcp__github__create_issue');
  assert.equal(p.detail, 'owner: "acme", repo: "app", title: "Login fails on Safari"');
  assert.deepEqual(kinds(p), ['1:allow', '2:allow_always', '3:deny']);
});

test('older boxed layout (side borders, no rules)', () => {
  const p = parsePrompt(screen('boxed-legacy'));
  assert.ok(p);
  assert.equal(p.tool, 'Bash');
  assert.equal(p.detail, 'npm install jsonwebtoken@9');
  assert.deepEqual(kinds(p), ['1:allow', '2:allow_always', '3:deny']);
});

for (const name of fs.readdirSync(DIR).filter((f) => f.startsWith('bad-')).map((f) => f.replace(/\.txt$/, ''))) {
  test(`refused (null): ${name}`, () => {
    assert.equal(parsePrompt(screen(name)), null);
  });
}

test('refused: empty, non-string, a screen without a prompt, a prompt with text typed below it', () => {
  assert.equal(parsePrompt(''), null);
  assert.equal(parsePrompt(/** @type {any} */ (null)), null);
  assert.equal(parsePrompt('> hello\n● Done.\n\n> '), null);
  // Something drawn under the options that is neither a footer nor a short status line.
  const s = screen('bash-4opt').replace(' Esc to cancel · Tab to amend', ' line one\n line two\n line three');
  assert.equal(parsePrompt(s), null);
  // An input line under the options means the dialog is not the active screen.
  assert.equal(parsePrompt(screen('bash-4opt').replace(' Esc to cancel · Tab to amend', '> ')), null);
  // More than 9 options cannot be answered with one key.
  const many = ['Bash command', '──────', 'x', '──────', 'Do you want to proceed?', '1. Yes',
    ...Array.from({ length: 8 }, (_, i) => `${i + 2}. Yes, and switch to mode ${i}`), '10. No'].join('\n');
  assert.equal(parsePrompt(many), null);
});

test('fingerprint: stable for the same prompt, whatever else is on screen', () => {
  const base = parsePrompt(screen('bash-4opt'));
  assert.ok(base);
  assert.equal(parsePrompt(screen('bash-4opt'))?.id, base.id);
  // the user moved the cursor in the terminal: we press digits, so the prompt is the same
  const moved = screen('bash-4opt').replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes, and', ' ❯ 2. Yes, and');
  assert.equal(parsePrompt(moved)?.id, base.id);
  // transcript above, footer below, trailing spaces, CRLF: not part of the prompt
  assert.equal(parsePrompt(screen('bash-4opt').replace('Run the tests in weather-cli', 'something else'))?.id, base.id);
  assert.equal(parsePrompt(screen('bash-4opt').replace('Esc to cancel · Tab to amend', 'Esc to cancel'))?.id, base.id);
  assert.equal(parsePrompt(screen('bash-4opt').split('\n').map((l) => `${l}   `).join('\r\n'))?.id, base.id);
});

test('fingerprint: changes with the command, the tool, the options, the wording, and the salt', () => {
  const base = /** @type {any} */ (parsePrompt(screen('bash-4opt')));
  const ids = new Set([base.id]);
  const variants = [
    screen('bash-4opt').replace('npm test 2>&1 | tail -80', 'npm test 2>&1 | tail -81'),
    screen('bash-4opt').replace("don't ask again for: npm test *", "don't ask again for: npm *"),
    screen('bash-4opt').replace('   3. Yes, and switch to auto mode · auto mode handles these prompts for you\n   4. No', '   3. No'),
    screen('bash-4opt').replace('This command requires approval', 'This command uses shell operators that require approval for safety'),
  ];
  for (const v of variants) {
    const p = parsePrompt(v);
    assert.ok(p, v);
    assert.ok(!ids.has(p.id), `same id for a different prompt:\n${v}`);
    ids.add(p.id);
  }
  for (const name of ['bash-3opt', 'bash-wrapped', 'edit', 'create', 'fetch', 'mcp', 'boxed-legacy']) {
    const p = /** @type {any} */ (parsePrompt(screen(name)));
    assert.ok(!ids.has(p.id), name);
    ids.add(p.id);
  }
  assert.notEqual(parsePrompt(screen('bash-4opt'), { salt: 'a:1' })?.id, parsePrompt(screen('bash-4opt'), { salt: 'a:2' })?.id);
  assert.notEqual(parsePrompt(screen('bash-4opt'), { salt: 'a:1' })?.id, parsePrompt(screen('bash-4opt'), { salt: 'b:1' })?.id);
  assert.equal(parsePrompt(screen('bash-4opt'), { salt: 'a:1' })?.id, parsePrompt(screen('bash-4opt'), { salt: 'a:1' })?.id);
});

test('classify by wording, never by position', () => {
  /** @type {Array<[string, string]>} */
  const cases = [
    ['Yes', 'allow'], ['yes', 'allow'], ['Yes.', 'allow'], ['Yes (y)', 'allow'],
    ["Yes, and don't ask again for: npm test *", 'allow_always'],
    ['Yes, and don’t ask again for this command in /x', 'allow_always'],
    ['Yes, allow all edits during this session (shift+tab)', 'allow_always'],
    ['Yes, and always allow access to /home/u/p from this project', 'allow_always'],
    ['No', 'deny'], ['No, and tell Claude what to do differently (esc)', 'deny'], ['No (esc)', 'deny'],
    ['Yes, and switch to auto mode · auto mode handles these prompts for you', 'allow_other'],
    ['Yes, and auto-accept edits', 'allow_other'],
    ['Yes, proceed', 'allow_other'], ['Yesterday', 'allow_other'], ['Nope', 'allow_other'], ['Exponential backoff', 'allow_other'],
  ];
  for (const [label, kind] of cases) assert.equal(classify(label), kind, label);
});

test('a scrolled prompt: "↑ N more lines" under the options still parses; with the tool header scrolled off it is refused', () => {
  const full = screen('bash-4opt');
  const scrolled = full.replace(' Esc to cancel · Tab to amend', ' ↑ 7 more lines\n Esc to cancel · Tab to amend');
  assert.notEqual(scrolled, full);
  const p = parsePrompt(scrolled);
  assert.ok(p);
  assert.deepEqual(kinds(p), ['1:allow', '2:allow_always', '3:allow_other', '4:deny']);
  // A short grid tile: the "Bash command" header is no longer on screen. The parser won't guess the tool.
  const lines = scrolled.split('\n');
  const header = lines.findIndex((l) => /^\s*Bash command\s*$/.test(l));
  assert.ok(header >= 0);
  assert.equal(parsePrompt(lines.slice(header + 1).join('\n')), null);
});

test('header scrolled off: the hook payload supplies tool and detail, but only when the question fits the tool', () => {
  const fb = { tool: 'Bash', detail: 'npm test' };
  const p = parsePrompt(screen('bash-headerless'), { fallback: fb });
  assert.ok(p);
  assert.equal(p.tool, 'Bash');
  assert.equal(p.detail, 'npm test');
  assert.deepEqual(kinds(p), ['1:allow', '2:allow_always', '3:deny']);
  // No hook payload: still refused.
  assert.equal(parsePrompt(screen('bash-headerless')), null);
  // A different tool on the hook: the question must be that tool's own question.
  assert.equal(parsePrompt(screen('bash-headerless'), { fallback: { tool: 'Edit', detail: 'a.js' } }), null);
  assert.equal(parsePrompt(screen('bash-headerless'), { fallback: { tool: 'Bash', detail: '' } }), null);
  const e = parsePrompt(screen('edit-headerless'), { fallback: { tool: 'Edit', detail: 'src/app.js' } });
  assert.ok(e);
  assert.equal(e.tool, 'Edit');
  assert.equal(e.question, 'Do you want to make this edit to app.js?');
  assert.equal(parsePrompt(screen('edit-headerless'), { fallback: fb }), null);
  // MCP tools ask "Do you want to proceed?".
  const m = parsePrompt(screen('bash-headerless'), { fallback: { tool: 'mcp__github__create_issue', detail: 'x' } });
  assert.ok(m);
  assert.equal(m.tool, 'mcp__github__create_issue');
});

test('header scrolled off: the fingerprint changes with the hook payload, the options and the salt; a visible header wins', () => {
  const a = parsePrompt(screen('bash-headerless'), { fallback: { tool: 'Bash', detail: 'npm test' }, salt: 's' });
  const b = parsePrompt(screen('bash-headerless'), { fallback: { tool: 'Bash', detail: 'rm -rf x' }, salt: 's' });
  const c = parsePrompt(screen('bash-headerless'), { fallback: { tool: 'Bash', detail: 'npm test' }, salt: 't' });
  const d = parsePrompt(screen('bash-headerless').replace('npm test *', 'npm run *'), { fallback: { tool: 'Bash', detail: 'npm test' }, salt: 's' });
  assert.ok(a && b && c && d);
  assert.equal(new Set([a.id, b.id, c.id, d.id]).size, 4);
  assert.equal(parsePrompt(screen('bash-headerless'), { fallback: { tool: 'Bash', detail: 'npm test' }, salt: 's' }).id, a.id);
  // The real header on screen is used, not the hook.
  const full = parsePrompt(screen('bash-4opt'), { fallback: { tool: 'Edit', detail: 'ignored' } });
  assert.ok(full);
  assert.equal(full.tool, 'Bash');
  assert.equal(full.detail, 'npm test 2>&1 | tail -80');
});
