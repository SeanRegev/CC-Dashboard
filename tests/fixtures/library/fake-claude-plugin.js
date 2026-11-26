#!/usr/bin/env node
// Stand-in for `claude plugin ...` in the Library tests. State lives in the JSON file FAKE_PLUGIN_STATE:
//   { plugins: [...list entries], available: [...], marketplaces: [...], needsCommand: { id: sha256 }, config: { id: {...} } }
// Every call is appended to FAKE_PLUGIN_LOG as one JSON line { argv, stdin }.
'use strict';
const fs = require('fs');

const argv = process.argv.slice(2);
const stateFile = process.env.FAKE_PLUGIN_STATE;
const state = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
state.plugins = state.plugins || [];
state.available = state.available || [];
state.marketplaces = state.marketplaces || [];
state.config = state.config || {};
const save = () => stateFile && fs.writeFileSync(stateFile, JSON.stringify(state));
const out = (v) => process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

let stdin = '';
const finish = () => {
  if (process.env.FAKE_PLUGIN_LOG) fs.appendFileSync(process.env.FAKE_PLUGIN_LOG, `${JSON.stringify({ argv, stdin })}\n`);
  main();
};
if (argv.includes('--values-stdin')) { process.stdin.on('data', (d) => { stdin += d; }); process.stdin.on('end', finish); } else finish();

function main() {
  if (argv[0] !== 'plugin') { console.error('fake claude: not a plugin command'); process.exit(2); }
  const [, cmd, a, b] = argv;
  const json = argv.includes('--json');
  const find = (id) => state.plugins.find((p) => p.id === id);
  if (cmd === 'list') {
    if (argv.includes('--available')) return out({ installed: state.plugins, available: state.available });
    return out(state.plugins);
  }
  if (cmd === 'marketplace') {
    if (a === 'list') return out(state.marketplaces);
    if (a === 'add') { state.marketplaces.push({ name: String(b).split('/').pop(), source: 'github', repo: b }); save(); return out(`Added marketplace ${b}`); }
    if (a === 'remove') { state.marketplaces = state.marketplaces.filter((m) => m.name !== b); save(); return out(`Removed ${b}`); }
    if (a === 'update') return out('Updated');
  }
  if (cmd === 'details') {
    if (!find(a)) { console.error(`Plugin "${a}" not found.`); process.exit(1); }
    return out(`${a}\n\nProjected token cost\n  Always-on:   ~${state.tokens && state.tokens[a] || 873} tok   added to every session\n`);
  }
  if (cmd === 'configure') {
    if (argv.includes('--values-stdin')) { state.config[a] = { ...(state.config[a] || {}), ...JSON.parse(stdin) }; save(); return out('saved'); }
    return out({ pluginId: a, schema: { token: { title: 'Access token', type: 'string', description: 'API token' }, region: { type: 'string', default: 'eu', enum: ['eu', 'us'] } }, inputs: state.config[a] || {}, choices: {}, configured: [], unconfigured: [] });
  }
  if (cmd === 'install' || cmd === 'update') {
    const sha = state.needsCommand && state.needsCommand[a];
    if (sha && flag('--accept-command') !== sha) { out({ ok: false, shownCommand: { command: 'npx some-installer --yes', sha256: sha } }); process.exit(1); }
    if (cmd === 'install' && !find(a)) state.plugins.push({ id: a, version: '1.0.0', scope: 'user', enabled: true });
    if (cmd === 'update' && !find(a)) { out({ ok: false, error: `not installed: ${a}` }); process.exit(1); }
    save();
    return json ? out({ ok: true, message: `${cmd} ${a}: ok` }) : out('ok');
  }
  if (cmd === 'uninstall' || cmd === 'enable' || cmd === 'disable') {
    const p = find(a);
    if (!p) { out({ ok: false, error: `Plugin "${a}" not found` }); process.exit(1); }
    if (cmd === 'uninstall') state.plugins = state.plugins.filter((x) => x !== p); else p.enabled = cmd === 'enable';
    save();
    return out({ ok: true, message: `${cmd} ${a}: ok` });
  }
  console.error(`fake claude: unknown command ${cmd}`);
  process.exit(2);
}
