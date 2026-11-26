#!/usr/bin/env node
// @ts-check
// Checks a packaged app produced by electron-builder (dist/win-unpacked, dist/linux-unpacked, ...).
//
//   node scripts/check-package.js [unpackedDir] [--no-probe]
//
// 1. Layout: app.asar holds package.json + the main entry; the core, the shared contract, ws and
//    node-pty (with its native binaries and Windows helpers) are in app.asar.unpacked.
// 2. Probes (unless --no-probe):
//    - PTY: runs the packaged exe as Node (ELECTRON_RUN_AS_NODE=1), loads node-pty from
//      app.asar.unpacked and runs a console program in a real PTY (ConPTY on Windows), as the
//      installed core does with claude.
//    - Hook: writes the hook launcher for the packaged exe (as the core does), runs it through the
//      shell like Claude Code runs hooks, with a JSON payload on stdin, and checks the payload
//      reaches a local HTTP server. On Windows the exe is a GUI-subsystem program started from a
//      .cmd file: this is the path every hook takes in the installed app.
// Exits 1 with a clear list of problems on failure.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const noProbe = args.includes('--no-probe');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function findUnpackedDir() {
  const given = args.find((a) => !a.startsWith('--'));
  if (given) return path.resolve(given);
  const dist = path.join(ROOT, 'dist');
  const candidates = ['win-unpacked', 'linux-unpacked', 'mac/CC-Dashboard.app/Contents', 'mac-arm64/CC-Dashboard.app/Contents'];
  for (const c of candidates) if (fs.existsSync(path.join(dist, c))) return path.join(dist, c);
  throw new Error(`no unpacked app found under ${dist} (build one with: npx electron-builder --dir --publish never)`);
}

function findExe(dir) {
  if (process.platform === 'win32') return path.join(dir, `${pkg.productName}.exe`);
  if (process.platform === 'darwin') return path.join(dir, 'MacOS', pkg.productName);
  return path.join(dir, pkg.name); // linux executableName defaults to the package name
}

const problems = [];
const ok = (msg) => console.log(`  ok   ${msg}`);
function expectFile(file, label) {
  if (fs.existsSync(file)) ok(label);
  else problems.push(`missing ${label}: ${file}`);
}

async function main() {
  const dir = findUnpackedDir();
  const resources = process.platform === 'darwin' ? path.join(dir, 'Resources') : path.join(dir, 'resources');
  const asarFile = path.join(resources, 'app.asar');
  const unpacked = path.join(resources, 'app.asar.unpacked');
  console.log(`Checking ${dir}`);

  const exe = findExe(dir);
  expectFile(exe, 'app executable');
  expectFile(asarFile, 'resources/app.asar');

  // asar contents
  if (fs.existsSync(asarFile)) {
    const asar = require('@electron/asar');
    const list = new Set(asar.listPackage(asarFile, { isPack: false }).map((p) => p.split(path.sep).join('/')));
    for (const f of ['/package.json', '/' + pkg.main.split(path.sep).join('/')]) {
      if (list.has(f)) ok(`app.asar contains ${f}`);
      else problems.push(`app.asar is missing ${f}`);
    }
    for (const dev of Object.keys(pkg.devDependencies || {})) {
      if (list.has(`/node_modules/${dev}`)) problems.push(`devDependency ${dev} was packaged`);
    }
  }

  // unpacked files the core needs from disk
  expectFile(path.join(unpacked, 'packages', 'shared', 'protocol.js'), 'unpacked packages/shared/protocol.js');
  if (fs.existsSync(path.join(ROOT, 'packages', 'core', 'src', 'index.js'))) {
    expectFile(path.join(unpacked, 'packages', 'core', 'src', 'index.js'), 'unpacked packages/core/src/index.js');
  } else {
    console.log('  skip packages/core/src/index.js (not in this checkout yet)');
  }
  // every core module (the core runs from disk, not from the asar): the M2 ones included
  const coreSrc = path.join(ROOT, 'packages', 'core', 'src');
  if (fs.existsSync(coreSrc)) {
    for (const f of fs.readdirSync(coreSrc).filter((n) => n.endsWith('.js'))) {
      expectFile(path.join(unpacked, 'packages', 'core', 'src', f), `unpacked packages/core/src/${f}`);
    }
  }
  const ptyDir = path.join(unpacked, 'node_modules', 'node-pty');
  expectFile(path.join(ptyDir, 'lib', 'index.js'), 'unpacked node-pty/lib/index.js');
  // node-pty loads its binaries from build/Release (compiled at install) or, failing that, from
  // prebuilds/<platform>-<arch> (shipped in the package; what Windows uses).
  const nativeDirs = [path.join(ptyDir, 'build', 'Release'), path.join(ptyDir, 'prebuilds', `${process.platform}-${process.arch}`)];
  const natives = process.platform === 'win32'
    ? ['conpty.node', 'conpty_console_list.node', 'winpty-agent.exe', 'winpty.dll']
    : ['pty.node'];
  for (const f of natives) {
    const found = nativeDirs.map((d) => path.join(d, f)).find((p) => fs.existsSync(p));
    if (found) ok(`unpacked node-pty ${path.relative(ptyDir, found)}`);
    else problems.push(`unpacked node-pty ${f} is missing (looked in build/Release and prebuilds/${process.platform}-${process.arch})`);
  }
  expectFile(path.join(unpacked, 'node_modules', 'ws', 'index.js'), 'unpacked ws');

  if (!noProbe && problems.length === 0) {
    probe(exe, unpacked);
    await probeHook(exe, unpacked);
  }

}

/** Runs the packaged exe as Node and spawns a child through node-pty loaded from app.asar.unpacked. */
function probe(exe, unpacked) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pkg-probe-'));
  const probeFile = path.join(tmp, 'probe.js');
  fs.writeFileSync(probeFile, `
    const path = require('path');
    const unpacked = ${JSON.stringify(unpacked)};
    const protocol = require(path.join(unpacked, 'packages', 'shared', 'protocol.js'));
    const pty = require(path.join(unpacked, 'node_modules', 'node-pty'));
    console.log('ELECTRON', process.versions.electron, 'ABI', process.versions.modules, 'PROTOCOL', protocol.PROTOCOL_VERSION);
    // A console program: the packaged exe is a GUI-subsystem program on Windows and gets no
    // console inside a PTY, so it can't be the child here (claude.exe is a console program).
    const [file, argv] = process.platform === 'win32'
      ? [process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo PTY_OK']]
      : [process.execPath, ['-e', 'console.log("PTY_" + "OK")']];
    const term = pty.spawn(file, argv, {
      cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
    });
    let out = '';
    term.onData((d) => { out += d; });
    const timer = setTimeout(() => { console.log('PTY_TIMEOUT', JSON.stringify(out)); process.exit(3); }, 20000);
    term.onExit(({ exitCode }) => {
      clearTimeout(timer);
      // ConPTY can deliver the last bytes just after exit; give it a moment.
      setTimeout(() => { console.log(out.includes('PTY_OK') ? 'PROBE_OK' : 'PROBE_NO_OUTPUT ' + JSON.stringify(out), 'exit', exitCode); process.exit(0); }, 300);
    });
  `);
  const res = spawnSync(exe, [probeFile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60000,
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  console.log(output.split(/\r?\n/).map((l) => `  probe> ${l}`).join('\n'));
  if (res.error) problems.push(`probe could not run ${exe}: ${res.error.message}`);
  else if (!/PROBE_OK/.test(output)) {
    const abi = /NODE_MODULE_VERSION/.test(output)
      ? ' (node-pty is not a Node-API build: it must be node-pty >= 1.1, see electron-builder.yml)'
      : '';
    problems.push(`node-pty probe under the packaged Electron failed${abi}`);
  } else ok('node-pty spawns a PTY inside the packaged app (ELECTRON_RUN_AS_NODE=1)');
  fs.rmSync(tmp, { recursive: true, force: true });
}

/**
 * Runs the packaged hook (hook.js from app.asar.unpacked, through the launcher the core writes,
 * started by the shell like Claude Code does) and checks the payload arrives.
 */
async function probeHook(exe, unpacked) {
  const { launcherText, launcherName } = require(path.join(ROOT, 'packages', 'core', 'src', 'hooks-settings.js'));
  const hookScript = path.join(unpacked, 'packages', 'core', 'src', 'hook.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pkg-hook-'));
  const launcher = path.join(tmp, launcherName());
  fs.writeFileSync(launcher, launcherText(exe, hookScript), { mode: 0o755 });
  /** @type {{event?: string, body?: string, agent?: string}} */
  let got = {};
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got = { event: String(req.headers['x-cc-event']), agent: new URL(req.url || '/', 'http://x').searchParams.get('agent') || '', body: Buffer.concat(chunks).toString('utf8') };
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  const port = /** @type {any} */ (server.address()).port;
  const payload = JSON.stringify({ session_id: 'probe', hook_event_name: 'Stop', note: 'ünïcode ✓' });
  const env = { ...process.env, CC_AGENT_ID: 'probe-agent', CC_CORE_URL: `http://127.0.0.1:${port}`, CC_TOKEN: 'probe-token' };
  delete env.ELECTRON_RUN_AS_NODE; // the launcher sets it, as for the real hooks
  const result = await new Promise((resolve) => {
    const child = spawn(`"${launcher}" Stop`, { shell: true, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: 'timeout', out }); }, 30000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 'error', out: e.message }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.stdin.end(payload);
  });
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (got.body === payload && got.event === 'Stop' && got.agent === 'probe-agent' && result.code === 0 && !result.out.trim()) {
    ok('hook launcher runs the packaged hook.js and delivers the payload (as Claude Code runs hooks)');
  } else {
    problems.push(`hook probe failed: exit ${result.code}, output ${JSON.stringify(result.out.slice(0, 300))}, received ${JSON.stringify(got)}`);
  }
}

main().then(() => {
  if (problems.length) {
    console.error(`\nPACKAGE CHECK FAILED (${problems.length} problem(s)):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nPackage check passed.');
}, (err) => {
  console.error('PACKAGE CHECK FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
