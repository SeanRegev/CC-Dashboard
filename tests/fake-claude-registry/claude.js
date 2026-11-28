#!/usr/bin/env node
// Stand-in for a Claude Code session started OUTSIDE CC-Dashboard (tests of the outside sessions).
// It stays alive and writes its running-session file <CLAUDE_CONFIG_DIR>/sessions/<pid>.json like
// real Claude does (sample: tests/fixtures/sessions/registry-sample.json). It is named claude.js,
// so the core's process check accepts it (the script name counts, "claude" elsewhere in the path does not).
//
//   node tests/fake-claude-registry/claude.js --session <id> --cwd <dir> [--status busy|idle|...] [--name <n>]
//        [--entrypoint cli|vscode|...] [--ignore-term] [--keep-file] [--proc-start <s>]
//
// Refuses to run without CLAUDE_CONFIG_DIR (tests must never touch the real ~/.claude).
// Prints "READY <pid>" once the file is written. Lines on stdin: "status <value>" rewrites the file.
// SIGTERM: removes the file and exits (with --ignore-term: ignored; --keep-file: leaves the file).
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2);
const get = (flag, def = '') => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const has = (flag) => args.includes(flag);

const configDir = process.env.CLAUDE_CONFIG_DIR;
if (!configDir) {
  process.stderr.write('fake-claude-registry: CLAUDE_CONFIG_DIR must be set\n');
  process.exit(2);
}
const dir = path.join(configDir, 'sessions');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${process.pid}.json`);

function procStart() {
  if (has('--proc-start')) return get('--proc-start');
  if (process.platform !== 'linux') return '0';
  try {
    const t = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    return t.slice(t.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return '0'; }
}

const started = Date.now();
const reg = {
  pid: process.pid,
  sessionId: get('--session', '00000000-0000-4000-8000-0000000000aa'),
  cwd: get('--cwd', process.cwd()),
  startedAt: started,
  procStart: procStart(),
  version: '2.1.332',
  peerProtocol: 1,
  kind: 'interactive',
  entrypoint: get('--entrypoint', 'cli'),
  name: get('--name', ''),
  nameSource: 'derived',
  updatedAt: started,
  status: get('--status', 'idle'),
  statusUpdatedAt: started,
};
if (!reg.name) delete reg.name;

function write() {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg));
  fs.renameSync(tmp, file);
}
write();

process.on('SIGTERM', () => {
  if (has('--ignore-term')) return;
  if (!has('--keep-file')) try { fs.unlinkSync(file); } catch { /* gone */ }
  process.exit(0);
});

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = /^status (\S+)/.exec(line.trim());
  if (!m) return;
  reg.status = m[1];
  reg.updatedAt = reg.statusUpdatedAt = Date.now();
  write();
  process.stdout.write(`STATUS ${m[1]}\n`);
});

setInterval(() => {}, 60_000);
process.stdout.write(`READY ${process.pid}\n`);
