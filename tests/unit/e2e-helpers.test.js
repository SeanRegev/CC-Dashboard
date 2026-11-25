// @ts-check
'use strict';
// The e2e harness (tests/e2e/helpers.js) talks to the core through core.json, /health and the
// WebSocket RPC. These tests run its plumbing against a tiny in-process stand-in, so the harness
// is known-good before the real core and app exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const h = require('../e2e/helpers');

test('testEnv: temp CC_HOME, fake claude, GPU off, never ELECTRON_RUN_AS_NODE', () => {
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const env = h.testEnv({ ccHome: 'X', env: { EXTRA: 'y' } });
    assert.equal(env.CC_HOME, 'X');
    assert.equal(env.CC_DISABLE_GPU, '1');
    assert.equal(env.EXTRA, 'y');
    assert.match(env.CC_CLAUDE, /^node /);
    assert.ok(env.CC_CLAUDE.includes(h.FAKE_CLAUDE), env.CC_CLAUDE);
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  } finally {
    if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = saved;
  }
});

test('Playwright Electron driver resolves', () => {
  const electron = h.loadElectronDriver();
  assert.equal(typeof electron.launch, 'function');
});

/** Stand-in core: /health with token, RPC echo, one pushed event. */
async function standInCore(ccHome) {
  const token = 'test-token';
  const server = http.createServer((req, res) => {
    const ok = (req.url || '').startsWith('/health') && (req.url || '').includes(`token=${token}`);
    res.statusCode = ok ? 200 : 401;
    res.end(JSON.stringify(ok ? { ok: true, version: 't' } : { error: 'unauthorized' }));
  });
  const wss = new WebSocket.Server({ server });
  wss.on('connection', (ws, req) => {
    if (!(req.url || '').includes(`token=${token}`)) { ws.close(); return; }
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.method === 'boom') ws.send(JSON.stringify({ id: msg.id, error: { code: 'bad_request', message: 'nope' } }));
      else {
        ws.send(JSON.stringify({ id: msg.id, result: { echo: msg.params } }));
        ws.send(JSON.stringify({ event: 'agent.status', data: { agentId: 'a', state: 'idle' } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {import('net').AddressInfo} */ (server.address()).port;
  fs.writeFileSync(path.join(ccHome, 'core.json'), JSON.stringify({ port, token, pid: process.pid, version: 't' }));
  return { server, wss, port, token };
}

test('waitForCoreJson + connectRpc against a stand-in core', async (t) => {
  const ccHome = h.makeCcHome('cc-harness-');
  const core = await standInCore(ccHome);
  t.after(() => { core.wss.close(); core.server.close(); h.removeCcHome(ccHome); });

  const info = await h.waitForCoreJson(ccHome, { timeoutMs: 5000 });
  assert.equal(info.port, core.port);
  const rpc = await h.connectRpc(info);
  t.after(() => rpc.close());
  assert.deepEqual(await rpc.call('hello', { clientName: 'x' }), { echo: { clientName: 'x' } });
  await assert.rejects(rpc.call('boom'), /boom: bad_request: nope/);
  const status = await rpc.waitForEvent('agent.status', (s) => s.agentId === 'a', 3000);
  assert.equal(status.state, 'idle');
  await assert.rejects(rpc.waitForEvent('agent.exit', () => true, 300), /no agent.exit event/);
});

test('waitForCoreJson fails with a clear message when no core shows up', async (t) => {
  const ccHome = h.makeCcHome('cc-harness-');
  t.after(() => h.removeCcHome(ccHome));
  await assert.rejects(h.waitForCoreJson(ccHome, { timeoutMs: 300, logs: () => 'LOGS-HERE' }),
    (e) => /core not ready after 300 ms/.test(String(e)) && /LOGS-HERE/.test(String(e)));
});

test('missingPieces names what is missing (or nothing)', () => {
  const reason = h.missingPieces();
  const appThere = fs.existsSync(h.APP_MAIN);
  const coreThere = fs.existsSync(h.CORE_ENTRY);
  if (appThere && coreThere) assert.equal(reason, '');
  else assert.match(reason, /^e2e skipped: .*not in this checkout yet$/);
});
