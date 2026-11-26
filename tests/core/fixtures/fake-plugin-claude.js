#!/usr/bin/env node
// `claude plugin list --json` for tests: prints the JSON file named by CC_FAKE_PLUGINS.
'use strict';
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === 'plugin' && a[1] === 'list') {
  process.stdout.write(fs.readFileSync(process.env.CC_FAKE_PLUGINS, 'utf8'));
} else {
  process.exit(2);
}
