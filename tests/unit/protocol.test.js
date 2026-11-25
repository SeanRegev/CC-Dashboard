// @ts-check
'use strict';
// The core <-> app contract (packages/shared/protocol.js) must be self-consistent: the method and
// event lists the code exports must match the documentation comment both sides are built from.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROTOCOL_FILE = path.join(__dirname, '..', '..', 'packages', 'shared', 'protocol.js');
const protocol = require(PROTOCOL_FILE);
const source = fs.readFileSync(PROTOCOL_FILE, 'utf8');

/** Lines of the big "RPC methods" comment, split into the methods part and the events part. */
function documented() {
  const start = source.indexOf('RPC methods.');
  const eventsAt = source.indexOf('Events (core → app):', start);
  const end = source.indexOf('*/', eventsAt);
  assert.ok(start > 0 && eventsAt > start && end > eventsAt, 'protocol.js has the RPC methods / Events comment block');
  const names = (block) => block.split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .map((l) => /^([a-z]+(?:\.[a-zA-Z]+)?)\s{2,}/.exec(l))
    .filter(Boolean)
    .map((m) => /** @type {RegExpExecArray} */ (m)[1]);
  return { methods: names(source.slice(start, eventsAt)), events: names(source.slice(eventsAt, end)) };
}

function assertUnique(list, label) {
  const seen = new Set();
  for (const x of list) {
    assert.ok(!seen.has(x), `${label}: "${x}" is listed twice`);
    seen.add(x);
  }
}

test('exports the expected shape', () => {
  assert.equal(typeof protocol.PROTOCOL_VERSION, 'number');
  for (const key of ['STATES', 'HOOK_EVENTS', 'METHODS', 'EVENTS']) {
    assert.ok(Array.isArray(protocol[key]) && protocol[key].length > 0, `${key} is a non-empty array`);
    assert.ok(Object.isFrozen(protocol[key]), `${key} is frozen`);
  }
  assert.ok(Object.isFrozen(protocol.ERRORS), 'ERRORS is frozen');
  assert.equal(typeof protocol.homeDir, 'function');
});

test('methods, events, states, hook events and error codes are unique', () => {
  assertUnique(protocol.METHODS, 'METHODS');
  assertUnique(protocol.EVENTS, 'EVENTS');
  assertUnique(protocol.STATES, 'STATES');
  assertUnique(protocol.HOOK_EVENTS, 'HOOK_EVENTS');
  assertUnique(Object.values(protocol.ERRORS), 'ERRORS values');
});

test('every documented method is in METHODS and vice versa', () => {
  const { methods } = documented();
  assert.ok(methods.length > 0, 'found documented methods');
  assertUnique(methods, 'documented methods');
  assert.deepEqual([...methods].sort(), [...protocol.METHODS].sort());
});

test('every documented event is in EVENTS and vice versa', () => {
  const { events } = documented();
  assert.ok(events.length > 0, 'found documented events');
  assertUnique(events, 'documented events');
  assert.deepEqual([...events].sort(), [...protocol.EVENTS].sort());
});

test('AgentStatus state union matches STATES', () => {
  const m = /@property \{([^}]*)\} state/.exec(source);
  assert.ok(m, 'AgentStatus.state is documented');
  const union = m[1].split('|').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual([...union].sort(), [...protocol.STATES].sort());
});

test('homeDir respects CC_HOME and defaults to ~/.cc-dashboard', () => {
  const saved = process.env.CC_HOME;
  try {
    const custom = path.join(os.tmpdir(), 'cc-home-protocol-test');
    process.env.CC_HOME = custom;
    assert.equal(protocol.homeDir(), custom);
    delete process.env.CC_HOME;
    assert.equal(protocol.homeDir(), path.join(os.homedir(), '.cc-dashboard'));
  } finally {
    if (saved === undefined) delete process.env.CC_HOME; else process.env.CC_HOME = saved;
  }
});
