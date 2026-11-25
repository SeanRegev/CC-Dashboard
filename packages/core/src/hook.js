#!/usr/bin/env node
// @ts-check
'use strict';
/**
 * Claude Code runs this for every hook event: `node hook.js <EventName>`, payload JSON on stdin.
 * It forwards the payload to the core (POST /hook?agent=<CC_AGENT_ID>).
 *
 * Rules: print NOTHING to stdout (for some events stdout becomes context for Claude), never fail
 * (always exit 0), and be quick: give up after ~2 s even if the core is down or hangs.
 * Kept dependency-free so it starts fast.
 */
const http = require('http');

const DEADLINE_MS = 1800;
const done = () => process.exit(0);
setTimeout(done, DEADLINE_MS);

const event = process.argv[2] || '';
const agent = process.env.CC_AGENT_ID;
const base = process.env.CC_CORE_URL;
const token = process.env.CC_TOKEN || '';

if (!agent || !base || !event) done(); // a claude not started by the core: nothing to do
else if (process.stdin.isTTY) post('');
else {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => post(Buffer.concat(chunks).toString('utf8')));
  process.stdin.on('error', () => post(Buffer.concat(chunks).toString('utf8')));
}

/** @param {string} body */
function post(body) {
  try {
    const url = new URL(`/hook?agent=${encodeURIComponent(agent || '')}`, base);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-cc-event': event,
        'x-cc-token': token,
      },
      timeout: DEADLINE_MS,
    }, (res) => { res.resume(); res.on('end', done); res.on('error', done); });
    req.on('error', done);
    req.on('timeout', () => { req.destroy(); done(); });
    req.end(body);
  } catch {
    done();
  }
}
