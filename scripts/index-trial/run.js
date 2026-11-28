#!/usr/bin/env node
// @ts-check
'use strict';
/**
 * Indexer trial: run ONE real headless Claude task (costs tokens; see docs/INDEXER.md for the budget).
 *
 *   node scripts/index-trial/run.js --task 1 --arm none|codegraph|codeindex --repo <dir> --mcp <config.json> --out <file.jsonl>
 *
 * Every run: --model haiku, stream-json, no session saved, only project/local settings (no user hooks or plugins),
 * only the MCP servers in --mcp (--strict-mcp-config), read-only tools, a $0.50 cap. Then prints the measure.js row.
 */
const fs = require('fs');
const { spawn } = require('child_process');
const { measureFile, table } = require('./measure');

const SUFFIX = ' Do not edit files. Be concise. Give file:line references.';
/** The three trial tasks (docs/INDEXER.md). */
const TASKS = {
  1: 'In this repository, where is the function `wrapThenable` defined, and which functions call it (outside tests)? ' +
     'Give file:line for the definition and for each call site, and name the calling function.',
  2: 'Explain the flow in this repository from an incoming HTTP request reaching Fastify to the user\'s route handler ' +
     'being called. List the functions in the order they run, each with its file, and say where the onRequest, ' +
     'preParsing, preValidation and preHandler hooks run.',
  3: 'Find every place in lib/ and fastify.js that reads or writes `kReplySerializerDefault` (not counting import ' +
     'lines). List each as file:line with one short phrase saying what it does there.',
};
/** Index arms may use their server's tools; everyone may Read, Grep and Glob. */
const ALLOW = {
  none: ['Read', 'Grep', 'Glob'],
  codegraph: ['Read', 'Grep', 'Glob', 'mcp__trial-codegraph'],
  codeindex: ['Read', 'Grep', 'Glob', 'mcp__trial-codeindex'],
};
const DENY = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task'];

/** @param {string} name */
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const task = /** @type {'1'|'2'|'3'} */ (arg('task') || '');
  const arm = /** @type {'none'|'codegraph'|'codeindex'} */ (arg('arm') || '');
  const repo = arg('repo'), mcp = arg('mcp'), out = arg('out');
  if (!TASKS[task] || !ALLOW[arm] || !repo || !mcp || !out) {
    process.stderr.write('usage: run.js --task 1|2|3 --arm none|codegraph|codeindex --repo <dir> --mcp <json> --out <jsonl>\n');
    process.exit(2);
  }
  let prompt = TASKS[task] + SUFFIX;
  if (arm !== 'none') prompt += ' A code index MCP server is available; use it where it helps.';
  const args = ['-p', prompt, '--model', 'haiku', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', mcp,
    '--allowedTools', ...ALLOW[arm], '--disallowedTools', ...DENY, '--max-budget-usd', '0.50'];
  const bin = process.env.CC_CLAUDE || 'claude';
  // Explicit env: drop the parent session's markers and any inherited API key, so the run is a plain top-level
  // claude on the user's own CLI login (an inherited key can be stale: the first trial run got a 401).
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT') continue;
    if (k === 'ANTHROPIC_API_KEY' && !process.env.INDEX_TRIAL_KEEP_KEY) continue;
    env[k] = v;
  }
  const file = fs.openSync(out, 'w');
  const child = spawn(bin, args, { cwd: repo, env, stdio: ['ignore', file, 'inherit'], windowsHide: true });
  const timer = setTimeout(() => { process.stderr.write('timeout: killing run\n'); child.kill(); }, 10 * 60 * 1000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    fs.closeSync(file);
    const tasks = measureFile(out);
    tasks.forEach((t) => { t.label = `T${task}/${arm}`; });
    process.stdout.write(table(tasks) + `\nexit ${code}\n`);
  });
}

if (require.main === module) main();
module.exports = { TASKS, ALLOW, DENY };
