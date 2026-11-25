#!/usr/bin/env node
'use strict';
// A claude stuck on a setup screen: ignores its arguments, never fires a hook, waits forever.
process.stdout.write('Do you trust the files in this folder?\r\n > 1. Yes, proceed\r\n   2. No, exit\r\n');
process.stdin.resume();
setInterval(() => {}, 1 << 30);
