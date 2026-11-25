#!/usr/bin/env node
'use strict';
// tests/fake-claude.js plus two test aids:
//   - appends its argv (JSON) to $CC_HOME/argv.log, so tests can check --resume / --session-id
//   - appends the core-related env vars it got to $CC_HOME/env.log
//   - a typed line "size" prints "SIZE <cols>x<rows>" (the terminal size it sees)
const fs = require('fs');
const path = require('path');

fs.appendFileSync(path.join(process.env.CC_HOME || '.', 'argv.log'), JSON.stringify(process.argv.slice(2)) + '\n');
const pick = (k) => (k in process.env ? process.env[k] : null);
fs.appendFileSync(path.join(process.env.CC_HOME || '.', 'env.log'), JSON.stringify({
  CC_AGENT_ID: pick('CC_AGENT_ID'), CC_CORE_URL: pick('CC_CORE_URL'), CC_TOKEN: pick('CC_TOKEN'),
  ELECTRON_RUN_AS_NODE: pick('ELECTRON_RUN_AS_NODE'), CLAUDECODE: pick('CLAUDECODE'),
}) + '\n');
process.stdin.on('data', (d) => {
  if (String(d).trim() === 'size') {
    const [cols, rows] = process.stdout.isTTY ? process.stdout.getWindowSize() : [0, 0];
    process.stdout.write(`SIZE ${cols}x${rows}\r\n`);
  }
});
require('../../fake-claude.js');
